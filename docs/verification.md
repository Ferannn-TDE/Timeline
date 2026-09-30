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

## Remaining-work implementation (2026-09-30)

- Inspected deployed base commit af159ca and current repository before editing.
- Inspected Supabase Auth: no custom SMTP host/sender; built-in rate is two per hour;
  production Site URL remains correct. No SMTP configuration changed without provider credentials.
- Added Microsoft OAuth, encrypted server tokens, tagged DOCX merging, conflict UI,
  durable outbox, version-conditioned writes, fenced workers and crash recovery.
  Microsoft credentials/consent are unavailable; no original Word content has been read or written.
- All 23 unit/behavior checks passed, including 13 Word preservation, conflict,
  idempotency, proportional-image, conditional-write, recovery and encryption checks.
  These use constructed DOCX packages and simulated Graph responses, not actual Word rendering.
- All 10 Chrome tests passed against the simulated backend, including the existing
  journal workflows and new Word conflict, verification-pending and failure UI states.
- Production build and TypeScript checks passed.
- Read-only schema preflight found no Word tables, zero current journal entries,
  the exact two memberships, and a private photo bucket.
- Rehearsed migration 002 plus security/outbox assertions in a rolled-back transaction.
  Applied migrations 002/003 once, then repeated the transactional assertions successfully.
  Verified insert/edit/delete snapshots, browser denial of tokens/outbox/lease RPCs,
  concurrent lease exclusion, owner fencing, and atomic/idempotent intent commit.
- Stored Word encryption, service-role and worker credentials as sensitive Vercel
  Production-only values, and the worker credential in Supabase Vault. No Microsoft
  or SMTP secret is present; Word writes remain disabled.
- Prepared a live temporary-document acceptance script; it has NOT been run because
  Microsoft authorization is missing. Online/desktop pagination, live stale-ETag
  enforcement, two-editor Word access and original-document inspection remain unverified.

The Word integration is not activated. Reliable email delivery is not configured or
verified. Admin-issued sessions used for journal regression do not prove inbox delivery.
See service-setup.md for the concrete access steps and activation gates.
