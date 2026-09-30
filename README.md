# Moments Timeline

A private two-person photo journal built with Next.js, Supabase, and Vercel.
The approved editors are **feranmidyro@gmail.com** and **kieragreen50@gmail.com**.
Entries appear newest first, refresh every 30 seconds, and show uncropped portraits.
Both editors can add, edit, and remove shared entries. Conflicting edits are rejected.

## Existing services

- GitHub: https://github.com/Ferannn-TDE/Timeline
- Supabase: `Timeline` (`rnilakqmyanujehtqbuk`)
- Production: https://moments-timeline-rho.vercel.app
- Vercel: `moments-timeline` in `ferannn-tdes-projects`, connected to this repository
- Word: sync code is implemented but **not activated**; Microsoft registration/consent and real-document acceptance checks remain required.

See [verification notes](docs/verification.md) for actual test results and outstanding work.

## Database setup and audit

**Do not rerun setup on an existing project.** Run the read-only `supabase/audit.sql`
first. The current project already had the tables, memberships, and original policies.
The targeted migration `supabase/migrations/001_restrict_approved_editors.sql` was
applied after that audit: it makes the photo bucket private, restricts uploads to
JPEG/PNG/WebP up to 10 MB, and adds restrictive policies for exactly the two editors.
It preserves existing entries, memberships, and photos. Restrictive guards also
constrain other permissive policies. Elevated database/admin credentials still bypass
RLS and must never be put in browser environments.

For a genuinely empty new project only: create a private `photo-journal` bucket,
run `supabase/setup.sql` once, then apply the targeted migration for bucket limits.
The two approved emails are already included. Do not add placeholder memberships.

## Local development

1. Copy `.env.example` to `.env.local` and set the project URL and publishable key.
2. Run `npm ci` and `npm run dev`.
3. Open http://localhost:3000 and request an email sign-in link.

`.env.local`, `.credentials`, `.vercel`, and test artifacts are ignored by Git and
excluded from Vercel uploads. Never commit tokens, service-role keys, or passwords.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Browser tests use a simulated Supabase backend and never prove live integration.
Install Playwright Chromium (`npx playwright install chromium`) or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chrome executable.
`tests/rls.sql` verifies live database policies with a transaction that rolls back.

The local-only service verification utilities in `scripts/` read protected account
sessions and project keys from `.credentials`. `create-test-sessions.mjs` generates
admin-issued magic links and verifies the actual Supabase sign-in exchange. It does
not prove email delivery. `live-check.ts` exercises real private storage and shared
entries and cleans only its own temporary test data. The browser uses only the publishable key. Word API routes use a server-only service-role key to access the private outbox and encrypted tokens.

## Vercel and authentication

Configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
for Production and Preview **before** building. Next.js embeds these at build time;
changing them requires a fresh deployment. Never expose a service-role or secret key in a browser variable.
Word server secrets are Production-only; see [service setup](docs/service-setup.md).

Set Supabase Auth Site URL to the actual stable production URL. Allow that exact
origin plus http://localhost:3000 and http://127.0.0.1:3000 for development.
Add specific preview origins if email login on previews is needed. Avoid wildcard
redirects for arbitrary deployments. Production checks hit Supabase’s sign-in email quota after two earlier accepted
requests. Reliable email delivery still requires sender/provider access and an
inbox check; see https://supabase.com/docs/guides/auth/auth-smtp.

Keep email confirmation enabled. The UI limits
sign-in requests to the approved emails; SQL policies enforce all data access.

## Shared Word document

The server implements delegated Microsoft OAuth, encrypted tokens, durable change
events, tagged-page merging, conditional writes, recovery intents and private backups.
The UI distinguishes connection, verification, queue, success, failure and conflicts.
[The conflict-handling design](docs/word-sync-design.md) governs preservation of direct
Word edits. [Service setup](docs/service-setup.md) records the required access and
acceptance gates. No Microsoft consent has been obtained and no original Word file
has been read or written. Sync stays disabled until real temporary-document checks
and rendering/access review pass. `scripts/word-acceptance.ts` contains the temporary
document checks; it requires protected Microsoft credentials and an OAuth connection.
Never run disruptive journal tests while syncing to the original document is enabled.

Migrations 002 and 003 were applied after an existence audit and rolled-back rehearsal.
Do not rerun them. They add server-only Word tables, an atomic outbox trigger,
exclusive leases, and Vault-backed asynchronous worker notifications. Client polling
and daily Vercel cron provide retry paths; after three failures, explicit retry is
required. The safe document limit is 25 MB; recovery backups and replaced image
assets are retained and require storage monitoring.

## Earlier private site

The earlier site at https://moments-timeline-journal.odedairoferan.chatgpt.site
was inspected read-only. Its live D1 `DB.entries` table was empty at the migration
check; it was not deleted or modified. This does not enumerate orphaned storage
objects. Recheck before migrating if the earlier site receives new entries.
