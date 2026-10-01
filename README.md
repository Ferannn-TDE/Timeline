# Moments Timeline

A private two-person Next.js photo journal on Vercel with Supabase Auth, database
and private storage. Approved editors: feranmidyro@gmail.com and kieragreen50@gmail.com.
Entries sort newest first and display uncropped portraits. Both editors can upload,
edit and remove shared memories; stale updates are rejected.

Uploads accept JPEG, PNG, WebP, HEIC and HEIF up to 10 MB. HEIC/HEIF is decoded
locally in a cancellable browser worker with libheif-js 1.23.2 (bundled WebAssembly;
no native HEVC dependencies on Vercel). Container detection handles missing or
inconsistent iPhone MIME types. The primary still photo is decoded with its HEIF
orientation, limited to 80 megapixels/20,000 pixels per side, and proportionally
resized to a 2,000-pixel longest edge. No cropping is applied. A private JPEG
derivative powers previews and Docs; the original bytes are retained privately.
Animation, auxiliary depth images and HDR metadata are retained in the original
but are not reproduced in the JPEG preview. Current browsers need workers,
WebAssembly, createImageBitmap and OffscreenCanvas. Conversion times out after
two minutes and creates no storage objects or entries until successful.

- Production: https://moments-timeline-rho.vercel.app
- GitHub: https://github.com/Ferannn-TDE/Timeline
- Supabase: Timeline (`rnilakqmyanujehtqbuk`)
- Google Doc: https://docs.google.com/document/d/1gGFlT4q6OKSKakkEt25Wl5Yk78-VJCpIuUGuQ8qO8ws/edit

Google sign-in and Docs code are implemented. Live configuration, consent,
temporary-document acceptance and a real production update must pass before
claiming the integrations complete. The interface shows pending setup accurately.
The Microsoft integration is removed; its document and historical database state
are preserved and not contacted.

## Service setup

[Google setup](docs/service-setup.md) gives exact redirects, API/Picker configuration,
secure credentials and activation steps. Supabase Google sign-in requests identity
only; document consent separately requests per-file drive.file access. A Google
login cannot bypass the two-email database/storage restriction.

For local development copy `.env.example` to `.env.local`, set the browser-safe URL
and publishable key, run `npm ci` and `npm run dev`. Sensitive server variables belong
only in protected `.credentials` or Vercel Production. Never put them in NEXT_PUBLIC_
variables, chat or Git. Credentials, environment files, artifacts, Vercel metadata
and Supabase temporary files are ignored and excluded from deployment uploads.

## Database

Do not rerun setup.sql. Audit the live project using supabase/audit.sql and
supabase/docs-audit.sql first. Migration 001 already enforces the two memberships,
private photos and file limits. Migrations 002/003 retain historical Word state.
Migration 004 switches the outbox to Google Docs, creates private server tables and
buckets, and disables Word jobs. Journal entries/photos and external documents are
not deleted. Check verification notes before applying any migration again.
Migration 005 only extends the private photo bucket MIME allowlist for HEIC/HEIF.
HEIF originals use immutable `.heic`/`.heif` keys; their JPEG derivatives append
`.preview.jpg`. Both objects upload before entry insertion, are rolled back if
insertion fails, and are removed together when the entry is deleted.

## Google Docs updates

[The sync design](docs/google-docs-sync-design.md) describes manual-edit preservation,
conflicts, chronological placement, named ranges, conditional writes and recovery.
Private image insertion uses ten-minute signed URLs. Unsupported layout/comments,
conflicting edits and uncertain recovery pause updates. Saving a journal entry is
separate from syncing it to Docs.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to installed Chrome, or install Playwright
Chromium. Unit Docs fixtures and simulated UI responses do not prove live Google
login or rendering. tests/rls.sql and tests/docs-rls.sql verify live database access
and outbox behavior in rolled-back transactions. Admin-issued sessions used by
local verification scripts are not proof of Google sign-in. Disruptive live journal
fixtures are refused while Docs syncing is enabled.

scripts/docs-acceptance.ts runs real API checks on a new temporary Doc after consent.
scripts/activate-docs.mjs refuses activation until login, layout, sharing and API
acceptance checks pass. See [actual verification results](docs/verification.md).

After the isolated HEIC browser tests produce their actual JPEG derivative,
`node --experimental-transform-types scripts/heif-docs-acceptance.ts` tests it in
a newly created temporary Google Doc. It never inserts journal fixture entries
or writes to the real Doc, and can run without changing live-sync activation.
Review the protected PDF in `.credentials/heif-acceptance/layout.pdf`.
This does not bypass the existing live-journal fixture guard.

## Earlier site

The earlier private site and its data remain untouched. Its entries table was empty
at the previous read-only migration check. No deletion or migration is needed.
