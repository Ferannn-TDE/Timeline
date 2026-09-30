-- Run after migration 002. All rows and outbox fixtures are rolled back.
begin;
insert into public.docs_connections(id,document_id,document_url,document_name,refresh_token_encrypted,connected_by,inspection)
values('11111111-1111-4111-8111-111111111111','test-document','https://example.invalid','Temporary Google Doc','NOT-A-TOKEN','feranmidyro@gmail.com','{"region":false}');
insert into public.entries(id,photo_date,caption,image_key,author_email)
values('22222222-2222-4222-8222-222222222222','2000-01-01','Temporary transaction','__docs_sql_test__','feranmidyro@gmail.com');
update public.entries set caption='Edited' where id='22222222-2222-4222-8222-222222222222';
delete from public.entries where id='22222222-2222-4222-8222-222222222222';
do $$ begin
  if (select count(*) from public.docs_sync_events where entry_id='22222222-2222-4222-8222-222222222222')<>3 then raise exception 'Outbox missed a mutation'; end if;
  if not exists(select 1 from public.docs_sync_events where entry_id='22222222-2222-4222-8222-222222222222' and operation='delete' and snapshot->>'caption'='Edited') then raise exception 'Delete snapshot missing'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","email":"feranmidyro@gmail.com"}',true);
do $$ begin
  begin perform refresh_token_encrypted from public.docs_connections; raise exception 'Browser can read Microsoft token'; exception when insufficient_privilege then null; end;
  begin perform seq from public.docs_sync_events; raise exception 'Browser can read outbox'; exception when insufficient_privilege then null; end;
  begin perform public.acquire_docs_lease('33333333-3333-4333-8333-333333333333'); raise exception 'Browser can acquire lease'; exception when insufficient_privilege then null; end;
end $$;
set local role service_role;
do $$ declare seqs bigint[]; begin
  if not public.acquire_docs_lease('33333333-3333-4333-8333-333333333333') then raise exception 'Server lease denied'; end if;
  if public.acquire_docs_lease('44444444-4444-4444-8444-444444444444') then raise exception 'Concurrent lease acquired'; end if;
  select array_agg(seq) into seqs from public.docs_sync_events where entry_id='22222222-2222-4222-8222-222222222222';
  insert into public.docs_sync_intents(id,connection_id,expected_revision,plan,baseline_after,conflicts,event_seqs,region_exists)
  values('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','test-revision','{"changed":false}','[{"entry_id":"22222222-2222-4222-8222-222222222222","website":null,"block_hash":null}]','[]',seqs,false);
  begin perform public.commit_docs_intent('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444'); raise exception 'Wrong owner committed'; exception when raise_exception then if SQLERRM='Wrong owner committed' then raise; end if; end;
  perform public.commit_docs_intent('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333');
  perform public.commit_docs_intent('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333');
  if exists(select 1 from public.docs_sync_events where seq=any(seqs) and status<>'synced') then raise exception 'Intent did not commit events'; end if;
  if not exists(select 1 from public.docs_sync_baselines where entry_id='22222222-2222-4222-8222-222222222222' and website is null and block_hash is null) then raise exception 'Tombstone not committed'; end if;
  perform public.release_docs_lease('44444444-4444-4444-8444-444444444444');
  if not exists(select 1 from public.docs_connections where lease_owner='33333333-3333-4333-8333-333333333333') then raise exception 'Wrong owner released lease'; end if;
  perform public.release_docs_lease('33333333-3333-4333-8333-333333333333');
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","email":"someone@example.com","app_metadata":{"provider":"google"}}',true);
do $$ begin
  if public.is_journal_member() then raise exception 'Unapproved Google identity is a member'; end if;
  if (select count(*) from public.entries)<>0 then raise exception 'Unapproved Google identity reads journal'; end if;
  if (select count(*) from storage.objects where bucket_id in ('photo-journal','docs-images','docs-recovery'))<>0 then raise exception 'Unapproved Google identity reads private storage'; end if;
end $$;
rollback;
select 'PASS: durable insert/edit/delete outbox, private tokens/outbox, exclusive lease, owner fencing, atomic/idempotent intent commit; fixtures rolled back' as result;
