-- Adds a durable outbox without changing or deleting journal entries/photos.
begin;
-- The earlier Word migration is already applied. Switch only its journal trigger.
drop trigger if exists entries_word_outbox on public.entries;
drop trigger if exists word_outbox_notify on public.word_sync_events;
create table public.docs_connections (
  id uuid primary key,
  document_id text not null, document_url text not null, tab_id text,
  document_name text not null, refresh_token_encrypted text not null,
  connected_by text not null, enabled boolean not null default false,
  inspected_at timestamptz, inspection jsonb not null default '{}'::jsonb,
  tested_at timestamptz, last_synced_at timestamptz,
  state text not null default 'document_selection_required', last_error text,
  lease_owner uuid, lease_until timestamptz, updated_at timestamptz not null default now(),
  singleton boolean not null default true unique check(singleton)
);
create table public.docs_sync_events (
  seq bigint generated always as identity primary key,
  entry_id uuid not null, snapshot jsonb, operation text not null check(operation in ('upsert','delete')),
  status text not null default 'pending' check(status in ('pending','syncing','synced','conflict','failed')),
  attempts integer not null default 0, error text,
  created_at timestamptz not null default now(), finished_at timestamptz
);
create index docs_events_pending on public.docs_sync_events(status,seq);
create index docs_events_entry on public.docs_sync_events(entry_id,seq desc);
create table public.docs_sync_baselines (
  entry_id uuid primary key, website jsonb, block_hash text, updated_at timestamptz not null default now()
);
create table public.docs_sync_conflicts (
  entry_id uuid primary key, reason text not null, website jsonb, document_text text not null,
  document_hash text, desired_hash text not null, resolution jsonb,
  created_at timestamptz not null default now()
);
create table public.docs_sync_intents (
  id uuid primary key, connection_id uuid not null references public.docs_connections(id),
  expected_revision text not null, applied_revision text, plan jsonb not null,
  baseline_after jsonb, conflicts jsonb not null, event_seqs bigint[] not null,
  region_exists boolean not null,
  state text not null default 'prepared' check(state in ('prepared','committed','abandoned')),
  created_at timestamptz not null default now(), committed_at timestamptz
);
create unique index docs_one_prepared_intent on public.docs_sync_intents(connection_id) where state='prepared';
create table public.docs_oauth_states (
  state_hash text primary key, cookie_hash text not null, verifier_encrypted text not null,
  user_id uuid not null, email text not null, expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.docs_connections enable row level security;
alter table public.docs_sync_events enable row level security;
alter table public.docs_sync_baselines enable row level security;
alter table public.docs_sync_conflicts enable row level security;
alter table public.docs_sync_intents enable row level security;
alter table public.docs_oauth_states enable row level security;
revoke all on public.docs_connections,public.docs_sync_events,public.docs_sync_baselines,
  public.docs_sync_conflicts,public.docs_sync_intents,public.docs_oauth_states from anon,authenticated;
revoke all on sequence public.docs_sync_events_seq_seq from anon,authenticated;
grant all on public.docs_connections,public.docs_sync_events,public.docs_sync_baselines,
  public.docs_sync_conflicts,public.docs_sync_intents,public.docs_oauth_states to service_role;
grant usage, select on sequence public.docs_sync_events_seq_seq to service_role;

create function public.enqueue_docs_sync() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if TG_OP='DELETE' then
    insert into public.docs_sync_events(entry_id,snapshot,operation) values(OLD.id,to_jsonb(OLD),'delete');
    return OLD;
  end if;
  if TG_OP='UPDATE' and NEW.photo_date=OLD.photo_date and NEW.caption=OLD.caption and NEW.image_key=OLD.image_key then return NEW; end if;
  insert into public.docs_sync_events(entry_id,snapshot,operation) values(NEW.id,to_jsonb(NEW),'upsert');
  return NEW;
end $$;
revoke all on function public.enqueue_docs_sync() from public,anon,authenticated;
create trigger entries_docs_outbox after insert or update or delete on public.entries
for each row execute function public.enqueue_docs_sync();
insert into public.docs_sync_events(entry_id,snapshot,operation)
select id,to_jsonb(e),'upsert' from public.entries e;

create function public.acquire_docs_lease(p_owner uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.docs_connections set lease_owner=p_owner, lease_until=now()+interval '2 minutes'
  where singleton and (lease_until is null or lease_until<now());
  return found;
end $$;
create function public.release_docs_lease(p_owner uuid) returns void language sql security definer set search_path='' as $$
  update public.docs_connections set lease_owner=null,lease_until=null where lease_owner=p_owner;
$$;
create function public.commit_docs_intent(p_id uuid,p_owner uuid) returns void language plpgsql security definer set search_path='' as $$
declare intent public.docs_sync_intents; b jsonb; c jsonb;
begin
  perform 1 from public.docs_connections where lease_owner=p_owner and lease_until>now() for update;
  if not found then raise exception 'Google Docs lease expired'; end if;
  select * into intent from public.docs_sync_intents where id=p_id for update;
  if intent.state='committed' then return; end if;
  if intent.id is null or intent.baseline_after is null or intent.state<>'prepared' then raise exception 'Google Docs intent missing or abandoned'; end if;
  if not exists(select 1 from public.docs_connections where id=intent.connection_id and lease_owner=p_owner) then raise exception 'Google Docs connection changed'; end if;
  for b in select * from jsonb_array_elements(intent.baseline_after) loop
    insert into public.docs_sync_baselines(entry_id,website,block_hash)
    values((b->>'entry_id')::uuid,nullif(b->'website','null'::jsonb),b->>'block_hash')
    on conflict(entry_id) do update set website=excluded.website,block_hash=excluded.block_hash,updated_at=now();
    delete from public.docs_sync_conflicts where entry_id=(b->>'entry_id')::uuid;
  end loop;
  for c in select * from jsonb_array_elements(intent.conflicts) loop
    insert into public.docs_sync_conflicts(entry_id,reason,website,document_text,document_hash,desired_hash)
    values((c->>'entry_id')::uuid,c->>'reason',nullif(c->'website','null'::jsonb),c->>'document_text',c->>'document_hash',c->>'desired_hash')
    on conflict(entry_id) do update set reason=excluded.reason,website=excluded.website,document_text=excluded.document_text,
      document_hash=excluded.document_hash,desired_hash=excluded.desired_hash,resolution=null;
  end loop;
  update public.docs_sync_events e set status=case when exists(select 1 from public.docs_sync_conflicts c where c.entry_id=e.entry_id) then 'conflict' else 'synced' end,
    error=null,finished_at=now() where seq=any(intent.event_seqs) or
      (e.status='conflict' and not exists(select 1 from public.docs_sync_conflicts c where c.entry_id=e.entry_id)
       and exists(select 1 from public.docs_sync_events processed where processed.seq=any(intent.event_seqs) and processed.entry_id=e.entry_id and processed.seq>=e.seq));
  update public.docs_sync_intents set state='committed',committed_at=now() where id=p_id;
  update public.docs_connections set last_synced_at=now(),last_error=null,
    inspection=jsonb_set(inspection,'{region}',to_jsonb(intent.region_exists)),
    state=case when exists(select 1 from public.docs_sync_conflicts) then 'conflict' else 'synced' end,
    updated_at=now() where id=intent.connection_id;
end $$;
revoke all on function public.acquire_docs_lease(uuid),public.release_docs_lease(uuid),public.commit_docs_intent(uuid,uuid) from public,anon,authenticated;
grant execute on function public.acquire_docs_lease(uuid),public.release_docs_lease(uuid),public.commit_docs_intent(uuid,uuid) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('docs-recovery','docs-recovery',false,25000000,array['application/json']),
      ('docs-images','docs-images',false,10000000,array['image/png'])
on conflict(id) do nothing;
-- No browser policies. Image insertion uses 10-minute server-issued signed URLs.
-- Configure the two referenced Vault secrets separately; no secret in source.

create extension if not exists pg_net with schema extensions;
create function public.notify_docs_worker() returns trigger language plpgsql security definer set search_path='' as $$
declare endpoint text; token text;
begin
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='moments_docs_sync_url';
  select decrypted_secret into token from vault.decrypted_secrets where name='moments_docs_sync_secret';
  if endpoint is not null and token is not null then
    begin
      perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Authorization','Bearer '||token,'Content-Type','application/json'),body:='{}'::jsonb,timeout_milliseconds:=60000);
    exception when others then
      -- The outbox is authoritative. A network enqueue failure must not abort
      -- the journal mutation; authenticated retry/poll and daily cron recover it.
      null;
    end;
  end if;
  return NEW;
end $$;
revoke all on function public.notify_docs_worker() from public,anon,authenticated;
create trigger docs_outbox_notify after insert on public.docs_sync_events
for each row execute function public.notify_docs_worker();

-- Retain old Microsoft state/data, but stop all Microsoft jobs. No external writes.
update public.word_connections set enabled=false;
commit;
