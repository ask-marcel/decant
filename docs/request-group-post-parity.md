# Request: give a group post the same reach a mail message has

> **Resolved in `ask-marcel-office-cli` 2.6.0.** All three commands landed, named as the mail
> siblings: `convert-group-post-attachment-to-pdf`, `extract-group-post-attachment-images` and
> `extract-sharepoint-links-in-group-post`, each taking `--group-id`, `--thread-id`, `--post-id`
> and, for the first two, `--attachment-id`. `decant` took the dependency and wired all three on
> 2026-09-09; the prediction below held exactly, three methods in one adapter and nothing else.
> Kept as the record of what was asked for and why.

**Package:** `ask-marcel-office-cli` 2.5.0
**Category:** mail
**Kind:** missing commands. Nothing is broken. A group post's text arrives in full; what it carries
does not arrive the way the same file would if it had been attached to an ordinary mail.

## Context

2.5.0 closed the gap `request-group-thread-posts.md` asked about, and closed it well: a consumer can
now read a group inbox thread by thread and post by post, with the full HTML body. `decant` was
built on it the same day and mirrors a group inbox into markdown, one document per thread, through
exactly the same rendering path its mailbox sync uses.

Verified live on 2026-09-06 against a real group inbox: 13 threads read and written, nothing
skipped and nothing failed.

The rendering path is shared, so everything the mail side does for an attachment happens for a post
attachment too, right up to the three points where there is no group command to call.

## What is missing

| Mail command | Group equivalent in 2.5.0 | What is lost |
|---|---|---|
| `convert-mail-attachment-to-pdf` | none | A deck attached to a post gets its text, and no rendered pages beside it. The mail side writes both. |
| `extract-mail-attachment-images` | none | A diagram inside an attached Word or Excel file does not survive. On the mail side it is extracted and OCR'd, so the text inside a picture is searchable. |
| `extract-sharepoint-links-in-mail` | none | A SharePoint link in a post body stays a link. On the mail side the document behind it is fetched, converted and filed once for the whole vault. |

The three sit next to each other in `list-group-post-attachments` and `get-group-post-attachment`,
both of which exist and work: the attachment is reachable, its bytes are reachable, and the two
conversions and the link scan are what is not.

## What the consumer does meanwhile

`decant`'s group adapter answers each honestly rather than approximately, which is the behaviour a
missing command should produce:

- the PDF render returns `unrenderable` with the reason, so the thread records that no PDF exists
  rather than pretending one was refused by Graph
- the image extraction returns an empty list, which is what a document holding no pictures returns,
  so a reader sees the placeholders and no gallery
- the link scan returns an empty list, so nothing is filed under `_linked/`

None of the three is worked around locally. Fetching the bytes and converting them here would
duplicate the conversion the library already owns, and would drift from it.

## What could not be tested

Not one post in any of the three unified groups on this tenant carries an attachment, so the paths
above are exercised by hand-written fakes and never by a real payload. The same was true of the
attachment commands 2.5.0 shipped, as `report-group-thread-posts-verified.md` recorded. A tenant
with a group that has ever had a file posted to it would settle both at once.

## Priority, honestly stated

Low for this consumer today, and worth saying so rather than overstating it. On the tenant that prompted
the work, the group inboxes hold meeting invitations: 16 threads across three groups, none with an
attachment, and the newest a month old. The gap costs nothing here yet. It would matter to any group used the
way a shared mailbox is used, where a file gets posted and someone expects to find it later.

## What changes in the consumer when this lands

Nothing but three methods in `src/infra/group-reader-marcel.ts`, each currently answering with the
honest empty described above: `attachmentPdf` becomes a call to the new render command,
`attachmentImages` to the new extraction, and `sharepointLinks` to the new scan, mirroring what the
mail adapter already does for the same three.

Everything downstream is already shared, so a post attachment starts getting its rendered pages, its
extracted diagrams and its linked documents the moment the adapter stops saying no. No use-case, no
domain module and no test outside that adapter needs to move.

Two notes for whoever does it: take the dependency first, and read the new command names off
`dist/commands.json` rather than assuming they match the mail spellings.
