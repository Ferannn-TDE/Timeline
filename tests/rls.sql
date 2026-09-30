-- Real policy assertions. All fixture changes are rolled back, even on failure.
begin;
insert into public.entries (photo_date, caption, image_key, author_email)
values ('2001-01-01', '__Moments RLS verification__', '__moments_rls_verification__', 'feranmidyro@gmail.com');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","email":"feranmidyro@gmail.com"}', true);
do $$ begin
  if not public.is_journal_member() then raise exception 'First editor denied'; end if;
  if (select count(*) from public.entries where image_key='__moments_rls_verification__') <> 1 then
    raise exception 'First editor cannot read entry';
  end if;
  begin
    update public.entries set author_email='someone@example.com' where image_key='__moments_rls_verification__';
    raise exception 'Immutable author was writable';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims', '{"role":"authenticated","email":"kieragreen50@gmail.com"}', true);
do $$ begin
  if not public.is_journal_member() then raise exception 'Second editor denied'; end if;
  update public.entries set caption='__Moments RLS verification by second editor__' where image_key='__moments_rls_verification__';
  if not found then raise exception 'Second editor cannot edit shared entry'; end if;
end $$;
select set_config('request.jwt.claims', '{"role":"authenticated","email":"someone@example.com"}', true);
do $$ begin
  if public.is_journal_member() then raise exception 'Unapproved email allowed'; end if;
  if (select count(*) from public.entries) <> 0 then raise exception 'Unapproved account sees entries'; end if;
  if (select count(*) from public.journal_members) <> 0 then raise exception 'Unapproved account sees members'; end if;
  update public.entries set caption='Unauthorized' where image_key='__moments_rls_verification__';
  if found then raise exception 'Unapproved account edited entry'; end if;
  delete from public.entries where image_key='__moments_rls_verification__';
  if found then raise exception 'Unapproved account deleted entry'; end if;
  begin
    insert into public.entries (photo_date,caption,image_key,author_email)
    values ('2000-01-01','Unauthorized','__unauthorized_rls__','someone@example.com');
    raise exception 'Unapproved account inserted entry';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id,name) values ('photo-journal','__unauthorized_rls__');
    raise exception 'Unapproved account uploaded photo';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.journal_members(email) values ('someone@example.com');
    raise exception 'Unapproved account granted membership';
  exception when insufficient_privilege then null;
  end;
end $$;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$ begin
  begin
    perform id from public.entries;
    raise exception 'Anonymous account can read entries';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
select 'PASS: both editors share entries; unapproved and anonymous access denied; fixture rolled back' as result;
