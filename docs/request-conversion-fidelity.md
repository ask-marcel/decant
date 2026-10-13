# Request: keep the structure of the source in each converted document

**Package:** `ask-marcel-office-cli` 2.8.0
**Category:** conversion
**Kind:** faults in the converters, plus two missing options. The text of each document arrives.
Its structure does not: tables, lists, lines and the place of each picture.

## Context

`decant` mirrors Microsoft 365 into markdown for local agents. On 2026-10-13 an audit examined one
real export, made on Windows: 1,334 files, 854 of them markdown. Most of the format faults that it
found come from the conversions in this package.

`decant` does not edit the text that the package returns: a gap goes upstream, not into a local
workaround. Thus this request names each fault, the function that causes it, and what the consumer
needs.

All line numbers refer to `dist/index.js` in 2.8.0.

## 1. Word tables

About 1,800 tables in Word conversions show as raw text, because each cell that holds text breaks its
row over several lines. 24 files also have rows with a different number of columns.

- `promoteFirstRowToThead` (lines 7274-7294) puts the first row of each table into `<thead>`. Then
  `hasProperHeader` (line 6412) is true for each Word table, so the safe cell rule `convertCell`
  (line 6429) never runs for Word.
- turndown-plugin-gfm then writes each cell as it is. Mammoth puts each cell paragraph in `<p>`, and
  turndown changes a `<p>` into blank lines.
- The gfm cell rule ignores `colspan` and `rowspan`, which mammoth writes, so a merged row is short.
- A nested table ends at the first inner `</table>` (line 7284).
- On this path, a `|` in a cell is not escaped.

We ask for one cell rule for all tables: fold the cell to one line (with `<br>` for a paragraph
break), escape `|`, expand `colspan` and `rowspan`, and find the end of a table with the DOM.

## 2. The metadata block

With `includeMetadata: 'true'`, each Word note ends with about 200 lines. There are 17 sections,
also when they are empty (`_(none)_`), all `_Toc` and `_Ref` bookmarks, the TOC and PAGEREF field
codes, and the line "Macros (VBA): none". An empty document gets about 70 lines. The source is
`formatDocxMetadata` (lines 7221-7252).

We ask for a compact form: no empty section, no bookmark name that starts with `_`, no TOC or
PAGEREF field, and no "none" line. The comments, the tracked changes and the external hyperlinks are
the parts that a reader uses.

## 3. Pictures in mail attachments

`download-drive-item-as-markdown` accepts `inlineImages`, so `decant` can put each picture of a
library document where it is in the text. `convert-mail-attachment-to-markdown` does not accept it
(schema at lines 15378-15385), so a Word file attached to a mail keeps its pictures in a list at the
end. Also, `extract-drive-item-images` sorts the picture parts by name (line 9784), so `image10`
comes before `image2`.

We ask for `inlineImages` on `convert-mail-attachment-to-markdown` and on the same command for group
posts, and for a sort by number.

## 4. Excel

When a sheet has a title in its first row, the title becomes the table header. The real column
headers then become the first data row. One line in the export has 18,384 characters.

- `sheet_to_csv` with `blankrows: false` (line 8177) removes the blank row under the title, and the
  first CSV row is always the header (lines 8337-8360).
- Empty columns at the end stay, and no limit applies to the length of a cell.

We ask for these changes:

- Find the header row: the first row with a value in most columns.
- Remove the empty columns at the end.
- Cut a very long cell, with a clear marker.

## 5. PowerPoint

Each paragraph of each shape becomes one line, with no structure. The timeline labels M0 to M14 take
15 lines. Bullets are lost. A line break (`a:br`) is lost, so "first bullet" and "soft line" become
"first bulletsoft line".

Tables lose their columns, and the speaker notes become one line. The source is `slideBodyText`,
`notesText` and `slideSection` (lines 8077-8148).

We ask for these changes:

- Keep bullets as list items.
- Keep `a:br` as a line break.
- Render a table as a table.
- Sort the shapes by their position on the slide.
- Keep the line breaks of the notes.

## 6. PDF

Each PDF becomes one line of text, so a reader cannot see a paragraph or a heading. The source is
`extractText(doc, { mergePages: true })` (line 7954): unpdf joins the pages and then changes all
white space to one space.

We ask for `mergePages: false`, pages joined with a blank line, and the line breaks kept.

## 7. Mail HTML

The turndown rules give these faults in the mail notes:

| Fault | Count in the export |
|---|---|
| Bold that starts on one line and ends on another (`**Jane Doe  \nManaging Director  \n**`) | 93 notes, mail and Word |
| Link text on two lines | 8 of the 140 cases (the other 132 come from decant's own calendar text) |
| Text such as `<font color=red>` written as raw HTML, because `<` is not escaped | 1 note |

We ask to close and open bold and links again at each `<br>`, and to escape `<` in text. Also, an
event or a contact attached to a mail keeps its `cid:` pictures (lines 15233-15240). We ask for the
same `[inline image: name]` placeholder that a mail body gets.

The export also has links with no text, such as `[](https://www.pepco.pl)`. decant makes most of
them: it removes a picture placeholder that was the only text of a link. Thus they are not part of
this request.

## 8. Message ids that do not change

When a mail moves to another folder, Graph gives it a new id. `decant` then sees a new message and
writes the whole conversation again. The Graph client (lines 1610-1622) sends no
`Prefer: IdType="ImmutableId"` header, and the string `ImmutableId` does not occur in the package.

We ask for an option that sends `Prefer: IdType="ImmutableId"` on the mail commands, so that a
message keeps its id when it moves.

## What the consumer does meanwhile

`decant` does not edit the text that the package returns, so the faults above stay visible. It
repairs the faults that are its own: picture links with spaces, paths on Windows, and the place of
the pictures in library documents, with the `inlineImages` option that exists today.

## Priority

Item 1 comes first: about 1,800 tables in one export. Items 6 and 7 are next, because they change
how a reader sees a paragraph and a signature. Items 2, 3, 4, 5 and 8 make the result better, and in
each of them the text is there.

## What changes in the consumer when this lands

- Items 1, 4, 5, 6 and 7: nothing. `decant` takes the new version, and the next conversion of each
  file gets the better text.
- Item 2: `decant` passes the compact option, if the compact form is an option.
- Item 3: `decant` asks for `inlineImages` on mail attachments too, as it does for library documents.
- Item 8: `decant` passes the option on its mail calls. A move to another folder then changes only
  the folder of the message, not the whole conversation.
