# Remaining account access

The application code does not substitute for Microsoft consent or SMTP sender ownership.
Secrets belong in ignored `.credentials` files (directory mode 700, files mode 600),
Supabase secure settings, and Vercel **Production** server environment variables.
Never paste a secret into chat, Git, or a `NEXT_PUBLIC_` variable.

## Microsoft / SIUE

Sign in to https://entra.microsoft.com with the SIUE document owner's account.
Under **App registrations → New registration**, register **Moments Timeline**
for the university tenant. Add a **Web** redirect URI:

`https://moments-timeline-rho.vercel.app/api/word/callback`

Add **Microsoft Graph → Delegated permissions → Files.ReadWrite**.
The OAuth request also asks for `openid` and `offline_access` so authorized,
queued changes can be synced after the browser closes. Do not grant application
permissions or tenant-wide `Files.ReadWrite.All` as a workaround.
Create a client secret; record its expiration and plan its rotation.
Place these values in `.credentials/microsoft.json`:

```json
{"tenantId":"tenant UUID","clientId":"application UUID","clientSecret":"secret VALUE"}
```

These placeholders are a schema, not usable credentials. Deployment requires
`MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and an
independent `WORD_TOKEN_ENCRYPTION_KEY` (base64 encoding of 32 random bytes).
The server also requires `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET`; these are
never browser configuration. Preview deployments must not receive Word secrets.

Once configured, sign in to the production journal and click **Connect Microsoft**.
Authorize as the document owner or an identity with edit permission on the supplied
PHOTO EVIDENCE.docx. Authorization only reads/inspects the document; syncing remains
disabled until acceptance checks pass on a temporary document.

If registration or consent is blocked, send the actual restriction to the university
administrator. The request is: a confidential web application, the exact callback
above, delegated Graph Files.ReadWrite and offline_access for updating the owner's
existing photo evidence document, encrypted refresh tokens on the application server,
and access limited in the journal to the two approved editors. University approval
must also permit both editors' Microsoft identities to open the shared document.
Their journal Gmail addresses alone do not prove Microsoft sharing permission.
Do not create an anonymous sharing link.

## Email delivery

The inspected Supabase project has no custom SMTP host and its built-in quota is
two emails per hour. Resend is the recommended quick setup because it has an
[official Supabase SMTP integration](https://resend.com/docs/send-with-supabase-smtp).
It requires a sender domain you control. Verify the domain using the DNS records
shown by Resend; arbitrary Gmail From addresses are not a verified domain.

Prefer the Resend dashboard's Supabase integration to configure credentials securely.
Alternatively, save `.credentials/smtp.json` locally with `host`, `port`, `user`,
`password`, `senderEmail`, and `senderName`, then run `node scripts/configure-smtp.mjs`.
The script inspects current settings, updates only SMTP fields and email rate, and
reads back safe fields. `--inspect` performs no configuration writes.
Existing supported SMTP credentials can be used instead of creating a new provider.

After configuration, request an ordinary sign-in email from the production form for
each approved editor. Confirm each actual inbox receives it and each link returns
to production and opens the shared journal. Provider acceptance, a generated admin
magic link, and mocked browser tests do not establish inbox delivery.

## Activation requirements

Before enabling writes: inspect the original document and its version history;
use a temporary copy for addition, older-date order, edit, deletion, retry,
Word-only edit preservation and conflicts; prove stale ETags are rejected by the
actual drive; verify one uncropped portrait per page in Word Online and desktop Word;
and check both editors' access. If conditional PUT is not enforced, implement and
verify a conditional upload-session commit before activation. Never fall back to
unconditional replacement. Keep the original untouched during disruptive tests.
