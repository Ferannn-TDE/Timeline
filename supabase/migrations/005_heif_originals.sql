-- Only extend the existing private original-photo bucket's format allowlist.
-- No entry changes, outbox events, sharing changes or policy replacements.
begin;
update storage.buckets
set allowed_mime_types = case when allowed_mime_types is null then null else
  array(select distinct unnest(allowed_mime_types || array['image/heic','image/heif'])) end
where id='photo-journal' and public=false and file_size_limit=10000000;
commit;
