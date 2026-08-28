# Knowledge base sync CLI

A Bun CLI that mirrors Microsoft 365 content into a local `kb/` folder as markdown, so agents
running on this machine can read company knowledge without calling Microsoft Graph themselves.

It syncs **SharePoint document libraries** and your **Outlook mailbox**, the latter as one markdown
file per conversation with its attachments and the SharePoint files it links to.

Graph access goes through [`ask-marcel-office-cli`](https://www.npmjs.com/package/ask-marcel-office-cli)
used as a library, which owns authentication, paging and document conversion. See
[docs/marcel-library-map.md](docs/marcel-library-map.md).

## Requirements

- [Bun](https://bun.sh) 1.2 or newer
- A Microsoft 365 account already signed in: run `ask-marcel-office login` once (a browser opens)
- Python 3 with [`rapidocr`](https://pypi.org/project/rapidocr/) installed, to read text out of images and scanned PDFs (optional; without it the files are still copied)

## Install

```bash
bun install
```

## Run

```bash
bun run sync
```

Lists every SharePoint site you can read plus your mailbox, marking the ones already in `kb/` with
when they last synced and how much they hold. Pick a number and one or more libraries, or press
`m` for your mailbox, and it syncs.

Your Loop workspaces are on that list too, shown as `Loop - <workspace>`. A workspace keeps its
pages in a container no site listing returns, so they are found through the `.pod` manifest each one
carries; from there a workspace is synced exactly like a site, and `update` refreshes it with the
rest. A workspace nobody has opened may be missing from the index for a while: sync it by container
id with `--site-id` when that happens.

Several sites can be taken at once: `1,3` for those two, or `all` for every site on the list. Taking
more than one site takes every library in each without asking, since the point of choosing them
together is not being asked once per site. Each site is summarised as it finishes.

To refresh everything already synced, without being asked anything:

```bash
bun run sync update
```

That form is safe to schedule: it never opens a browser, and a lapsed sign-in ends the run with a
clear message instead of waiting for input.

### Options

| Option | Meaning |
|---|---|
| `--site-id <id>` | Sync this site without showing the picker |
| `--site-url <url>` | Sync the site at this address, for sites the search index does not list |
| `--drive-id <id>` | Sync only this library; repeat for several |
| `--mailbox` | Sync your Outlook mailbox without showing the picker |
| `--since <day>` | With `--mailbox`, only conversations touched since this day (`2026-01-31`) |
| `--dry-run` | Report what would be done and write nothing |
| `--max-size-mb <n>` | Skip files larger than this (default 50) |
| `--concurrency <n>` | How many items to convert at once (default 4); `1` is strictly sequential |
| `--no-ocr` | Do not read text out of images or scanned PDFs |
| `--refresh` | List the sites afresh instead of drawing the picker from the ones last seen |
| `--ocr-lang <code>` | Language used to read images and scanned PDFs (default `en`) |

## What lands in `kb/`

```
kb/
  _sync-report.md                   what the last run left behind, every source in one file
  _archive/<Site>/<Library>/...     files whose source was deleted, renamed, or changed away
  <Site>/
    .sync-state.json                what has been synced, and where the next run resumes
    _sync-report.md                 what did not make it in, and why (only when there is something)
    <Library>/
      2026-05-12/                   the day each document last changed at the source
        <SharePoint folders mirrored>/
          Roadmap.pptx.md           slide text
          Roadmap.pptx.pdf          the rendered deck
          Contrat.pdf               the original
          Contrat.pdf.md            its text layer
          Contrat.docx.md           the text, plus a section listing the pictures inside
          Contrat.docx.media/       those pictures, kept as files
```

Every document is filed under the day it last changed at the source, not the day it was synced, with
the folders it had in SharePoint underneath: the day is what you usually want to scan by, and the
folders are what keep two same-named documents apart. A document whose source reports no date at all
goes under `undated/`.

Because the day comes from the document itself, editing one at the source files it afresh under its
new day. The copy under the old day is not left behind as a duplicate: it is moved into `_archive/`,
where anything the source no longer has already goes.

Two different SharePoint sites can share a display name (most often an unedited template title). The
picker shows each one's address alongside the name so they can be told apart before choosing, and if
a sync would otherwise land in a folder another site's `.sync-state.json` already claims, it is
written under a disambiguated one instead (`<Site>-<hash>/`) rather than merging into it.

Every generated markdown file opens with where it came from. A `source` that is a real SharePoint or
OneDrive link carries `?web=1`, so clicking it opens the browser viewer directly instead of prompting
to launch a desktop app; a mail conversation or a linked-drive-item source, neither a real URL, is
left as its plain label.

```yaml
---
source: https://tenant.sharepoint.com/sites/X/Roadmap.pptx?web=1
site: Espace Contoso
library: Documents
path: Projets/Roadmap.pptx
last_modified: "2026-05-12T09:31:00Z"
modified_by: Jane Doe
synced_at: "2026-07-23T14:00:00Z"
pdf: ./Roadmap.pptx.pdf
---
```

### How each kind of file is handled

| Source | What you get |
|---|---|
| docx, doc, csv, odt/odp, msg, txt, md, html, json, sarif, xml, yaml, log | one markdown file |
| xlsx, xls, xlsm, ods | the workbook, plus markdown holding its cell text |
| loop, fluid, whiteboard | one markdown file, rendered by Graph since the page holds no text of its own |
| pptx | markdown for the text, plus a PDF of the slides (markdown alone when the source will not render it) |
| ppt, rtf | a PDF, plus markdown read back from it |
| pdf | the original, plus markdown holding its text layer |
| ics | one markdown record of the meeting: what it is called, when, where, who was asked |
| eml | a folder: the message as markdown, and every file it carried taken out of the base64 it travelled in |
| zip | a folder, one markdown file per document inside, and the archive itself |
| jpg, png, gif, webp, bmp, tiff, heic | the image, plus markdown holding the text read out of it |
| svg | the file, plus a markdown note pointing at it |
| anything else | left in SharePoint and named in `_sync-report.md` |

A workbook is kept as it came as well as read. The conversion yields cell text and nothing else, so
a formula, a second sheet, a number format and a chart survive nowhere but the file itself; the
markdown names it under `original:`. Every other document kind is markdown alone, since for text the
markdown is the content.

A saved email is unpacked the way an archive is. The library has no parser for raw MIME and hands
the file back whole, which means every attachment sits in the middle of the text as base64, so the
message is read here instead: the header block, the text in whatever encoding a 7-bit transport
forced on it, and each file it carried written as a file and converted like any other. A file of a
kind nothing can read keeps the file and loses only the text.

A meeting invitation is read rather than kept. What survives is the summary, the time exactly as the
invitation states it (no timezone is converted, since there is no zone database here to do it with),
the location, the organiser, everyone asked, the recurrence rule, and whether the invitation is a
cancellation. What goes is the block of daylight-saving rules, the vendor properties, and the
description, which repeats the mail the invitation rode in on.

A picture inside a document does not survive the conversion to markdown: it becomes a bare
`[image]`, usually with no alt text, so an architecture diagram contributes one word that says
nothing. Word and Excel files are therefore also asked for the pictures they embed, which land in a
`<name>.media/` folder beside the markdown and are listed under an `## Images` heading at its end.
Each is read for its text the same way a photo in a library is, so the labels inside a diagram
become searchable; with `--no-ocr` the pictures are still kept, just without the reading. The
placeholders are unnumbered, so the section sits at the end rather than pretending to know where in
the prose each picture stood.

This holds on both sides of the sync: a Word file attached to a mail loses its diagrams exactly the
way one sitting in a library does, so it is asked the same question, and the pictures land in the
same `<name>.media/` folder beside the same markdown. They are not named in the head of the thread,
which lists what each message carried: the document's own markdown links them, and a Word file with
a dozen diagrams would otherwise put a dozen lines at the top of a conversation.

Only those two kinds are asked. A PDF is kept whole beside its markdown and a deck is rendered to
one, so their pictures are already on disk in openable form: taking them out again would duplicate
what is there, and it costs the most exactly where it buys the least, since one 14 MB manual answers
with 172 images and tens of minutes of reading. Legacy `doc`, `xls` and `ppt` are refused by the
source, and a plain-text kind has nothing embedded to ask about.

A document carries more than the text it shows. Every conversion, in SharePoint and on mail
attachments alike, also asks for the side channel the rendered body hides: comments and threaded
replies, tracked insertions and deletions, hidden text, external hyperlinks, and a flag for embedded
macros. It arrives as a metadata section under the document's text. Office formats (and their
macro-enabled and template variants) and OpenDocument carry one; on every other kind of file there
is nothing to add and the request changes nothing.

### What did not make it in

Anything left behind is named in `_sync-report.md` beside the source it came from, newest run
first: files of a kind this tool does not read, files above the size cap, files locked with a
password, files that could not be read (which are tried again on the next run), and files moved
aside because the source no longer has them. A password is the one refusal that never becomes
readable by trying again, so such a file is left out the way an unsupported type is, rather than
queued afresh on every run. A run that converted everything writes nothing there, so a nightly sync does not bury
the runs that did leave something behind.

`kb/_sync-report.md`, one level up, holds the same thing for the run as a whole, so twenty sources
do not mean twenty files to open. It is rewritten on every run rather than appended to, and always
covers every source: the ones the run touched get their counts and their lists, and every other
source already in `kb/` is named with the date it last ran, so a source that was not rechecked is
never mistaken for one with nothing wrong. A run that left something behind ends with a line on the
terminal saying so and naming the file. Its history is the per-source files; this one is the current
view. A dry run writes neither.

### What a mailbox sync writes

```
kb/
  Mailbox/
    .sync-state.json                a cursor per folder, and what every conversation produced
    _sync-report.md                 what did not make it in, and why
    _attachments/                   every file a mail carried, stored once by content
    _linked/2026-05-11/             SharePoint files the mail pointed at, each pulled once,
                                    filed under the day the file itself last changed
    threads/2026-05-20/                               the day the conversation was last active
      Contrat Contoso a3f9c1.md                       the whole conversation, oldest message first
```

One file per conversation, not per message, named for its subject and a fingerprint of the thread so
two conversations sharing a subject keep their own files. The folder is the day of the conversation's
**latest** message, so a thread sorts by when it was last active rather than when it began. That means
a reply moves the file into the new day's folder: the conversation stays one file, but its path
changes as the thread continues, so do not link to it by path from outside `kb/`.
Every folder is swept except Junk, Deleted Items, Drafts and Outbox, which means **the mail you
sent is included**: Sent Items is a folder like any other, and a conversation is assembled from
every folder its messages landed in. Quoted reply chains are stripped, since the message being
quoted is already its own section.

A SharePoint file a mail merely points at is pulled too, once, into `_linked/`. It takes the same
route as a file found by sweeping a library, so it is filed under the day it last changed and keeps
the folders it sat in, a linked deck arrives as a PDF as well as its text, a linked image is kept
beside the text read out of it, and a linked file above the size cap is left where it is. Each is
stamped with its own SharePoint address, so the link in the front matter opens the original.

Attachments follow the same conversion rules as SharePoint files, a zip included: it is kept and
also unpacked, one markdown file per document inside. Every attachment is stored once in the shared
`_attachments/` folder, addressed by the SHA-256 of its bytes, so a file sent across many threads is
converted a single time and every conversation after the first references the copy already on disk.
Each is stored under its own name plus a short slice of that address (`Contrat-a3f9c1b2.docx`), which
fixes the name to the bytes so conversations rendering in parallel never collide on disk.

Each message's own section names the files that message carried, linking where each landed, so a
reader following a conversation sees what arrived with which reply rather than one list at the head
of the file. A picture pasted into a message is shown where it stood rather than named, and is listed
under `inline_images` in the front matter instead of among the attachments, so a signature logo does
not read as a document somebody sent. A file that was left alone keeps its name in that list with
the reason beside it, and a picture nothing could be matched to is named as a file rather than
dropped, so nothing a message carried goes unmentioned.

A first mailbox run is slow: Outlook hands back changes ten messages at a time and there is no way
to ask for more, so a mailbox with thousands of messages takes thousands of round trips. Later runs
are cheap, reading only what changed. `--since` narrows what gets *written*, not what gets swept.

While it works, a counter on the terminal shows how far it has got, so a long run is never silent. A
header row carries the count, and every item still being read from the source gets a row of its own
beneath it, naming the step it is on:

```
SW Project (Lidl instance) / 文档  4/25 (8 running)
  Projets/PT Findings.xlsx · reading picture 3/6
  General/04_IT_Security_overview/Overview.docx · rendering the slides
```

The block rewrites itself where it stands as items come and go, so one slow file does not look like
the run has stopped while its `--concurrency` siblings finish around it. Set `--concurrency` higher
than the terminal has rows and the overflow collapses into a single `…and N more` row, so the block
never outgrows the screen. It draws only when stderr is a terminal, so piping the output to a file or
running headless leaves no counter behind.

## Re-running

Each run stores the cursor Graph gives it, so a second run reads only what changed: an unchanged
library converts nothing. State is written after every single file, so stopping a run mid-way
(Ctrl-C) loses at most the file in flight, and the next run picks up from the same place. A file
renamed in SharePoint is moved on disk rather than converted again; a file deleted there has its
markdown moved into `kb/_archive/`, as does the older copy of a file that was edited and so now
belongs under a later day.

`kb/` is generated content and is gitignored.

## Configuration

Read once at startup, in `src/composition/config.ts`:

| Variable | Meaning | Default |
|---|---|---|
| `KB_ROOT` | Folder the knowledge base is written to | `kb` |
| `KB_LOG_LEVEL` | Winston level; logs go to stderr, output to stdout | `error` |

## Development

This repo follows the atelier standard: Clean Architecture, TDD with hand-written fakes,
`Result<T, E>` at every IO boundary. See `CLAUDE.md`.

```bash
bun test            # test suite
bun run lint        # fast rules, zero warnings allowed
bun run lint:strict # adds the type-aware rules (pre-commit gate)
bun run typecheck   # tsc --noEmit
bun run coverage    # per-tier gate: 100% domain and use-cases, 80% elsewhere
bun run mutate      # Stryker, break threshold 90
```

Delete `reports/stryker-incremental.json` before trusting a mutation score after adding tests:
the incremental cache does not notice new test files.

### Layout

```
src/
  domain/        pure logic: paths, front matter, conversion planning, delta diffing, state
  use-cases/     orchestration against ports; ports/ holds the port types
  infra/         adapters: the Graph library, Bun filesystem, RapidOCR, Winston, stdin
  presenter/     pure renderers plus the single stdout writer
  composition/   option parsing, configuration, dependency wiring
  test-helpers/  hand-written fakes and builders
  main.ts        entry point, the one top-level catch
```
