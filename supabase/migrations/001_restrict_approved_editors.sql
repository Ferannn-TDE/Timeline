-- Apply only after audit.sql confirms the original schema exists.
-- Does not recreate tables or delete any rows/photos. Transactional and repeatable.
begin;

do $$ begin
  if to_regclass('public.entries') is null or to_regclass('public.journal_members') is null then
    raise exception 'Original schema missing: inspect before running setup.sql';
  end if;
  if not exists (select 1 from storage.buckets where id = 'photo-journal') then
    raise exception 'photo-journal bucket missing: create a private bucket first';
  end if;
end $$;

create or replace function public.is_journal_member()
returns boolean language sql stable security definer set search_path = ''
as $$
  select lower((select auth.jwt()->>'email')) in ('feranmidyro@gmail.com', 'kieragreen50@gmail.com')
    and exists (select 1 from public.journal_members
                where email = lower((select auth.jwt()->>'email')));
$$;
revoke all on function public.is_journal_member() from public;
grant execute on function public.is_journal_member() to authenticated;

alter table public.entries enable row level security;
alter table public.journal_members enable row level security;
revoke all on public.entries from anon, authenticated;
revoke all on public.journal_members from anon, authenticated;
grant select on public.journal_members to authenticated;
grant select, insert, delete on public.entries to authenticated;
grant update (photo_date, caption) on public.entries to authenticated;

-- Restrictive guards also constrain any older permissive policies.
drop policy if exists "Approved editors guard" on public.entries;
create policy "Approved editors guard" on public.entries as restrictive for all to public
using (case when (select auth.role()) = 'authenticated' then (select public.is_journal_member()) else false end)
with check (case when (select auth.role()) = 'authenticated' then (select public.is_journal_member()) else false end);

drop policy if exists "Own approved membership guard" on public.journal_members;
create policy "Own approved membership guard" on public.journal_members as restrictive for all to public
using ((select auth.role()) = 'authenticated'
  and email = lower((select auth.jwt()->>'email'))
  and email in ('feranmidyro@gmail.com', 'kieragreen50@gmail.com'));

drop policy if exists "Approved photo editors guard" on storage.objects;
create policy "Approved photo editors guard" on storage.objects as restrictive for all to public
using (bucket_id <> 'photo-journal' or case when (select auth.role()) = 'authenticated' then (select public.is_journal_member()) else false end)
with check (bucket_id <> 'photo-journal' or case when (select auth.role()) = 'authenticated' then (select public.is_journal_member()) else false end);

-- Enforce upload ownership even if another insert policy was added earlier.
drop policy if exists "Photo entry author guard" on public.entries;
create policy "Photo entry author guard" on public.entries as restrictive for insert to authenticated
with check (lower(author_email) = lower((select auth.jwt()->>'email')));

update storage.buckets set public = false, file_size_limit = 10000000,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'photo-journal';

insert into public.journal_members(email)
values ('feranmidyro@gmail.com'), ('kieragreen50@gmail.com') on conflict (email) do nothing;
commit;
