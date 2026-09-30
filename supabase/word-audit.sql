-- Read-only preflight. Never apply migrations 002/003 over existing objects.
select to_regclass('public.word_connections') as word_connections,
       to_regclass('public.word_sync_events') as word_sync_events,
       exists(select 1 from pg_extension where extname='pg_net') as pg_net,
       exists(select 1 from pg_extension where extname='supabase_vault') as vault,
       (select count(*) from public.entries) as existing_entries,
       (select public from storage.buckets where id='photo-journal') as photos_public;
select email from public.journal_members order by email;
