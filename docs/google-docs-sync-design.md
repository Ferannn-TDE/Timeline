# Google Docs synchronization

Patch the existing document with the Docs API; never replace it with a regenerated
file. Inspect its revision, tab and portrait page settings before enabling writes.
Opening material, headers, footers, tables and untagged content remain intact.
Only one paged, single-column document tab is currently supported. Unsupported
layouts pause without changing page settings.

Invisible start/end paragraphs have connection-specific named ranges. Each managed
page has a named range containing its immutable journal entry UUID. Duplicate,
split, missing or moved ranges, unrecognized content between pages, unsupported
objects and suggestions stop synchronization. Named ranges are identity metadata,
not access controls. Untagged material outside the managed area is never deleted.

Compare current website fields, the full current paragraph/text/image formatting
hash, and the last baseline. Ignore shifting indices and ephemeral image URLs.
Preserve Docs-only edits. Simultaneous website/Docs edits and deletion of a manually
edited page produce conflicts. Do not recreate directly deleted pages. Resolution
is bound to both reviewed hashes; a later edit invalidates the choice. Keeping Docs
preserves its page and leaves the website unchanged. Choosing the website explicitly
replaces or deletes the affected page.

Insert/reorder only pages being updated from the website. Untouched pages remain
in place with their formatting; restore their named-range indices after the batch.
Sort by photo date descending, creation time ascending, then UUID. Manual page
reordering/date changes that make preserved pages unsortable require review; never
reconstruct a manually edited page simply to move it. Comments anywhere conservatively
pause existing-page replacements/deletions because their anchors cannot yet be
validated. Additions can proceed. Tracked suggestions and complex managed markup
also pause rather than guess.

Generated pages start with a page break before the date, centered inline photo,
and caption below. Scale dimensions proportionally within the printable portrait
page and reserve caption space. Reject captions that cannot safely fit. Actual
Google-rendered layout must pass temporary-document checks before activation.

Normalize private source photos to PNG with EXIF orientation, stage them in a
server-only private bucket, and provide Google with a 600-second signed URL. Google
fetches a copy for the restricted document. The original bucket never becomes
public. Check restricted sharing with both approved editors before each sync job.
Staging/recovery artifacts remain private and require storage/retention monitoring.

Journal mutations and durable outbox inserts share one transaction. A service-only
expiring lease serializes workers. Unresolved conflicts do not starve new events.
Notifications, client polling and daily Vercel cron trigger jobs; three failures
require explicit retry. Save a prepared intent, expected revision, operation ID and
batch with private asset references before writing. Generate fresh signed URLs
at write time and on retry. Save a private pre-write document snapshot.

Every atomic batchUpdate uses requiredRevisionId. Never use unconditional updates
or targetRevisionId merging. A rejected revision abandons the candidate and requires
a fresh read/merge. An operation named range identifies an applied batch. Save the
returned revision, read back that same revision, verify untouched pages, persist
baselines, then atomically commit event states. A lost response or intervening edit
before baseline capture pauses recovery. A previously durable baseline can commit
after a crash without reinsertion or acknowledging later direct edits as website edits.

Docs OAuth is separate from Supabase Google sign-in. Use openid/email/drive.file,
Picker file selection, encrypted refresh tokens, single-use browser-bound state
and PKCE. Routes verify both the Supabase identity and exact approved membership.
The browser cannot enable writes or read private queue/credentials/recovery tables.
