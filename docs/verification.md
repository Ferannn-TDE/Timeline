# Verification record

## Real Google Picker blank-modal diagnosis (2026-09-30)

- Reproduced the real Google JavaScript Picker in extension-free Chrome on the
  production origin using a freshly refreshed, existing approved-user OAuth token
  held only in memory. No mocked Picker or admin-issued journal session was used
  for this reproduction; the journal was not modified and real sync stayed disabled.
- Confirmed CSS collision: Google uses class `picker` on its dialog, backdrop and
  content. The uploader's global `.picker` flex/centering/overflow rules applied to
  all of those Google elements. Actual Google iframe width was 1 px. Renaming only
  the application's stylesheet selectors restored its width to 1019 px, with the
  same Google API, token, view and browser. Screenshots are protected/ignored locally.
- Separate clean-browser evidence: docs.google.com/picker returned HTTP 401 and
  displayed a Google sign-in requirement. Its Sign in control became visible after
  CSS isolation. This browser had no Google cookies and no extensions. No CSP or
  extension violation was observed; this does not diagnose the owner's cookies.
- Fixed uploader class/selectors to `photo-picker`; Google `.picker` is untouched.
  Added independent, always-accessible Close controls, Escape cleanup, component
  unmount cancellation, a 15-second script timeout and two-minute selection deadline.
  Errors survive background polling and permit a new selection attempt.
- Official Google web-Picker documentation now requires docs.google.com/* as well
  as the website in website-restricted API keys. Corrected setup guidance; actual
  Cloud key restrictions remain unverified without account-owner access. No broader
  OAuth scopes or public photo access were introduced.
- Fresh token refresh/drive.file scope, numeric project number/client-prefix
  alignment, production origin and native Google Docs view were checked. No
  successful authenticated file list, exact target selection or server inspection
  has yet been observed; Google account interaction remains necessary.
- TypeScript/production build and targeted browser recovery checks passed. The
  recovery tests use simulated Picker callbacks and do not count as real selection.
  Acceptance/activation report fields remain unmodified, real writes disabled, and
  the July 25, 2026 entry remains pending. Neither shared document was written.

## Queued genuine entry diagnosis (2026-09-30)

- Traced the existing July 25, 2026 entry through its durable outbox: pending,
  zero attempts, no prepared Google update. Connection state is
  document_selection_required, enabled=false, inspected_at/tested_at unset.
- Successfully refreshed the encrypted Google authorization with drive.file scope.
  Actual read-only Docs and Drive requests for the exact target returned 404
  (NOT_FOUND/notFound). Picker inspection has not completed; sharing cannot yet be
  independently read. The Google API has not received an image insertion request.
- Production logs show the notification calling /api/docs/cron with HTTP 200.
  An authenticated worker invocation returned document_selection_required.
  This is an explicit setup block, not a claim of a completed sync.
- Production is configured with all four sensitive Google environment variables;
  Supabase Google sign-in is enabled. Only the first approved editor currently has
  an actual Google identity. Second-editor sign-in remains an activation prerequisite.
- Found another concrete failure in the genuine source JPEG: 8064x6048 pixels
  (48.8 MP), EXIF orientation 6, within the journal's 10 MB upload limit. The old
  worker's 40 MP limit rejects it before preparing any Google image.
- Fixed preparation to accept phone originals up to 80 MP, honor EXIF rotation,
  and proportionally resize inside 1600x2000 without cropping. Preparation failures
  now explain the image restriction and that the original and queue are preserved.
- Prepared the genuine photo with the fixed helper as 1500x2000 PNG. A private
  staging copy was reachable without authorization using its 600-second signed
  URL (HTTP 200); unsigned/public access was denied. Original photo bucket remains
  private. Removed only the temporary diagnostic staging copy.
- Fixed unhandled Google Picker ERROR callbacks to dispose the failed dialog,
  show actionable configuration guidance and re-enable selection for retry.
  Setup/activation blockers now explicitly explain that website changes remain
  queued. Upload/edit success messages refer to the timeline and separate Docs status.
- Passed 27 unit/behavior checks, TypeScript checking, production build and four
  targeted Chrome checks against the simulated backend, including Picker error
  retry and absence of writes while document verification is pending.
- Real temporary-Google-Doc acceptance and layout review remain blocked on target
  Picker access. Activation has not been attempted and no actual shared-document
  photo/caption update or edit propagation has been observed. No genuine journal
  entry, original photo, Google document or historical Microsoft document changed.

## Google setup verification and activation safeguards (2026-09-30)

- Inspected production READY deployment at commit b6fe1fa, the setup guide,
  local credential files, Supabase Auth and Vercel environment metadata.
- Initial audit found Google sign-in disabled, no Google variables in Vercel,
  no Docs connection or Google identities, and zero journal entries. The local
  Google file initially contained placeholders; those were not applied.
- After the owner supplied actual local values, the configuration helper enabled
  Supabase Google sign-in and verified its read-back. All four Google variables
  were securely stored as sensitive Vercel Production variables. No secrets were
  printed, committed, or added to Preview. Credential files are Git/upload ignored;
  the Google file has mode 600 and its directory mode 700.
- The project number is numeric and matches the OAuth client prefix. This is a
  consistency check, not an independent Google Cloud project inspection.
- Google Cloud APIs, consent audience/publishing status, test users, configured
  scopes, registered redirects and Picker key restrictions remain unverified.
  Actual Google login, Docs consent and target selection are still required.
- Fresh live transactional journal/Docs assertions passed and rolled back:
  both approved claims, rejection of unapproved/anonymous claims, private token
  and storage access, insert/edit/delete outbox, exclusive/fenced leases and
  atomic/idempotent recovery commit. These are SQL assertions, not Google logins.
- Both photo/staging buckets remain private, entry RLS is enabled, journal and
  notification triggers exist, and Microsoft connections remain disabled.
- Vault worker URL/credential match expected secure configuration. The actual
  production worker accepted its credential (HTTP 200) and returned
  authorization_required; this does not prove Google updates or scheduling.
- Fixed activation to hold the worker lease and freshly check exact document
  identity, edit access, restricted two-editor sharing, revision, selected tab,
  inspected connection, and absence of a prepared intent before enabling writes.
  Changed or expired connection locks fail closed; report statuses must all pass.
- Configuration now validates the numeric project number and Picker key before
  changing Supabase, and protects prepared credential files with mode 600.
- Temporary acceptance now invalidates a previous report, checks that real writes
  remain disabled before temporary writes, and exports both photo pages before
  deletion as well as a separate PDF afterward. These live tests and PDF inspection
  have NOT been performed yet; they require genuine consent and file selection.
- 26 local behavior/unit checks passed, including the new activation gate;
  TypeScript checking and production build passed. Google API responses in unit
  tests are simulated and do not count as live document acceptance.
- Real document writes remain disabled. No Google document or former Microsoft
  document has been written during this verification. No acceptance report fields
  were marked passed and no activation was attempted.

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

- Pushed implementation commit 384fd07 to GitHub and deployed directly through
  the authenticated Vercel CLI because the push did not trigger a new build.
  Deployment dpl_EqGMvgHhU1Eu6sCN5z4em9E9m6wo reached READY and was aliased to production.
- Repeated the actual production Chrome workflow after that deployment: both
  accounts, upload, older-date ordering, caption/date edits, cross-editor visibility,
  deletion, uncropped portraits and sign-out passed; only test fixtures were removed.
  The regression script now refuses fixtures if Word syncing is enabled.
- Read-only production Word route checks passed: anonymous status/connect/sync/
  conflict requests and unauthenticated cron were denied; both approved editor
  sessions received accurate authorization-required status without token fields.
- Read back SMTP after deployment: custom SMTP remains absent, production redirect
  remains correct. No real email delivery claim is made.

## Google Docs replacement (2026-09-30)

- Inspected clean repository and Vercel READY state at commit 294612c before editing.
- Inspected Supabase Auth: Google provider disabled; no client ID/secret configured.
  Supabase Site URL remains the stable production origin. Google Cloud CLI/account
  credentials are unavailable. The supplied Google Doc returned HTTP 401 read-only.
- Replaced the Microsoft runtime/routes/interface with Google Docs OAuth, per-file
  Picker selection, named-range merges, revision-conditioned atomic batches, durable
  queues, encryption, conflict resolution and cautious crash recovery.
- Added Supabase Google sign-in handoff requesting identity only, with accurate
  provider setup state. Kept existing membership/storage restrictions unchanged.
- 25 behavior tests pass, including 15 Docs tests covering untouched original material,
  sorted insertion, equal-date ordering, duplicate prevention, proportional layout,
  edits/deletion, direct edits, conflicts, missing ranges, unsupported markup,
  conditional writes, recovery, encryption and private document sharing. These use
  constructed API documents and simulated responses; they do not prove rendering.
- 14 distinct Chrome regression checks pass against simulated services (the original
  12-test suite and a focused 7-test final Google run including two new error checks),
  including journal
  workflows, Docs conflict/pending/failure states and Google OAuth handoff/config state, consent failure and provider outage.
- TypeScript and production build pass.
- Live preflight: zero current journal entries, exact two approved memberships,
  private photo bucket, zero enabled Word connections, no pre-existing Docs tables.
- Rehearsed migration 004 and rolled-back SQL checks, then applied it once. Repeated
  actual SQL assertions successfully: outbox snapshots, private token tables, lease
  fencing and idempotent commits; an unapproved JWT with Google provider metadata
  cannot read the journal or private photos. Fixtures rolled back.
- Sensitive Docs encryption configuration stored for Vercel Production and worker
  credential stored in Supabase Vault. Google client/Picker values are not provided.
  No Google provider was enabled with fabricated credentials.
- Prepared a real temporary-Doc acceptance script and activation gate. Neither was
  run: Google account configuration and consent are missing. No real or temporary
  Google document was written; the prior Microsoft document remains untouched.

Google sign-in remains unconfigured. Docs syncing remains disabled. Real Google
logins for both accounts, Picker authorization, live temporary-document updates,
Google-rendered portrait pagination, and a genuine production update to the supplied
Doc are still required. Follow docs/service-setup.md; no live integration is claimed.

- Pushed Google implementation 9e81a1a to GitHub and deployed directly to Vercel;
  dpl_AV9q4f2i8uFMKKCggPsVX1vaTjKw reached READY and production returned HTTP 200.
- Actual production Chrome workflow passed with both approved test sessions:
  upload, older-date placement, date/caption edit, shared visibility, deletion,
  portrait display and sign-out. Test entries/photos were removed. These sessions
  were admin-issued; this is not proof of Google authentication.
- Actual production Docs route checks passed: anonymous status/connect/picker/sync/
  conflict and cron access denied; both approved users get accurate disconnected
  status without refresh tokens; the removed Word endpoint returns 404.
- Actual private Docs staging-image checks passed: both browser editor accounts
  cannot issue staging links; unsigned public access denied; service-issued signed
  URL fetched successfully and its verified lifetime was exactly 600 seconds.
  The temporary staging image was removed afterward. No Google document was written.
- Production provider read-back still reports Google disabled, accurately reflected
  in the interface. Google Cloud credential file has not been provided.
