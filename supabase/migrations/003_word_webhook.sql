-- Configure the two referenced Vault secrets separately; no secret in source.
begin;
create extension if not exists pg_net with schema extensions;
create function public.notify_word_worker() returns trigger language plpgsql security definer set search_path='' as $$
declare endpoint text; token text;
begin
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='moments_word_sync_url';
  select decrypted_secret into token from vault.decrypted_secrets where name='moments_word_sync_secret';
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
revoke all on function public.notify_word_worker() from public,anon,authenticated;
create trigger word_outbox_notify after insert on public.word_sync_events
for each row execute function public.notify_word_worker();
commit;
