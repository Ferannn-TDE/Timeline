# Google sign-in and Google Docs setup

Live provider configuration and consent are required. The sharing link alone does
not authorize writes. The previous Microsoft document is no longer contacted.

## Google Cloud account steps

1. Open https://console.cloud.google.com and select/create a project. Enable
   **Google Docs API**, **Google Drive API**, and **Google Picker API**.
2. In **Google Auth Platform**, configure Moments Timeline branding and audience.
   For Testing, add feranmidyro@gmail.com and kieragreen50@gmail.com as test users.
   Add identity scopes (openid, email/profile) and
   `https://www.googleapis.com/auth/drive.file` to Data Access. Do not grant all-Drive
   or all-document scopes. Supabase sign-in requests identity only; Docs consent
   separately requests openid/email/drive.file.
3. Create a **Web application** OAuth client. Authorized JavaScript origin:
   `https://moments-timeline-rho.vercel.app`. Add BOTH exact redirect URIs:

   - `https://rnilakqmyanujehtqbuk.supabase.co/auth/v1/callback`
   - `https://moments-timeline-rho.vercel.app/api/docs/callback`

4. Create a Picker API key restricted to **Google Picker API**, with HTTP referrers
   limited to the production origin and `https://moments-timeline-rho.vercel.app/*`.
   Record the **numeric project number**, not the project ID.
5. Save credentials in ignored `.credentials/google.json`, file mode 600, directory
   mode 700. Never put secrets in chat, Git, or browser environment variables:

   ```json
   {"clientId":"WEB-CLIENT-ID.apps.googleusercontent.com","clientSecret":"SECRET-VALUE","projectNumber":"NUMERIC-PROJECT-NUMBER","pickerApiKey":"RESTRICTED-PICKER-KEY"}
   ```

These are placeholders. The agent can run `node scripts/configure-google.mjs` to
configure only Supabase's Google provider and prepare protected deployment files.
Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PROJECT_NUMBER`, and
`GOOGLE_PICKER_API_KEY` as sensitive Vercel Production variables. Docs also requires
`DOCS_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64), `SUPABASE_SERVICE_ROLE_KEY`,
and `CRON_SECRET`. No document secrets belong in Preview or `NEXT_PUBLIC_` variables.

External OAuth apps left in **Testing** can issue refresh tokens that expire after
seven days when Drive access is requested. For continuing synchronization, move
consent to Production when permitted. Publishing/branding review requires the
Google account owner. The per-file scope is non-sensitive. Resolve account or
organization restrictions through the administrator; do not broaden scopes.

## Sign-in, consent and file selection

Both editors use **Sign in with Google** on production. Other Google accounts have
no journal access under the existing database and photo policies.

One approved editor clicks **Connect Google Docs** and consents as that same Google
account, then clicks **Select shared Google Doc**. Choose the supplied existing Doc
in Google Picker. Picker provides the per-file grant; a pasted link does not.
The server rejects other document IDs. Refresh tokens remain encrypted on the
server; Picker receives only a short-lived access token in browser memory.

In the Doc's **Share** dialog, set general access to **Restricted** and give both
approved Gmail accounts **Editor** access. The worker checks sharing before each
job. It does not create anonymous links or automatically change sharing.
OAuth/Picker only read and inspect the real document initially; writes stay disabled.

## Temporary tests and activation

After consent, run `node --experimental-transform-types scripts/docs-acceptance.ts`.
It creates a new temporary Google Doc, verifies actual stale-revision rejection,
additions, older dates, edits, deletion, retry idempotency and direct-edit preservation.
It checks original sharing, exports a protected layout PDF, and verifies the original
revision is unchanged. Test photos never enter the real document. The temporary Doc
remains available for layout review; its private staging image is removed afterward.

Inspect `.credentials/docs-acceptance/layout-review.pdf` with both photo pages,
and `layout-after-deletion.pdf` after deletion, for one uncropped photo per page,
date above and caption below. Verify both actual Google logins. Only after
these checks may the operator mark the corresponding report fields as passed and
run `node scripts/activate-docs.mjs`. Activation obtains the worker lock and freshly
checks edit access, restricted sharing, the selected tab, original revision and absence
of an unfinished update before enabling writes. A changed revision invalidates the
acceptance report; repeat acceptance and review rather than changing its revision field.
Observe a genuine production journal entry updating the supplied Doc before claiming
live syncing complete; a no-op against an empty journal is insufficient.

The live browser regression refuses disposable fixtures while Docs syncing is enabled.
Never bypass that guard against the real document.

## References

- [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Google per-file permission](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Revision-checked Docs updates](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
- [Google token expiration](https://developers.google.com/identity/protocols/oauth2)
