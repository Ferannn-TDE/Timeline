-- Run after migration 002. All rows and outbox fixtures are rolled back.
begin;
insert into public.word_connections(id,drive_id,item_id,document_url,document_name,refresh_token_encrypted,connected_by,inspection)
values('11111111-1111-4111-8111-111111111111','test-drive','test-item','https://example.invalid','temporary-test.docx','NOT-A-TOKEN','feranmidyro@gmail.com','{"region":false}');
insert into public.entries(id,photo_date,caption,image_key,author_email)
values('22222222-2222-4222-8222-222222222222','2000-01-01','Temporary transaction','__word_sql_test__','feranmidyro@gmail.com');
update public.entries set caption='Edited' where id='22222222-2222-4222-8222-222222222222';
delete from public.entries where id='22222222-2222-4222-8222-222222222222';
do $$ begin
  if (select count(*) from public.word_sync_events where entry_id='22222222-2222-4222-8222-222222222222')<>3 then raise exception 'Outbox missed a mutation'; end if;
  if not exists(select 1 from public.word_sync_events where entry_id='22222222-2222-4222-8222-222222222222' and operation='delete' and snapshot->>'caption'='Edited') then raise exception 'Delete snapshot missing'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","email":"feranmidyro@gmail.com"}',true);
do $$ begin
  begin perform refresh_token_encrypted from public.word_connections; raise exception 'Browser can read Microsoft token'; exception when insufficient_privilege then null; end;
  begin perform seq from public.word_sync_events; raise exception 'Browser can read outbox'; exception when insufficient_privilege then null; end;
  begin perform public.acquire_word_lease('33333333-3333-4333-8333-333333333333'); raise exception 'Browser can acquire lease'; exception when insufficient_privilege then null; end;
end $$;
set local role service_role;
do $$ declare seqs bigint[]; begin
  if not public.acquire_word_lease('33333333-3333-4333-8333-333333333333') then raise exception 'Server lease denied'; end if;
  if public.acquire_word_lease('44444444-4444-4444-8444-444444444444') then raise exception 'Concurrent lease acquired'; end if;
  select array_agg(seq) into seqs from public.word_sync_events where entry_id='22222222-2222-4222-8222-222222222222';
  insert into public.word_sync_intents(id,connection_id,expected_etag,output_hash,baseline_after,conflicts,event_seqs,region_exists)
  values('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','test-version','test-hash','[{"entry_id":"22222222-2222-4222-8222-222222222222","website":null,"block_hash":null}]','[]',seqs,false);
  begin perform public.commit_word_intent('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444'); raise exception 'Wrong owner committed'; exception when raise_exception then if SQLERRM='Wrong owner committed' then raise; end if; end;
  perform public.commit_word_intent('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333');
  perform public.commit_word_intent('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333');
  if exists(select 1 from public.word_sync_events where seq=any(seqs) and status<>'synced') then raise exception 'Intent did not commit events'; end if;
  if not exists(select 1 from public.word_sync_baselines where entry_id='22222222-2222-4222-8222-222222222222' and website is null and block_hash is null) then raise exception 'Tombstone not committed'; end if;
  perform public.release_word_lease('44444444-4444-4444-8444-444444444444');
  if not exists(select 1 from public.word_connections where lease_owner='33333333-3333-4333-8333-333333333333') then raise exception 'Wrong owner released lease'; end if;
  perform public.release_word_lease('33333333-3333-4333-8333-333333333333');
end $$;
rollback;
select 'PASS: durable insert/edit/delete outbox, private tokens/outbox, exclusive lease, owner fencing, atomic/idempotent intent commit; fixtures rolled back' as result;
