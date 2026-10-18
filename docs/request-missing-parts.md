# Request: give three parts of a file that the answer of a command leaves out

**Package:** `ask-marcel-office-cli` 2.8.0
**Category:** conversion, calendar
**Kind:** one missing option, one missing command, and one gap in an option. No converter is broken.
In each gap, a part of a file does not arrive, and the other parts of the file arrive.

## Context

`decant` mirrors Microsoft 365 into markdown for local agents. `request-conversion-fidelity.md`
asked for the structure of each converted document. Batches 10 to 12 of the same audit found three
more gaps. In each gap, a part of a file is not in the answer that a consumer reads. A different
command gives two of these parts, but with a cost that each section names.

`decant` does not edit the text that the package returns: a gap goes upstream, not into a local
workaround. Thus this request names each gap, the function that causes it, and what the consumer
needs.

All line numbers refer to `dist/index.js` in 2.8.0.

## 1. The files of a zip after the first 100

`convertZipArchive` (lines 15556-15566) converts the first 100 files of a zip (`MAX_ENTRIES`, line
15540). For a larger zip, the answer adds `truncated: true` and `totalEntries`. Four commands use
this function:

- `read-mail-attachment` (line 15626)
- `convert-drive-item-zip-to-markdown` (line 16719)
- `convert-local-file-to-markdown` (line 16795)
- `convert-mail-attachment-zip-to-markdown` (line 16936)

No option changes the limit. Thus no command gives the text of file 101 or of a file after it. A
report saved as web pages, or a folder of scans, can hold more than 100 files. `decant` names the
files that stay in the zip in its report, for example `Contracts.zip, files 101 to 150`, but it
cannot give their text.

We ask for an option `--offset <n>` on these four commands. The answer skips the first `n` files of
the same sequence, sorted by path, and keeps `totalEntries`. Then a consumer reads all the files in
steps of 100, and each answer keeps its limit.

## 2. The bytes of one event attachment

`get-mail-attachment` (line 11324) gives one mail attachment with its bytes: `contentBytes`, the
`base64` mirror and `--output-path`. `get-group-post-attachment` (line 20053) does the same for a
group post. A calendar event has `list-calendar-event-attachments` (line 15949) and two converters
(lines 15986 and 16037), but no command for the bytes of one attachment.

The error text of the converter names one command that gives the bytes:
`get-calendar-event --expand attachments` (line 10966). That answer holds the bytes of all the
attachments of the event. A consumer that needs one file reads all of them, and an event with large
attachments gives one very large answer.

Thus `decant` writes an event attachment as markdown only. It keeps no original file, and it does
not keep a picture, because the converter cannot convert a picture to markdown.

We ask for `get-calendar-event-attachment` on `/me/events/{event-id}/attachments/{attachment-id}`,
with the same answer as `get-mail-attachment`.

## 3. The pictures in the headers and footers of a Word document

With `inlineImages: 'true'`, `download-drive-item-as-markdown` gives each picture of the body at its
position in the text (line 7302). mammoth does not read headers and footers. With
`includeMetadata: 'true'`, `extractHeadersFooters` (lines 7028-7036) gives the text of each header
and footer part, but it ignores the pictures in these parts. Thus a logo or a stamp in a header does
not arrive.

Before batch 12, `decant` got all the pictures of a Word document from `extract-drive-item-images`,
also the pictures of the headers. Since batch 12, it uses `inlineImages`, because each picture then
keeps its position in the text. It does not call that command for a Word document: that command
gives each picture part again, also the pictures of the body, which then arrive two times.

We ask for each picture of a header or a footer when `inlineImages` is `'true'`. The "Headers &
footers" part of the metadata block can give each one as a `data:` picture link, as the body does.

## What the consumer does meanwhile

`decant` names each file that stays in a large zip in its report. It writes each event attachment
as markdown, and its report names each picture that it does not keep. It does not keep a picture in
a header or a footer of a Word document.

## Priority

Item 1 comes first, because the files after the first 100 are text that a reader does not get.
Item 2 is next: the bytes are available in 2.8.0, but only in one large answer. Item 3 is last,
because the pictures of headers and footers are usually logos.

## What changes in the consumer when this lands

- Item 1: `decant` reads each zip in steps of 100, and unpacks all of its files. The report then
  names no file that stays in a zip.
- Item 2: `decant` can do the same steps for an event attachment as for a mail attachment: it keeps
  the original file, reads a picture with OCR and unpacks a zip.
- Item 3: no change in `decant`. It cuts each `data:` picture of the text to a file, also in the
  metadata block.
