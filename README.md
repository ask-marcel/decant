# decant

Pour your Microsoft 365 into plain markdown, sediment left behind.

A Bun CLI that mirrors Microsoft 365 content into a local `kb/` folder as markdown, so agents
running on this machine can read company knowledge without calling Microsoft Graph themselves.

To decant is to pour the wine off the sediment. That is the job: Outlook's link wrappers were a
third of one vault by weight, a notification's icons are named by machine ids nothing can read, and
a picture's words belong under the picture rather than in a file of their own. What lands in `kb/`
is what a reader, or an agent, can actually use.

It syncs **SharePoint document libraries** and your **Outlook mailbox**, the latter as one markdown
file per conversation with its attachments and the SharePoint files it links to.

Graph access goes through [`ask-marcel-office-cli`](https://www.npmjs.com/package/ask-marcel-office-cli)
used as a library, which owns authentication, paging and document conversion. See
[docs/marcel-library-map.md](docs/marcel-library-map.md).

## Requirements

- [Bun](https://bun.sh) 1.2 or newer
- A Microsoft 365 account already signed in: run `ask-marcel-office login` once (a browser opens)
- Python 3 with [`rapidocr`](https://pypi.org/project/rapidocr/) installed, to read text out of images and scanned PDFs (optional; without it the files are still copied). It fetches the models it needs on first use, one per language it reads in

## Install

```bash
bun add --global decant
decant --help
```

Or run it without installing anything:

```bash
bunx decant
```

To work on it instead, clone the repo and `bun install`; `bun test` runs the suite.

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
| `--ocr-lang <code>` | Force one language for images and scanned PDFs (default `auto`, chosen per image) |
| `--timezone <zone>` | IANA zone the mailbox counts its days in, e.g. `Asia/Shanghai` (default: this machine's) |

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
| zip | a manifest listing every member with the text read out of it, one markdown file per document inside, and the archive itself |
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

The language an image is read in is chosen per image, not per run. Nothing about a file says which
language it holds, so the run finds out by reading it twice. The first reading uses the widest
dictionary RapidOCR ships, which holds ideographs, both Japanese syllabaries and accented Latin at
once, so it can say what the image is written in. That reading is then thrown away and the image is
read again by the model built for what it found: Chinese, Japanese, or Latin, the last covering the
accented characters Dutch, French and German need and keeping the spaces between words that a
Chinese model runs together. The model that recognises everything is the best at nothing, which is
why it only ever decides and never answers.

Each markdown companion records the model that read it, as `ocr: rapidocr (ch)`, `(japan)` or
`(latin)`. An image holding no text at all is read only once, since there is no script to get right.
What each image read to is kept under `kb/_meta/ocr`, addressed by the image's own bytes, so it is
read once and never again: a picture renamed, moved, or arriving a second time as somebody else's
attachment answers from the same entry, and a re-sync costs no interpreter starts at all. The
language is part of the address, so forcing one never reads back what a previous run decided for
itself. Only successful readings are kept, since a failure says something about the machine rather
than about the image.

Pass `--ocr-lang` with a RapidOCR language (`ch`, `en`, `japan`, `korean`, `cyrillic`, ...) to force
one for the whole run and skip the deciding pass. A language RapidOCR does not have is refused
straight away, with the accepted ones listed, rather than failing once per image.

Korean is the one script the deciding pass cannot recognise: no model that reads Korean also reads
anything else, so the first reading returns Chinese-looking nonsense for a Korean page instead of
returning nothing. Sync a Korean source with `--ocr-lang korean` and it reads correctly.

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
    _inline/                        pictures pasted into messages, stored once for the mailbox
                                    and named by content, since one signature logo rides on
                                    every message its sender ever wrote
    threads/2026-05-12-ca0df2c95a-contrat-contoso/    the day it began, its id, what it is about
      contrat-contoso.md                             the whole conversation, oldest message first
      _attachments/Contrat.docx                      a file a message carried, under its own name
      _attachments/Contrat.docx.md                   its card: who sent it, when, and its text
      _linked/Rapport.docx                           a SharePoint file a message pointed at
      _linked/Rapport.docx.md                        its card: the address, the version, its text
    _meta/threads.jsonl                              one line per thread, for querying
    _meta/attachments.jsonl                          one line per stored file, by content address
    _meta/links.jsonl                                one line per document pointed at
```

A thread folder is self-contained: everything a conversation carried or pointed at sits inside
it, beside a card that says how it arrived. The one exception is a picture pasted into a message,
which lives in `_inline/` for the whole mailbox, because a signature logo rides on every message
its sender ever wrote and a copy per thread would write the same hundred kilobytes two hundred
times. Everything else is written into every thread that received it. That is the trade this
layout makes on purpose: a report sent to ten threads is stored ten times, and no folder has to
reach into another to be read.

The card and the file share a name. `Contrat.docx.md` carries what belongs to the arrival, who
sent it, when, under which message, and the text read out of the file, so a reader opening the
folder finds one document per thing rather than a card and an extract saying the same. When the
file itself was kept, a workbook or a PDF, the card names it under `original:` and links it. Two
files of one name in a single thread, a form resent after correction being the usual way, are
both kept and the second is numbered. A card is still written for a file too large to fetch or of
a kind nothing reads, since it is the only record that the thread depended on something the
knowledge base does not hold; a file nothing can read that is also named by a machine id, the
icons a sharing notification is built from, is dropped without a card, a line or a report entry,
there being no fact left to record.

One file per conversation, not per message, in a folder named once and never renamed: the day of
its **first** message, a ten-character id, and a readable slug of its subject. A reply appends to
the document and leaves the folder alone, so a path into `kb/` keeps working. Recency lives in
`last_message` in the front matter, not in the path.

The id is a hash of the thread's root `Message-ID`, taken from the `References` header of its
oldest message, rather than Graph's `conversationId`. `conversationId` is scoped to one mailbox,
so a shared mailbox and a personal one see different values for the same message, and Graph
reassigns it when an external party replies from outside Exchange.

That last case is why it matters: Graph opens a **second conversation for the same exchange**, and
both resolve to the same root, so both are written into one document. Every conversation a thread
was assembled from is listed as `conversation_id` in the front matter, and nothing is keyed on it.

Which thread a conversation belongs to is settled once, before anything is written, and never
revisited. A message arriving late, older than anything already held, would otherwise answer with
a different root and rename a folder already on disk. A conversation whose headers cannot be read
is left unresolved and retried on the next sweep rather than filed under a guess.

The day is counted in the zone given by `--timezone`, defaulting to this machine's. Every
timestamp Graph returns is UTC, so a message received at 16:40Z is the next day in a UTC+8 tenant,
and the folder name is written once.

Every folder is swept except Junk, Deleted Items, Drafts and Outbox, which means **the mail you
sent is included**: Sent Items is a folder like any other, and a conversation is assembled from
every folder its messages landed in. Quoted reply chains are stripped, since the message being
quoted is already its own section.

A SharePoint file a mail merely points at is pulled too, into the thread's own `_linked/`, flat,
beside its card. The card records the address at the source, when the document last changed and
who changed it, and carries its text, so a thread can be traced to a version of a document and
not only to its name. A linked deck arrives as a PDF as well as its text, and a linked file above
the size cap is left where it is with a card saying so. What somebody shares is as often a folder
as a file: a folder gets a card that says a folder was shared, and no entry in the report, since
nothing went wrong.

Each message's own section names the files that message carried, linking each card, so a reader
following a conversation sees what arrived with which reply rather than one list at the head of
the file. A picture pasted into a message is shown where it stood, or after the text when the
conversion lost the placeholder that said where, and never listed as a file somebody sent. What
was read out of it is quoted under it, behind one line saying the words were read by a machine
and may be wrong: OCR read `pe` off a logo saying something longer, and without that line the
two letters read as text somebody wrote. A picture under 10 KB is not read at all. Measured across
one mailbox, everything OCR found real words in was 64 KB or more and everything under ten was a
logo, so the threshold costs no content and saves a twenty-second pass per logo.

A saved email attached to a message is unpacked into a folder of its parts, and its card shows
its pictures where the message showed them, read the same way, and lists every file it carried
under **Carried by this message:**, linking the reading where one was made and the file where it
was not.

Every link a message carries is written as the address the sender sent. Outlook rewraps each one
through its own scanner with a per-recipient tracking blob after it, and measured across one
mailbox that wrapper was a third of everything written and left no link readable. Unwrapping
means a click from the vault reaches the destination without Outlook's check at click time; this
is an archive of what was sent, and what was sent is the destination.

The head of each thread names where the file itself lives under `path:`, so a thread pasted into
a context window can still be resolved and traced back, and lists every participant with the
address you would reply to. Message headings keep names alone, since one heading already runs
to eleven recipients.

`_sync-report.md` holds only what a reader should look into. A run in which every file arrived
writes the counts and the line "Nothing was left behind." A file left out says which kind it was,
a `.mp4` this tool does not read, or that its name had no extension so nothing could tell.

A first mailbox run is slow: Outlook hands back changes ten messages at a time and there is no way
to ask for more, so a mailbox with thousands of messages takes thousands of round trips. Later runs
are cheap, reading only what changed. `--since` narrows what gets *written*, not what gets swept.

While it works, a counter on the terminal shows how far it has got, so a long run is never silent. A
header row carries the count, and every item still being read from the source gets a row of its own
beneath it, naming the step it is on:

```
SW Project (Fabrikam instance) / 文档  4/25 (8 running)
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
