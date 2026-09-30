# Verification record

Work performed on 2026-09-30.

- Local typecheck and production build passed.
- 10 behavior tests passed: validation, upload rollback, cleanup failures,
  deterministic paging, missing photos, conflicting edits, and zero-row mutations.
- 7 browser tests passed against a simulated backend: approved sign-in form,
  older-photo upload, date/caption edit, deletion, second-editor visibility/editing,
  unapproved-user rejection, stale-edit conflict, sign-out during refresh, mobile portrait display.
- Live Supabase audit: original schema existed, both tables had RLS, and exactly
  the approved two memberships were present. Original photo bucket was public.
- Applied migration 001; verified private bucket, 10,000,000-byte limit,
  JPEG/PNG/WebP allowlist, and all four restrictive policy guards.
- Real Supabase workflow passed using both approved editor sessions: upload,
  older-date placement, shared signed-photo reads, cross-editor edit/delete,
  anonymous and public-photo denial. Removed only test-created entries/photos.
- Actual email sign-in requests were accepted for both editors. Inbox receipt
  has not been checked. Test sessions were issued through admin-generated magic links.
- Earlier private site `appgprj_6abc01d783588191a70edf49cc51b2f7`:
  live D1 binding `DB`, table `entries`, zero rows. No old data changed.

- Live transactional RLS assertions passed for both approved email claims,
  unapproved authenticated claims, anonymous access, immutable authorship, and
  denial of self-granted membership. The fixture transaction was rolled back.
- Production URL: https://moments-timeline-rho.vercel.app (unauthenticated HTTP 200).
- Vercel production deployment `dpl_ARXdH8cnxVu7cQQW3AVWCorVjSse` reached READY.
- Production and Preview environments contain only the browser-safe Supabase
  project URL and publishable key. Local/admin credentials were excluded from uploads.
- Supabase Auth Site URL and exact production redirect are set to the stable URL;
  localhost/127.0.0.1 development origins are also allowed. Other settings preserved.
- Real production Chrome workflow passed against the live Supabase project:
  upload two portrait fixtures, add an older date, verify descending order,
  read from the second account, edit date and caption as the second editor, verify reordered placement, observe changes
  from the first editor, remove both fixtures, observe deletions from the second
  editor, verify uncropped portrait rendering, and sign out. No browser exceptions.

- Production email form sends the exact stable production redirect. After the
  earlier accepted delivery requests, Supabase returned HTTP 429 with
  `over_email_send_rate_limit` / `email rate limit exceeded` for both editors.
  The UI displays the error correctly. This check does **not** count as successful
  email delivery. A sender/provider configuration and inbox receipt verification
  are needed before claiming production sign-in is fully verified.
- The final live Chrome run passed the two-account date/caption/upload/delete
  workflow and the email-limit handling check. These are separate outcomes.

The Word link, Microsoft consent, document editing, conflict resolution, and
two-editor Word access are still outstanding. No Word connection is claimed as
implemented or tested. Email requests were accepted, but inbox receipt has not
been checked. Sessions used for live checks were admin-issued; no editor passwords
were requested or changed.
