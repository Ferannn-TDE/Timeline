-- Run this once in the Supabase SQL Editor.
-- Create a PRIVATE Storage bucket named photo-journal in the Dashboard first.
create table if not exists public.journal_members (
  email text primary key check (email = lower(email) and email in ('feranmidyro@gmail.com', 'kieragreen50@gmail.com'))
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  photo_date date not null,
  caption text not null check (char_length(trim(caption)) between 1 and 2000),
  image_key text not null unique,
  author_email text not null,
  created_at timestamptz not null default now()
);
create index if not exists entries_date_created_idx on public.entries(photo_date desc,created_at);

alter table public.journal_members enable row level security;
alter table public.entries enable row level security;

revoke all on public.journal_members from anon, authenticated;
revoke all on public.entries from anon, authenticated;
grant select on public.journal_members to authenticated;
grant select, insert, delete on public.entries to authenticated;
grant update (photo_date,caption) on public.entries to authenticated;

create policy "Read own membership" on public.journal_members
  for select to authenticated
  using (lower(email)=lower((select auth.jwt()->>'email')));

create or replace function public.is_journal_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select lower((select auth.jwt()->>'email')) in ('feranmidyro@gmail.com', 'kieragreen50@gmail.com') and exists (
    select 1 from public.journal_members
    where lower(email)=lower((select auth.jwt()->>'email'))
  );
$$;
revoke all on function public.is_journal_member() from public;
grant execute on function public.is_journal_member() to authenticated;

create policy "Members read entries" on public.entries
  for select to authenticated using ((select public.is_journal_member()));
create policy "Members add their entries" on public.entries
  for insert to authenticated
  with check ((select public.is_journal_member())
    and lower(author_email)=lower((select auth.jwt()->>'email')));
create policy "Members edit entries" on public.entries
  for update to authenticated
  using ((select public.is_journal_member()))
  with check ((select public.is_journal_member()));
create policy "Members remove entries" on public.entries
  for delete to authenticated using ((select public.is_journal_member()));

create policy "Members view photos" on storage.objects
  for select to authenticated
  using (bucket_id='photo-journal' and (select public.is_journal_member()));
create policy "Members upload photos" on storage.objects
  for insert to authenticated
  with check (bucket_id='photo-journal' and (select public.is_journal_member()));
create policy "Members remove photos" on storage.objects
  for delete to authenticated
  using (bucket_id='photo-journal' and (select public.is_journal_member()));

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

insert into public.journal_members(email)
values ('feranmidyro@gmail.com'), ('kieragreen50@gmail.com')
on conflict (email) do nothing;
