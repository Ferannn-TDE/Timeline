# Shared Word connection — design, not an active integration

The document link and delegated Microsoft authorization are still required.
No shared document has been read or written. This design is recorded for discussion
before any write to the existing file. Never upload a newly generated journal over it.

## Updating the existing document

Download the latest `.docx` and its version identifier. Preserve the ZIP package,
styles, headers, footers, comments, relationships, and all untagged content. Add one
block-level Word content control per entry, tagged with its immutable entry UUID.
Each block contains date above, one uncropped photo fitted inside the printable
portrait page, and caption below. Give each entry a page break before it. Keep
page numbering, opening material, and other user content in place. Sort only the
tagged journal blocks by photo date descending, then creation time and UUID, to
match the website. Inspect the actual document before choosing a managed region
or changing its section geometry. A long caption may need a smaller image; exact
one-page layout must be verified in Word with representative captions.

## Preserve Word edits

Store the last synced website fields and a hash of the full managed Word block.
On every sync, compare the current website entry, the latest document block, and
that baseline. If only Word changed, preserve its block exactly, even if its
caption or formatting differs from the website. New website entries can still
be inserted. If only the website changed, update that managed block. If both
changed, pause the affected edit and show both versions for resolution; retain
the website entry and the Word block. A website delete must also pause when the
Word block was edited. Do not recreate a block someone removed directly in Word
without resolving that deletion. Missing/duplicate tags, missing baseline, moved
blocks outside the managed region, tracked changes, or unsupported markup must
pause rather than guess. No automatic deletion of untagged document material.

Keep sync events in a durable database outbox, with UUID idempotency and per-
document serialization. Do not mark an entry synced until both the file upload
and the baseline commit succeed; handle upload success followed by database
failure by recognizing the existing block on retry. Display pending, synced,
authorization expired, and conflict states separately from saving to the journal.

Before uploading the patched package, use a conditional Microsoft Graph write
with the version identifier read before download. A changed version, lock, or
conflict causes a fresh download and merge, with bounded retries. Never retry by
force-replacing the latest file. Keep the previous version as a recovery artifact
and verify version-history availability on the actual drive.

## Access and acceptance checks

Use a Microsoft application registration and delegated OAuth consent with the
minimum read/write permissions needed for this document's drive. Keep refresh
tokens encrypted on the server; never put them in `NEXT_PUBLIC_` variables, Git,
or browser storage. Website routes must verify the Supabase user and exact two-
email membership before exposing a document URL, starting OAuth, or requesting
sync. Share the document with both editors without creating an anonymous link.

Test additions, older dates, edits, deletion, repeated retries, Word-only edits,
simultaneous Word/website edits, expired consent, locked documents, and two-editor
access on the real document. Confirm one portrait photo per page in desktop Word
and Word Online. A document connector connection is not itself the deployed app's
OAuth registration or continuous synchronization.

Microsoft's conditional upload behavior is documented at:
https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0
