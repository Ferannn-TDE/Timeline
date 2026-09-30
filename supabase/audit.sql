-- READ ONLY. Run before choosing whether setup or a migration is needed.
select to_regclass('public.entries') as entries_table,
       to_regclass('public.journal_members') as members_table;

select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'public' and c.relname in ('entries', 'journal_members'))
   or (n.nspname = 'storage' and c.relname = 'objects');

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename in ('entries', 'journal_members'))
   or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;

select routine_schema, routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public' and routine_name = 'is_journal_member';

select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'is_journal_member';

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('entries', 'journal_members')
  and grantee in ('anon', 'authenticated');
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('entries', 'journal_members')
  and grantee in ('anon', 'authenticated');

select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'photo-journal';

-- Run these only if the tables above exist.
select email from public.journal_members order by email;
select count(*) as entry_count from public.entries;
select count(*) as photo_count from storage.objects where bucket_id = 'photo-journal';
select e.id as entry_with_missing_photo from public.entries e
left join storage.objects o on o.bucket_id = 'photo-journal' and o.name = e.image_key
where o.id is null;
select o.name as photo_without_entry from storage.objects o
left join public.entries e on e.image_key = o.name
where o.bucket_id = 'photo-journal' and e.id is null;
