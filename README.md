# MOOV knowledge base

A Bun CLI that mirrors Microsoft 365 content into a local `kb/` folder as markdown, so agents
running on this machine can read company knowledge without calling Microsoft Graph themselves.

Today it syncs **SharePoint document libraries**. Mailbox sync (conversations with their
attachments and linked files) is designed but not built yet; see `.claude/PLAN.md`.

Graph access goes through [`ask-marcel-office-cli`](https://www.npmjs.com/package/ask-marcel-office-cli)
used as a library, which owns authentication, paging and document conversion. See
[docs/marcel-library-map.md](docs/marcel-library-map.md).

## Requirements

- [Bun](https://bun.sh) 1.2 or newer
- A Microsoft 365 account already signed in: run `ask-marcel-office login` once (a browser opens)
- `paddleocr` on PATH to read text out of images (optional; without it images are still copied)

## Install

```bash
bun install
```

## Run

```bash
bun run sync
```

Lists every SharePoint site you can read, marking the ones already in `kb/` with when they last
synced and how many files they hold. Pick a number, pick one or more libraries, and it syncs.

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
| `--dry-run` | Report what would be done and write nothing |
| `--max-size-mb <n>` | Skip files larger than this (default 50) |
| `--no-ocr` | Do not read text out of images |
| `--ocr-lang <code>` | Language used to read images (default `en`) |

## What lands in `kb/`

```
kb/
  _archive/<Site>/<Library>/...     files whose source was deleted or renamed away
  <Site>/
    .sync-state.json                what has been synced, and where the next run resumes
    <Library>/
      <SharePoint folders mirrored>/
        Roadmap.pptx.md             slide text
        Roadmap.pptx.pdf            the rendered deck
        Contrat.pdf                 the original
        Contrat.pdf.md              its text layer
```

Every generated markdown file opens with where it came from:

```yaml
---
source: https://tenant.sharepoint.com/sites/X/Roadmap.pptx
site: Espace MOOV
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
| anything else | left in SharePoint and reported |

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
| `MOOV_KB_ROOT` | Folder the knowledge base is written to | `kb` |
| `MOOV_KB_LOG_LEVEL` | Winston level; logs go to stderr, output to stdout | `error` |

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
  infra/         adapters: the Graph library, Bun filesystem, PaddleOCR, Winston, stdin
  presenter/     pure renderers plus the single stdout writer
  composition/   option parsing, configuration, dependency wiring
  test-helpers/  hand-written fakes and builders
  main.ts        entry point, the one top-level catch
```
