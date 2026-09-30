-- Read-only preflight; migrations must not be rerun over existing tables.
select to_regclass('public.docs_connections') as docs_connections,
       to_regclass('public.docs_sync_events') as docs_sync_events,
       (select count(*) from public.entries) as journal_entries,
       (select public from storage.buckets where id='photo-journal') as photos_public,
       (select count(*) from public.word_connections where enabled) as enabled_word_connections,
       (select array_agg(email order by email) from public.journal_members) as editors;
