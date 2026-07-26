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
| `--ocr-lang <code>` | Language used to read images and scanned PDFs (default `en`) |

## What lands in `kb/`

```
kb/
  _archive/<Site>/<Library>/...     files whose source was deleted or renamed away
  <Site>/
    .sync-state.json                what has been synced, and where the next run resumes
    _sync-report.md                 what did not make it in, and why (only when there is something)
    <Library>/
      <SharePoint folders mirrored>/
        Roadmap.pptx.md             slide text
        Roadmap.pptx.pdf            the rendered deck
        Contrat.pdf                 the original
        Contrat.pdf.md              its text layer
```

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
| docx, doc, xlsx, xls, csv, odt/ods/odp, msg, txt, md, html, json, xml, yaml, log | one markdown file |
| pptx | markdown for the text, plus a PDF of the slides |
| ppt, rtf | a PDF, plus markdown read back from it |
| pdf | the original, plus markdown holding its text layer |
| zip | a folder, one markdown file per document inside, and the archive itself |
| jpg, png, gif, webp, bmp, tiff, heic | the image, plus markdown holding the text read out of it |
| svg | the file, plus a markdown note pointing at it |
| anything else | left in SharePoint and named in `_sync-report.md` |

### What did not make it in

Anything left behind is named in `_sync-report.md` beside the source it came from, newest run
first: files of a kind this tool does not read, files above the size cap, files that could not be
read (which are tried again on the next run), and files moved aside because the source no longer
has them. A run that converted everything writes nothing there, so a nightly sync does not bury
the runs that did leave something behind.

### What a mailbox sync writes

```
kb/
  Mailbox/
    .sync-state.json                a cursor per folder, and what every conversation produced
    _sync-report.md                 what did not make it in, and why
    _attachments/                   every file a mail carried, stored once by content
    _linked/                        SharePoint files the mail pointed at, each pulled once
    threads/2026/
      2026-05-12 Contrat Contoso a3f9c1.md            the whole conversation, oldest message first
```

One file per conversation, not per message. Its name is the day the thread started, its subject,
and a fingerprint of the thread, so a reply rewrites the same file instead of making a new one.
Every folder is swept except Junk, Deleted Items, Drafts and Outbox, which means **the mail you
sent is included**: Sent Items is a folder like any other, and a conversation is assembled from
every folder its messages landed in. Quoted reply chains are stripped, since the message being
quoted is already its own section.

Attachments follow the same conversion rules as SharePoint files, a zip included: it is kept and
also unpacked, one markdown file per document inside. Every attachment is stored once in the shared
`_attachments/` folder, addressed by the SHA-256 of its bytes, so a file sent across many threads is
converted a single time and every conversation after the first references the copy already on disk.
Each is stored under its own name plus a short slice of that address (`Contrat-a3f9c1b2.docx`), which
fixes the name to the bytes so conversations rendering in parallel never collide on disk.

A first mailbox run is slow: Outlook hands back changes ten messages at a time and there is no way
to ask for more, so a mailbox with thousands of messages takes thousands of round trips. Later runs
are cheap, reading only what changed. `--since` narrows what gets *written*, not what gets swept.

While it works, a counter on the terminal shows how far it has got (`Converting 128/6002 …`), so a
long run is never silent. The line names whatever is still being read from the source, not just the
last item that finished, so one slow file does not look like the run has stopped while `--concurrency`
siblings finish around it. It draws only when stderr is a terminal, so piping the output to a file or
running headless leaves no counter behind.

## Re-running

Each run stores the cursor Graph gives it, so a second run reads only what changed: an unchanged
library converts nothing. State is written after every single file, so stopping a run mid-way
(Ctrl-C) loses at most the file in flight, and the next run picks up from the same place. A file
renamed in SharePoint is moved on disk rather than converted again; a file deleted there has its
markdown moved into `kb/_archive/`.

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
