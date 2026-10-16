# decant

Pour your Microsoft 365 into plain markdown, sediment left behind.

A Bun CLI that mirrors Microsoft 365 content into a local `kb/` folder as markdown, so agents
running on this machine can read company knowledge without calling Microsoft Graph themselves.

To decant is to pour the wine off the sediment. That is the job: Outlook's link wrappers were a
third of one vault by weight, a notification's icons are named by machine ids nothing can read, and
a picture's words belong under the picture rather than in a file of their own. What lands in `kb/`
is what a reader, or an agent, can actually use.

It syncs **SharePoint document libraries**, your **Outlook mailbox** (one markdown file per
conversation, with its attachments and the SharePoint files it links to), your **Microsoft To Do
lists** (one markdown file per task), the **channels of the Teams you belong to** (one markdown
file per post, with its replies beneath it), the **people directory** (one markdown file per
colleague, plus the org chart), your **Outlook calendar** (one markdown file per event, with what
it carried beside it), the **OneNote notebooks** of your sites and your own (one markdown file
per page), the **lists of your SharePoint sites** (one markdown table per list) and your
**Planner plans** (one markdown file per task under its bucket, plus the board as one table).

Graph access goes through [`ask-marcel-office-cli`](https://www.npmjs.com/package/ask-marcel-office-cli)
used as a library, which owns authentication, paging and document conversion. See
[docs/marcel-library-map.md](docs/marcel-library-map.md).

## Requirements

- [Bun](https://bun.sh) 1.2 or newer
- A Microsoft 365 account. If you are not signed in, `decant` opens a browser where you sign in
- Python 3 with [`rapidocr`](https://pypi.org/project/rapidocr/) installed, to read text out of images and scanned PDFs (optional; without it the files are still copied). It fetches the models it needs on first use, one per language it reads in

## Install

The package on npm is `ask-marcel-decant`. The command that it installs is `decant`.

```bash
bun add --global ask-marcel-decant
decant --help
```

Or run it without installing anything:

```bash
bunx ask-marcel-decant
```

To change the code, clone the repo and run `bun install`. In a clone, `bun run sync` replaces
`decant` in the commands below. `bun test` runs the suite.

## Run

```bash
decant
```

Lists what you can read, grouped by what it is: the SharePoint sites, the Loop workspaces, your
OneDrive, the inboxes of the Microsoft 365 groups you belong to, your Microsoft To Do lists, the
Teams you are a member of, the OneNote notebooks of those sites and your own, the lists of those
sites, and the Planner plans of the groups you belong to. Each is marked with when it last synced
and how much it holds. Pick a
number and one or more libraries (or, for a Team, one or more channels), press `m` for your
mailbox, `c` for your calendar or `p` for the people directory, and it syncs.

Your Loop workspaces are on that list too, shown as `Loop - <workspace>`. A workspace keeps its
pages in a container no site listing returns, so they are found through the `.pod` manifest each one
carries; from there a workspace is synced exactly like a site, and `update` refreshes it with the
rest. A workspace nobody has opened may be missing from the index for a while: sync it by container
id with `--site-id` when that happens.

Several sites can be taken at once: `1,3` for those two, or `all` for every source on the list. `all`
also takes your mailbox, your calendar and the people directory, after the numbered sources. Taking
more than one site takes every library in each without asking, since the point of choosing them
together is not being asked once per site. Each site is summarised as it finishes.

To refresh everything already synced, without being asked anything:

```bash
decant update
```

That form is safe to schedule: it never opens a browser, and a lapsed sign-in ends the run with a
clear message instead of waiting for input. Any other source that fails is named as it fails, listed
in `kb/_sync-report.md` under the ones to try again, and passed over, so the sources after it are
still refreshed.

The exit code tells a script how the run ended:

| Code | Meaning |
|---|---|
| 0 | The run finished, and no item failed. |
| 3 | The run finished, and one or more items failed. `kb/_sync-report.md` names them. |
| 1 | The run stopped before the end, for example because the sign-in lapsed. |
| 2 | decant did not accept the options. |

A script that copies the knowledge base after each run (a backup, or a commit to git) can continue
after 0 and after 3.

### How far back

The first run that has something to sync asks how far back to reach: a day such as `2025-01-01`, or
`all`. The answer is kept in `kb/.decant.json`, and every later run reaches back to the same day
without asking, `update` included. From that day on, decant syncs mail, group inboxes, Teams posts,
the calendar, library files and OneNote pages, each by its own date: a message by the day it
arrived, a group thread by its last post, a post or a page by its last change, a file by its last
edit, an event by the day it starts (a recurring series is kept whatever day it began, since it may
be running still). To Do lists, Planner plans, SharePoint lists and the people directory always
come whole: they say how things stand now, and a board missing its old open tasks would mislead.
decant finds these dates in UTC, and the dates of calendar events in the zone of the knowledge base
(see Time zone).

To move the day, run once with `--since`, which keeps the new day for every run after it:

```bash
decant update --since 2024-06-01
```

Moving the day earlier fetches what the narrower reach left out, on each source's next run: a source
that keeps a cursor reads it out first, so nothing deleted since the last run goes unnoticed, then
reads the whole source once and writes only what it had left out. Moving the day later deletes
nothing: what is already in `kb/` stays. `update` and a run that names a source by flag never ask;
with no day kept yet, they reach everything. Clearing `kb/` clears the day with it, and the next run
asks again. A day that cannot be read, mistyped by hand in `kb/.decant.json`, stops the run rather
than syncing everything; `--since` sets it again.

### Time zone

decant uses one time zone for each knowledge base. The zone sets these values:

- the day folder of a mail thread
- the time of each message in a thread note
- the start and the end of a calendar event
- the due day and the completed day of a task
- the day folder of a Teams post
- the days on each `_index.md` page.

decant keeps the zone in `kb/.decant.json`, together with the day from How far back. Each later run
uses the kept zone, also on a machine in a different zone. With no zone kept, a run uses the zone of
the machine. Thread notes and calendar notes give the zone in their `timezone:` line.

To change the zone, run one time with `--timezone`. decant keeps the new zone for all later runs:

```bash
decant update --timezone Asia/Shanghai
```

A dry run keeps nothing. The change does not move a thread folder that is already in `kb/`.

### Options

| Option | Meaning |
|---|---|
| `--site-id <id>` | Sync this site without showing the picker |
| `--site-url <url>` | Sync the site at this address, for sites the search index does not list |
| `--drive-id <id>` | Sync only this library; repeat for several |
| `--mailbox` | Sync your Outlook mailbox without showing the picker |
| `--people` | Sync the people directory, everyone in your Teams, without the picker |
| `--calendar` | Sync your Outlook calendar without showing the picker |
| `--group-id <id>` | Sync one group inbox without the picker, by its id or its address |
| `--todo-list <name>` | Sync one To Do list without the picker, by its name or its id |
| `--team <name>` | Sync every channel of one Team without the picker, by its name or its id |
| `--notebook <name>` | Sync one OneNote notebook without the picker, by its name or its id |
| `--lists <site>` | Sync the lists of one SharePoint site without the picker, by its name, its id or its address |
| `--plan <title>` | Sync one Planner plan without the picker, by its title among the plans listed or by its id |
| `--since <day\|all>` | Reach back to this day (`2026-01-31`), or through everything, and keep it for every later run (see How far back) |
| `--out <folder>` | Write the knowledge base to this folder (default `kb`). This option has priority over `KB_ROOT`. Use the same folder for each run, because the sync state is in that folder |
| `--dry-run` | Report what would be done and write nothing |
| `--max-size-mb <n>` | Skip files larger than this (default 50) |
| `--concurrency <n>` | How many items to convert at once (default 4); `1` is strictly sequential |
| `--no-ocr` | Do not read text out of images or scanned PDFs |
| `--refresh` | List the sites afresh instead of drawing the picker from the ones last seen |
| `--ocr-lang <code>` | Force one language for images and scanned PDFs (default `auto`, chosen per image) |
| `--timezone <zone>` | IANA zone of the knowledge base, for example `Asia/Shanghai`. decant keeps it for all later runs (see Time zone). Default: the kept zone, or the zone of this machine |

## What lands in `kb/`

```
kb/
  .decant.json                      how far back the runs reach (a day, or all), and the time zone
  _sync-report.md                   what the last run left behind, every source in one file
  .sync-aside.json                  files let go that did not move to _archive/ (see Re-running)
  _archive/2026-10-13/...           the earlier copy of each file, under the day of the run that
                                    moved it: deleted at the source, renamed, moved, or replaced by
                                    an edit (a second copy of one path that day goes under 2026-10-13-2/)
  SharePoint sites/<Site>/
    .sync-state.json                what has been synced, and where the next run resumes
    .sync-cursor.json               when the last run ran, and the delta cursors (see Re-running)
    _sync-report.md                 what did not make it in, and why (only when there is something)
    _members.md                     who can open the site
    <Library>/
      _index.md                     every document, the one changed last first
      <SharePoint folders mirrored>/
        Roadmap.pptx.md             slide text
        Roadmap.pptx.pdf            the rendered deck
        Contrat.pdf                 the original
        Contrat.pdf.md              its text layer
        Contrat.docx.md             the text, plus a section listing the pictures inside
        Contrat.docx.media/         those pictures, kept as files
  Loop workspaces/<Workspace>/      the same shape, for a Loop workspace
  OneDrive/<Owner>/                 the same shape, for a personal OneDrive
  Group inboxes/<Group>/            a group's conversations (see the mailbox layout below)
  Mailbox/                          your own Outlook mailbox
  Calendar/
    .sync-state.json                every event filed
    2026-09-12/                     the day each event starts
      Offsite planning.md           the event: when, where, who, how to join, what it is about
      Offsite planning.attachments/ what the invitation carried, as markdown
  People/
    .sync-state.json                who is filed, and a fingerprint of what each page was made of
    _org-chart.md                   everyone under their manager, linked to their pages
    Jane Doe.md                     one page per colleague
  To Do/<List>/
    .sync-state.json                which tasks are filed, and what each one last looked like
    _index.md                       the open tasks by due day, then the completed ones
    2026-09-12/                     the day each task is due
      Book the venue.md             the task, its notes, its steps and what it links to
    undated/                        the tasks with no due day
  OneNote/<Notebook>/
    .sync-state.json                every page filed, and what it last looked like
    <Section group>/<Section>/      the notebook's own structure
      Kick-off.md                   one page
  SharePoint lists/<Site>/
    .sync-state.json                every list filed, and a fingerprint of what its table was made of
    Projects.md                     one table per list
  Planner/<Plan>/
    .sync-state.json                every task filed, and the etags its page was made from
    _board.md                       the whole plan as one table, linking each task
    <Bucket>/
      Book the venue.md             one task, under the lane it sits in
  Teams/<Team>/
    .sync-state.json                every post filed
    <Channel>/
      _index.md                     every post, the latest activity first
      2026-09-10/                   the day each post was first posted
        Venue for the offsite.md    the post and its replies, as one thread
```

Sources are shelved under the same headings the picker offers them under, so a source is found again
under the heading it was chosen from. A Microsoft 365 group is a site and an inbox wearing one title,
and the two halves land on different shelves: its documents under `SharePoint sites/`, its
conversations under `Group inboxes/`. Reports and summaries still spell out `(group inbox)` after the
name, where a bare name would leave a reader guessing which half they are reading.

Each document goes in the folders that it has in SharePoint. There is no day folder. Thus the path of
a document changes only when you rename or move the document at the source, and links to it continue
to work. The `_index.md` file of each library lists the documents, with the document that changed
last at the top. Each line shows the day of the change, the path as a link, and the person who made
the change.

When you rename or move a document at the source, decant converts it again at its new path. Thus
the front matter, the `source:` link and the links to its pictures show the new place. The earlier
files of the document go to `_archive/`.

When you rename or move a folder, Microsoft Graph sends the folder only, and not the documents in
it. Thus the state of each library keeps its folders by id. decant reads each document under the old
path of the folder again by id, and converts it at its new path. A document that Graph no longer has
goes to `_archive/`.

The first run of this version reads each library whole one time, to record its folders. When decant
reads a library whole, it gets a list of each document of the library. Thus decant moves to
`_archive/` each recorded document that is not in that list, and the report names it with `no
longer at the source`. OneDrive for Business does not send the name of a deleted document, and
older versions of decant did not see such a deletion. Thus this first run moves these documents to
`_archive/`. A run with an earlier `--since` day also reads each library whole and compares the
result with the state.

Before an edit replaces a document, a task or a Teams post, decant moves the earlier version to
`_archive/<day of the run>/`. There, it keeps the path that it had in `kb/`. A file that you delete,
rename or move at the source goes there too. If the folder of that day already holds the path,
decant uses `<day>-2`, then `<day>-3`. Thus decant never writes over an archived copy, and the
knowledge base keeps each earlier version without git. A move also deletes each folder that it makes
empty.

The first run after an update to this layout moves the files to their new places. This applies to
each library, each To Do list and each Teams channel. These moves do not go to `_archive/`. A file
can stay at its old place, for example because another program has the file open. Then the state
keeps the file at that place, and the next run moves it. decant never moves a file over another file.

Two different SharePoint sites can share a display name (most often an unedited template title). The
picker shows each one's address alongside the name so they can be told apart before choosing, and if
a sync would otherwise land in a folder another site's `.sync-state.json` already claims, it is
written under a disambiguated one instead (`<Site>-<hash>/`) rather than merging into it.

### Names on disk

decant makes each name safe on Windows, macOS and Linux:

- A character that Windows does not accept in a name (`/ \ : * ? " < > |`) becomes `_`.
- A name that Windows keeps for a device (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to
  `LPT9`) gets `_` after it, also with an extension: `nul_.txt`.
- A name that git reads as its own (`.git`, `.gitignore`, `.gitattributes`, `.gitmodules`) gets `_`
  in front of it.
- Windows and macOS read two names that differ only in letter case as one file, so the second name
  gets a suffix. An item whose title changes only in letter case keeps its file.
- The name of a To Do task is the first 80 characters of its title, cut at the end of a word. The
  heading of the note has the full title.
- The pictures of a document are numbered in sequence: `image-01.png`, `image-02.jpeg`.

Windows does not accept a path longer than 259 characters, counted from the drive letter, unless
long paths are on for the whole machine. decant measures where the export folder is on the disk and
cuts a name when its path is too long. The cut name keeps its extension and gets 8 characters
of a hash of the full name, for example `Contrat de service avec le fournis-4db6e62d.docx.md`.
decant keeps room below each name for what it adds later, such as the pictures of a document and
the `_archive/` folder. If a write still fails because its path is too long, the report gives the
length of the path.

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
| url | one markdown file linking where the shortcut goes, when that is a web address |
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

### Who can open a site

Each SharePoint site gets one `_members.md` beside its libraries. The data comes from
`list-sharepoint-site-members`. The page gives:

- The Microsoft 365 group of the site, and the owners and members of that group.
- The SharePoint groups on the document library, with their roles.
- The sharing links on the document library, with their roles.

```markdown
# Who can open Espace Contoso

## Owners

- [Jane Doe](<../../People/Jane Doe.md>) (jane@example.com)

## Members

- Jane Doe (jane@example.com)
- Sam Lee, guest

## SharePoint groups

- Contoso Team Visitors: read
```

Graph does not list the persons in a SharePoint group. Thus the group members are the minimum set
of persons who can open the site. Graph shows a caller who is not a site owner only the grants that
apply to that caller. A file with unique permissions is not in this page.

If the People sync wrote a page for a person, the name links to that page. The links come from
the last People sync. A person without a page at that time gets a link on a later run.

Loop workspaces and OneDrives do not get this page, because they have no Microsoft 365 group. If
Graph does not give the data, the run keeps the old page and continues. If the answer does not
change, the run does not write the page again. If the site gives an empty answer, the run moves
the old page to `_archive/`.

### What did not make it in

Anything left behind is named in `_sync-report.md` beside the source it came from, newest run
first: files of a kind this tool does not read, files above the size cap, files locked with a
password, the stubs Office leaves beside an open document, files that could not be read, and files
moved aside because the source no longer has them.

An item that failed (a read, a conversion or a write) is tried again on the next run, three runs
in all. This applies to each source. After the third run, the report of the source names the item
one time, in a list of its own. decant does not try the item again until it changes at the source.
The report of the whole run names each item that decant gave up on, on each run. Attachments and
linked files in the mailbox and in group inboxes are different: the report names such a file one
time, when decant gives up on it.

decant reads some things on each run, for example a profile or a section of a notebook. After three
failed runs, such a thing is still read, but it is not named as a failure again.

If decant cannot read the pictures, the slide render or the scanned pages of a document, it writes
the document without them. The report names the document in the list of failures, and the next run
converts it again, three runs in all. When an edit makes a document too large, or locks it with a
password, decant does not convert it. Its line in the report then gives the folder in `_archive/`
that holds its earlier version.

A password is
the one refusal that never becomes readable by trying again, so such a file is left out the way an
unsupported type is, rather than queued afresh on every run. A `~$Budget.xlsx` sitting beside
`Budget.xlsx` is the same case decided earlier: Office writes it while the workbook is open and it
holds the editor's name rather than the document, so it is named for what it is instead of reaching
the converter, failing as a malformed workbook, and coming back on every run. A run that converted everything writes nothing there, so a nightly sync does not bury
the runs that did leave something behind.

`kb/_sync-report.md`, one level up, holds the same thing for the run as a whole, so twenty sources
do not mean twenty files to open. decant writes it again only when its content changes, the time
aside, so its time is the time of the last run that changed it. It always covers every source: the ones the run touched get their counts and their lists, and every other
source already in `kb/` is named with the date it last ran, so a source that was not rechecked is
never mistaken for one with nothing wrong. A group inbox is named as one, `Northwind Projects 2026
(group inbox)`, because the site of the same name is a separate source with its own section, and
two identical headings would leave a reader guessing which held the documents. A run that left something behind ends with a line on the
terminal saying so and naming the file. Its history is the per-source files; this one is the current
view. A dry run writes neither.

### What a mailbox sync writes

```
kb/
  Mailbox/
    .sync-state.json                what every conversation produced
    _sync-report.md                 what did not make it in, and why
    _index.md                       every thread, the newest message first
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
    _meta/messages.jsonl                             one line per message, for search
    _meta/attachments.jsonl                          one line per stored file, by content address
    _meta/links.jsonl                                one line per document pointed at
```

The `_index.md` file of the mailbox lists each thread, with the thread that has the newest message at
the top. Each line shows the day of that message, the subject as a link, and the sender of that
message. In `_meta/threads.jsonl`, `first_message` and `last_message` give the time of the first
message and of the last message of each thread.

Each message in a thread note starts with a heading and one line of data:

```
## 2026-05-12 11:31 — Jane Doe to Valerie FAIRBANKS; cc Li Wei

from jane@contoso.com · to valerie@contoso.com · cc li.wei@northwind.example · folder Inbox · flag open · importance high · categories Blue category
```

The heading gives the time in the zone of the knowledge base, the sender, the names in To and the
names in Cc. A message with no name in To and in Cc gets `to (no visible recipients)`, for example a
notice sent with Bcc. A post in a group inbox has no To and no Cc. Thus its heading gives only the
sender.

The line of data gives the addresses, the folder of the message, the flag (`open` or `complete`),
the importance and the categories. It has only the parts that have a value, and it shows the
importance only when it is high or low. For a draft, the line has `not sent` after the folder.
decant does not know the name of a subfolder of Deleted Items, Junk Email, Drafts or Outbox. Thus a
message in such a subfolder has no folder in its line.

`_meta/messages.jsonl` has one line for each message of each thread, in the sequence of the time of
the messages. Each run writes the file again from the state. The fields are:

| Field | Value |
|---|---|
| `date`, `time` | The day and the time (`HH:MM`) of the message, in the zone of the knowledge base. |
| `utc` | The time of the message in UTC, as Graph gives it. |
| `direction` | `draft` for a draft. `sent` when the sender address is the mail address or the sign-in name of your mailbox. Else `received`. |
| `from`, `from_email` | The name and the address of the sender. |
| `to`, `to_emails`, `cc`, `cc_emails` | The names and the addresses in To and in Cc. |
| `subject` | The subject of the message. |
| `folder` | The name of the folder of the message. It is empty when decant does not know the folder. |
| `flag` | `open`, `complete`, or empty for no flag. |
| `categories`, `importance` | The categories of the message, and `low`, `normal` or `high`. |
| `attachments`, `linked_files` | The names of the files that the message carried, and of the SharePoint files that it links to. |
| `preview` | The first words of the message, on one line. |
| `note` | The path of the thread note from `kb/`. |
| `position` | The place of the message in its thread, for example `2/5`. |
| `thread_id`, `message_id`, `internet_message_id` | The thread id, the Graph id and the RFC `Message-ID`. |

For example, this PowerShell command shows the mail that you received on the day before today:

```powershell
Get-Content kb/Mailbox/_meta/messages.jsonl -Encoding UTF8 | ConvertFrom-Json |
  Where-Object { $_.date -eq (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') -and $_.direction -eq 'received' } |
  Format-Table time, from, subject, folder
```

decant writes a thread again when the thread gets a new message. It also writes a thread again when
a message of the thread gets a new flag, category, importance or folder. When a folder gets a new
name, decant writes again each thread with a message in that folder. When you only read a message,
decant does not write its thread again.

decant does not read Deleted Items, Junk Email, Drafts and Outbox for changes. Thus a new flag on a
message in these folders does not write its thread again.

When a message is deleted, or moved out of a folder that decant reads, the next run writes its
thread again. A message that you move to Deleted Items stays in the note, and its line names Deleted
Items. A message that the mailbox no longer holds goes out of the note. When you delete a message
from Deleted Items, decant does not see it, because it does not read that folder. The note changes
at the next write of the thread.

When decant writes a thread again, each file that the thread no longer holds goes to
`kb/_archive/<day of the run>/`, at the path that it had in `kb/`. An example is the attachment of a
deleted message. The report names each file with `no longer in the thread`. When the mailbox holds
no message of a thread, the note and all the files of the thread go to `_archive/` together. The
report names the note with `no message left at the source`.

When decant cannot read a file that a thread holds, it keeps that file and its card as they are.
This also applies to all the files of a message when decant cannot read the list of its files. The
report names the failure, and the next run writes the thread again. decant moves the other files
that the thread no longer holds as usual.

decant can fail to move a file, for example a file that is open on Windows. Such a file stays in the
thread, and the next write of the thread tries again. When the note of a thread with no message
cannot move, decant keeps the thread. It tries again on the next run, three times in all.

Each file in a thread keeps the name that it got first, also a file with only a card, and also a
linked document. A new file does not get the name of a file that the thread holds. This rule also
applies after a message before it goes, and after a message moves to another folder. The note also
keeps its first name. When the state file is missing, decant finds the folder of each thread by the
id in the name of the folder.

When decant finds a mailbox from before this version, it updates the mailbox one time. The first run
reads each mail folder again from the start, and writes each thread again. Then each note has the
new headings, and `_meta/messages.jsonl` has a line for each message.

### What a To Do sync writes

One markdown file per task. decant files each task under the day that it is due, or under `undated/`
if it has no due day:

```yaml
---
source: To Do - Tasks
list: Tasks
status: completed
importance: high
due: "2026-09-12"
completed: "2026-09-08"
created: "2026-08-01T09:00:00Z"
last_modified: "2026-09-08T16:20:11Z"
categories:
  - Work
synced_at: "2026-09-09T14:00:00Z"
---

# Book the venue

Ask for the September rate.

## Steps

- [x] Shortlist three
- [ ] Call them

## Links

- [Contract draft](https://tenant.sharepoint.com/sites/X/Contract.docx)
```

The `due` and `completed` days are days in the zone of the knowledge base (see Time zone), the
same days that To Do shows.

Completed tasks land alongside the open ones, each marked with its status and the day it was
finished. A knowledge base is for remembering what was decided, and most of that is in work already
done; a sync that kept only the open tasks would delete a task from `kb/` at the moment it stopped
being a plan and became a fact.

An ordinary task says nothing about its importance, so the word only appears where it means
something. A task with no notes, no steps and nothing linked carries none of those headings rather
than empty ones.

An edit that keeps the due day writes the task at the same path. Before the write, decant moves the
earlier version to `_archive/<day of the run>/`. A new due day moves the task to the folder of that
day, and the earlier version goes to `_archive/` too. A task that you delete in To Do goes to
`_archive/`, and the `_sync-report.md` of the list names it.

The `_index.md` file of each list shows the tasks in three groups:

1. The open tasks by due day, with the nearest day first.
2. The open tasks with no due day.
3. The completed tasks, with the latest at the top.

Each line shows the day, the title as a link, and the status of an open task.

Each list is read whole every run. To Do does have a delta endpoint, but it answers with a task's
own fields and leaves out its steps and its linked resources, which are navigation properties and
have to be expanded; one paged read that expands both costs less than a delta plus a fetch per
changed task, and it is also what makes a deleted task visible, by its absence, on every run rather
than on the single run a delta reports its removal.

### What a calendar sync writes

One file per event as the calendar holds it: a single meeting, a recurring series as one file
carrying its rule in words, an exception to a series as its own file. Expanded occurrences would be
fifty-two identical files for a weekly meeting.

```yaml
---
source: https://outlook.office365.com/owa/?itemid=...
subject: Offsite planning
start: "2026-09-12 15:00"
end: "2026-09-12 16:30"
timezone: Asia/Shanghai
organizer: Valerie
attendees:
  - Jane Doe (accepted)
  - Dana Farrow (optional, no answer)
location: Rotterdam, Room 3
online_meeting: https://teams.microsoft.com/l/meetup-join/...
recurrence: every week on Monday, from 2026-01-05 until 2026-12-31
my_response: accepted
synced_at: "2026-09-12T14:00:00Z"
---

# Offsite planning

Agenda: ...

## Attachments

- [Venues.xlsx](<Offsite planning.attachments/Venues.xlsx.md>)
```

Times are in the zone of the knowledge base, and the `timezone:` line names that zone (see Time
zone). An all-day event shows days, not times. The body is the invitation's text with the markup gone, so
the Teams boilerplate reads as a few lines rather than a page of HTML.

The calendar delta reports what changed and no more, so each event it names is fetched in full. A
reply, a reschedule or a new attendee moves the event's `lastModifiedDateTime`, the delta reports
it, and it is written again, refiled under its new day if the start moved, the old copy going to
`_archive/`. A deleted event goes to `_archive/` too and is named in the report; a cancelled one
stays, marked `cancelled: true`, since a cancelled meeting is still a fact.

What an invitation carries lands as markdown only, beside the event: the library converts an event
attachment to text and nothing fetches its bytes, so there is no PDF and no original the way a mail
attachment has. A picture pasted into an invitation is left out and named in the report as such.
The first run walks the whole calendar and writes the events starting on or after the kept day, and
every recurring series whatever day it began (see How far back). The cursor moves only once every
event the delta reported has landed.

If decant cannot convert or write an attachment that is not a picture, the report shows the
attachment as failed. While the event keeps its day and its subject, decant keeps the last file of
that attachment and the link to it. If the day or the subject changes, that file goes to
`_archive/`. The next runs write the event again, for a maximum of three runs. If decant cannot get
the list of attachments, it keeps all the attachment files of the event.

### What a people sync writes

One page per colleague, and one org chart:

```yaml
---
source: Microsoft 365 directory
name: Jane Doe
title: Head of Operations
department: Operations
manager: Dana Farrow
email: jane@example.com
phones:
  - "+31 6 1234 5678"
office: Rotterdam
teams:
  - Leadership
  - NORTHWIND EMPLOYEES
synced_at: "2026-09-11T14:00:00Z"
---

# Jane Doe

Head of Operations, Operations. Reports to [Dana Farrow](<Dana Farrow.md>).

## Reports

- [Ann Lee](<Ann Lee.md>)
```

There is no directory listing in the library (`/users` is not exposed), so the people are found
through the Teams you belong to: the roster of every one of them, joined by user id, is the
directory. With an all-employees Team that is everyone; without one it is everyone you work with.
Each person then costs one call, `get-user` with the manager expanded into it. Guests and disabled
accounts are read and left out, and count as nobody's report.

Graph offers no delta on people the library exposes, so every run reads every profile again. What
makes a run an update rather than a rewrite is a fingerprint per person in the state file, over the
profile, the Teams and the reports: an unchanged person costs a call and no write, a changed title
or manager rewrites that one page, a newcomer is written, and someone whose account is disabled or
who has left every Team is moved to `_archive/<day of the run>/People/` and named in the report. The org chart is
drawn again whenever any page was.

The fingerprint also includes the names of the reports. It also records if the manager is in the
directory. When a report gets a new name, decant writes the page of the manager again, with the new
name and link. When the manager of a person goes out of the directory, decant writes the page of
that person again. That page shows the name of the manager as text. The first run of this version
writes each page again one time, but a page with the same text does not change on disk.

If the profile of a person does not read in a run, decant keeps the page of that person and the
links to it. When that profile reads again, decant draws the org chart again.

If the Team rosters have no person, but the state has records of persons, decant stops the People
source with an error. It moves no page to `_archive/`. A missing permission in Microsoft 365 can
cause this result.

Make sure that the account can read its Teams.

### What a OneNote sync writes

One file per page, under the notebook's own structure rather than under a day, since a page is a
place and not a moment:

```yaml
---
source: https://tenant.sharepoint.com/sites/lead/SiteAssets/Notebook#Kick-off
notebook: Northwind Leadership Notebook
section: Meetings
group: "2026"
title: Kick-off
created: "2026-08-01T09:00:00Z"
last_modified: "2026-09-01T10:00:00Z"
synced_at: "2026-09-12T14:00:00Z"
---

# Kick-off

Agenda ...
```

The notebooks offered are your own and those of every site the picker knows, one call per site
made side by side; a site that refuses OneNote reads (a tenant past OneNote's item limit answers
every read with a refusal) costs its own notebooks and not the listing. Two notebooks can carry one
name, since every site's default notebook is named after the site, and the second to be synced
takes an id-suffixed folder the way two sites sharing a name do.

Pages have no delta, so every run lists every section and every page again and rewrites a page
only when its `lastModifiedDateTime` moved; a page renamed or moved between sections is written
afresh and the old copy goes to `_archive/`, and a page gone from the notebook goes there too and is
named in the report. A section whose pages cannot be listed keeps its pages on disk as they are.

When you rename a section or a section group, decant writes each page of it again in the folder of
the new name. Then it moves the copy of the page from before the change to `_archive/`. A page that
decant stopped after three runs stays where it is. An update also finds a notebook in an id-suffixed
folder by its id.

A page of your own notebooks renders through the library, pictures embedded. A page of a site
notebook is answered as HTML only, with no renderer in the library for it, so its text is read out
here the way a calendar event's body is, and a picture in it reads as a link to a Graph resource
that needs a sign-in to open. Section groups inside a site notebook are out of reach on the site
route, so the pages inside one are not offered. Both are gaps in the library rather than here.

### What a SharePoint lists sync writes

One file per list, the whole list as one markdown table, since a tracker is read as a table and
not one row at a time:

```yaml
---
source: https://tenant.sharepoint.com/sites/contoso/Lists/Projects
site: Espace Contoso
list: Projects
description: Every project we run
rows: 2
last_modified: "2026-09-11T10:00:00Z"
synced_at: "2026-09-12T14:00:00Z"
---

# Projects

Every project we run

| Title | Status | Owners | Sponsor |
|---|---|---|---|
| Falcon | Open | Jane Doe | #12 |
| Eagle | Done |  |  |
```

Every site in the picker is offered for its lists, under its own heading and apart from the same
site's libraries, which are the drive sync's business: a document library is a list in Graph's
eyes and is passed over here, as are the hidden lists SharePoint keeps for itself. What is taken
is the kind a person makes and fills in (a custom list, a task or issue tracker, a calendar of
events, contacts, links, announcements, a survey).

The columns are the ones a person sees on the list: the title, and whatever is neither hidden nor
read-only, so SharePoint's own bookkeeping (a colour tag, a compliance id, who edited last) stays
out. A date reads as its day, a flag as yes or no, a person or a lookup by name, a link as a link.
A column holding one person or one lookup is answered by Graph as an id alone, shown as `#12`,
since the name is not in the row; a column holding several is answered by name.

Lists have no delta, so every run reads every list again and rewrites a table only when a row's
`lastModifiedDateTime` moved, a row came or went, or the columns changed. A list renamed is written
afresh and the old table goes to `_archive/`, a list gone from the site goes there too and is named
in the report, and a list whose rows cannot be read keeps its table on disk as it was.
decant also writes a list again when you change only its name.

### What a Planner sync writes

One file per task under the bucket it sits in, since a plan is a board and the lanes are how a
person reads it, plus `_board.md`, the whole plan as one table:

```yaml
---
source: https://planner.cloud.microsoft/webui/plan/<plan>/view/board/task/<task>
plan: Offsite 2026
bucket: To do
progress: in progress
priority: urgent
labels:
  - Waiting on client
assigned_to:
  - Jane Doe
  - Sam Lee
start: "2026-09-01"
due: "2026-09-30"
created: "2026-08-20T09:12:00Z"
created_by: Jane Doe
synced_at: "2026-09-12T14:00:00Z"
---

# Book the venue

Three rooms, one with a projector.

## Checklist

- [x] Ask for a quote
- [ ] Sign the contract

## References

- [venues.xlsx](<https://contoso.sharepoint.com/sites/x/Shared Documents/venues.xlsx>)
```

Progress is Planner's three words, priority its four bands (`medium` left unsaid, being the
default), dates are days, and assignees are named through one directory read per person per run.
Labels are named from the plan's details, read once a plan per run, on the page and in the board's
last column; a label nobody named is a colour in Planner and is left out rather than shown as
`category3`, and renaming one rewrites the pages that carry it. The details come through
`get-planner-plan-details`; when that read is refused, the plan still syncs, without its labels,
and the log says so (`labels.unnamed`).

The plans offered are the ones Graph lists for you and those of every group you belong to, one
call per group through `list-group-planner-plans`. On the tenant this was built against your own
listing answers nothing and the groups hold the plans, so the group route is the one that fills
the picker. Both commands arrived in `ask-marcel-office-cli` 2.8.0
([docs/request-group-planner-plans.md](docs/request-group-planner-plans.md)). `--plan <id>` reaches
one plan without the picker, the id being what the address bar shows.

Tasks have no delta, so every run lists the buckets and the tasks again and reads every task's
details, the description having an etag of its own that the card does not carry; a task is
rewritten when either etag moved or its page belongs under another lane now, put aside when it
left the plan, and the board is drawn again whenever any page was. A plan with hundreds of tasks
costs hundreds of calls a run.

An update reads the title of each plan by its id. When you rename a plan, decant writes its pages
and its board in the folder of the new title. Then it moves the pages from the folder of the title
before the change to `_archive/`. It also moves the state, the cursor, the board and the report of
that folder. If only the letter case of the title changes, the plan stays in its folder.

If the folder of the new title has a different plan, decant stops the plan with an error. If decant
cannot read the state in that folder, it stops the plan with the cause of the error.

If a different plan has the folder, give one of the two plans a different title.

### What a Teams sync writes

A Team is chosen the way a site is, and then asked which of its channels to take the way a site is
asked about its libraries. Each channel gets a folder, and each root post in it one markdown file:

```yaml
---
source: https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1757491200000
team: Northwind Leadership
channel: General
subject: Venue for the offsite
author: Jane Doe
created: "2026-09-10T08:00:00Z"
last_modified: "2026-09-10T09:30:00Z"
synced_at: "2026-09-11T14:00:00Z"
---

### 2026-09-10 08:00 · Jane Doe

**Venue for the offsite**

Three options, see below.

> **Dana Farrow · 2026-09-10 09:30**
> The second one.
```

The thread under the front matter is rendered by `ask-marcel-office-cli` itself, the way a mail
message is: the Teams HTML converted, @mentions flattened to their names, attachment placeholders
resolved to links, each reply quoted beneath the post oldest first, with `_(edited)_`,
`_message deleted_` and `_reactions: 👍 2_` markers where they apply. A picture pasted into a post
is a placeholder; the bytes live in Graph's hosted content and are not fetched.

decant files a post under the day of the first post, which the id of the post also holds. A reply
moves the `lastModifiedDateTime` of the root post, so decant writes the whole thread again at the
same path. Before the write, decant moves the earlier version to `_archive/<day of the run>/`. A post
that you delete in Teams goes to `_archive/` too, and the `_sync-report.md` of the team names it.
decant names a post by its subject. Most posts have no subject, and then decant names the post by
its first line.

The `_index.md` file of each channel lists the posts, with the latest activity at the top. Each line
shows the day of that activity, the title as a link, and the author.

Each channel keeps a delta cursor of its own, so a re-run asks Graph only for what changed. The
cursor moves only once every post the delta reported has landed: a post that would not render is
named in the report, and the channel re-reads its delta next run to try it again, skipping by
`lastModifiedDateTime` everything that already landed.

Only the channels of Teams you are a member of are offered, and only their standard, private and
shared channels as Graph lists them. Teams chats (one-to-one and group chats) are a different thing
and are not synced: the library can only reach them through Microsoft-internal endpoints whose token
expires daily, which would fail every scheduled `update`.

### What a group inbox sync writes

The same, in a folder of its own:

```
kb/
  Group inboxes/
    Leadership Team/
      .sync-state.json              what has been filed, and the newest post it reaches
      threads/2026-07-20-abc1234567-bi-monthly-leadership-meeting/
        bi-monthly-leadership-meeting.md             every post, oldest first
```

A Microsoft 365 group is three things wearing one name: a SharePoint site holding files, an inbox
holding conversations, and a Teams team. The picker offers the first two separately, and the shelf
is what keeps them apart on disk: both carry the group's name, one under `SharePoint sites/`, the
other under `Group inboxes/`.

Only the groups you belong to can be read. Access is decided by membership rather than by any
permission this tool can ask for, so a group the directory lists but you have not joined refuses
every read, and it is not offered.

A post attachment gets everything a mail attachment gets: a deck is rendered to a PDF beside its
text, a diagram inside an attached Word or Excel file is extracted and read, and a SharePoint link
in a post body is pulled into `_linked/`. The three commands this needs arrived in
`ask-marcel-office-cli` 2.6.0; before it, each answered with an honest empty.

Group threads are not tracked by a delta the way a mailbox folder is, because Graph offers none.
Each run lists a group's threads newest first and stops at the newest post it already holds, so a
thread that has been replied to comes back and an untouched one does not.

Each run gets the list of all the threads of the group. When a thread that decant wrote is not in
the list, the group no longer holds it. decant then moves its note and its files to
`kb/_archive/<day of the run>/`, and the report names it with `no longer at the source`. When the
list has no thread at all, decant moves no file, because an empty list can be an error. decant does
not see a post that is deleted from a thread that stays, until the thread gets a new post. Files
that a thread no longer holds go to `_archive/` as in the mailbox.

A thread that could not be written is remembered and asked for again on the next run, three tries
in all, whatever the dates say. It has to be remembered rather than found again: a thread that
failed records nothing, so a newer thread that did land carries that stopping point past it, and
no reading of the dates alone would ever reach it. The same holds for a thread that lands while one
of the files it carried does not. After the third try the thread is named once under the heading
that says it will not be tried again, by its topic rather than its id.

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

The day is the day in the zone of the knowledge base (see Time zone). Every
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
address you would reply to, also the people in Cc. The heading of each message gives the names, and
the line of data under it gives the addresses.

`_sync-report.md` holds only what a reader should look into. A run in which every file arrived
writes the counts and the line "Nothing was left behind." A file left out says which kind it was,
a `.mp4` this tool does not read, or that its name had no extension so nothing could tell.

A conversation that could not be written is remembered and rendered again on the next run, the same
three tries a SharePoint document gets, and named by its subject under the same two headings: the one
that promises another run, then the one that says there will not be another. One that failed before
decant kept subjects goes by its thread id, since that is all the state file holds for it. A reply
arriving on a thread that had run out of tries starts it over.

A thread that lands while one of the files it carried does not is remembered the same way, and the
whole thread is written again on the next run to fetch that one file. It costs the conversions of
the files that already worked, which land on the same paths they landed on before, and there is no
narrower way back: the folder cursors moved on when the messages were swept. After the third try the
file is named once as given up and the thread is left alone; the card in the thread's own
`_attachments` folder goes on saying what happened to it.

A first mailbox run is slow: Outlook hands back a folder a hundred messages at a time, and only
because every page asks for it again, since the size is honoured only on the request that carries
it. A mailbox with tens of thousands of messages takes hundreds of round trips, and every
conversation written for the first time costs one more, to find the thread it belongs to. Later runs
are cheap, reading only what changed. The kept day narrows what gets *written*, not what gets swept.

While it works, a counter on the terminal shows how far it has got, so a long run is never silent. A
header row carries the count, and every item still being read from the source gets a row of its own
beneath it, naming the step it is on:

```
SW Project (Fabrikam instance) / 文档  4/25 (8 running)
  Projets/PT Findings.xlsx · reading picture 3/6
  General/04_IT_Security_overview/Overview.docx · rendering the slides
```

A mailbox counts twice before it writes anything: its folders as they are read, each with the
messages read so far, then the conversations it has not seen before, by subject, while it finds the
thread each belongs to. Once it writes, each conversation's row names the attachment or linked
document it is reading, since a dozen screenshots take minutes to read. A first run spends most of
its time on the first two:

```
Mailbox, reading folders 3/14
  Inbox · 1200 messages read
```

The block rewrites itself where it stands as items come and go, so one slow file does not look like
the run has stopped while its `--concurrency` siblings finish around it. Set `--concurrency` higher
than the terminal has rows and the overflow collapses into a single `…and N more` row, so the block
never outgrows the screen. It draws only when stderr is a terminal, so piping the output to a file or
running headless leaves no counter behind.

## Re-running

Each run stores the cursor Graph gives it, so a second run reads only what changed: an unchanged
library converts nothing. State is written after every single file, so stopping a run mid-way
(Ctrl-C) loses at most the file in flight, and the next run picks up from the same place. decant
converts a file that you rename or move in SharePoint again at its new path. The earlier files of
that file, the files of a deleted file and the earlier version of an edited file go to
`kb/_archive/<day of the run>/`.

If no source records a file and decant cannot move it to `_archive/`, decant writes its path and the
cause in `kb/.sync-aside.json`. For example, a program on Windows can hold the file of an item open
after you delete the item at the source. decant also records a checksum of the text in the file. At
the start of each run, decant tries again to move each file in that list, but only if its checksum
did not change. If the checksum changed, decant removes the path from the list and does not move the
file, because a different file is at that path. A dry run does not move these files.

The section `## Could not be moved to the archive` of `kb/_sync-report.md` names each file that
stays in the list. It gives the cause and the day of the first failure, in the time zone of the kb.
If decant cannot read a file when it writes the file in the list, the report tells you, and no run
moves that file. You must then move the file to `_archive/`.

If decant cannot read `kb/.sync-aside.json`, it does not change the file. The section then names only
the files of that run, and decant does not add them to the list. Repair or delete
`kb/.sync-aside.json`.

When an edit must go to the path of its earlier version, and that version does not move, decant
does not write the edit. A write at that path replaces the earlier version. The source keeps the
earlier version and its record, and the report of the source names the item as failed. The next
run tries the item again, three runs in all. This applies to documents, To Do tasks and Teams
posts. When the edit goes to a new path, decant writes the edit, and the earlier file goes into the
list.

Microsoft Graph can refuse an old cursor (HTTP 410). Then decant reads the source again from the
start: a mail folder, a library or the calendar. For a library, decant then moves to `_archive/` each
recorded document that is not in the new list. For the calendar, decant does not compare, because it
reads only from the kept day.

A run that finds nothing new at the source changes no file in `kb/`, with one exception: the
`.sync-cursor.json` beside each `.sync-state.json`. That file holds the time of the last run and the
delta cursors, which change on each run. If the cursor file is lost or does not agree with the
state, the next run reads the source whole one time. For a library, decant then also moves to
`_archive/` each recorded document that is not in the new list.

decant writes a file only when its content changes. The `synced_at` line does not count, so
`synced_at` gives the time of the last real change. decant writes each file beside its place and
then renames it over the old file. Thus a stopped run leaves no half file in the place of a file. If
a run stops during a write, a file with a name that ends in `.~` and six characters can stay beside
the file. You can delete this file.

`kb/` is generated content and is gitignored.

## Keep a copy in git (optional)

decant does not need git and does not read git. The old versions are in `_archive/`, and the
reports are in `_sync-report.md`. To keep a history of each change, you can make the export folder a
git repository:

1. In the export folder, run `git init`.
2. Add a `.gitattributes` file with the line `* -text`. Then git keeps each file as decant wrote it.
3. Add a `.gitignore` file with the lines `.sync-cursor.json` and `*.~??????`. The cursor file
   changes on each run. The pattern is for a file that can stay after a stopped write.
4. On Windows, run `git config core.longpaths true` and `git config core.quotepath false`.
5. For the originals and the pictures, use Git LFS, for example
   `git lfs track "*.pdf" "*.docx" "*.xlsx" "*.pptx" "*.png" "*.jpg" "*.gif" "*.zip"`.

Then make a commit after each run that finished, with exit code 0 or 3. In PowerShell:

```powershell
decant update
if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 3) { git add -A; git commit -q -m "decant update $(Get-Date -Format yyyy-MM-dd)" }
```

In a POSIX shell:

```bash
decant update; code=$?
if [ "$code" -eq 0 ] || [ "$code" -eq 3 ]; then git add -A && git commit -q -m "decant update $(date +%F)"; fi
```

A run that found nothing new changes no file that git keeps, so git has nothing to commit.

## Configuration

Read once at startup, in `src/composition/config.ts`:

| Variable | Meaning | Default |
|---|---|---|
| `KB_ROOT` | Folder the knowledge base is written to. `--out` has priority over it | `kb` |
| `KB_LOG_LEVEL` | Winston level; logs go to stderr, output to stdout | `error` |

## Development

This repo follows the atelier standard: Clean Architecture, TDD with hand-written fakes,
`Result<T, E>` at every IO boundary. See `CLAUDE.md`.

```bash
bun test                       # test suite, in a new random order on each run
bun run lint                   # fast rules, zero warnings allowed
bun run lint:strict            # adds the type-aware rules (pre-commit gate)
bun run typecheck              # tsc --noEmit
bun run coverage               # per-tier gate: 100% domain and use-cases, 80% elsewhere
bun run mutate                 # Stryker over everything, break threshold 90
bun run mutate:changed         # Stryker over what changed since origin/main, each file held to 90
bash scripts/verify-commits.sh # every commit since origin/main typechecked and tested on its own
```

`bun test` runs the tests in a new random order each time, because `bunfig.toml` sets
`randomize = true`. A run that fails prints `--seed=<n>`. `bun test --seed=<n>` runs the tests again
in the same order.

Stryker breaks on the total of the files it mutates, so one weak file passes while the others carry
it. `mutate:changed` and `mutate:staged` follow the run with `scripts/check-mutation-files.ts`,
which reads the report the run just wrote and fails on any single file under the break. The full
sweep on main keeps the total alone.

The pre-push hook runs `scripts/verify-commits.sh` over what is being pushed: each commit is checked
out alone in a detached worktree and has to typecheck and pass the suite there, since the pre-commit
hook only ever sees the working tree. A commit touching only prose (`*.md`, `.claude/`, `docs/`) is
skipped.

Lint holds every function to a complexity of 10 and every layer to the imports the dependency rule
allows: the domain imports no other layer, the use cases nothing beyond the domain and their own
layer, the presenter only the domain, infra neither the presenter nor the composition root, and no
production file reaches the test fakes, which themselves never wrap an adapter. It refuses a
`class`, an inline `type` import, a curried arrow other than a `createX` factory, a `try` in a use
case, `node:fs` in `src/` outside infra, the fakes and the tests, a `@ts-` comment and another tool's
ignore marker, and `toEqual([])` in a test, which passes on `[undefined]`; a comment disabling a rule
does nothing but get reported itself.
`eslint.config.test.ts` lints a violation of each gate through the real config, so a gate that
stops firing turns the suite red. Stryker runs `bun test src`, which leaves those fixtures out:
they exercise the config, not a line of `src/`.

### Layout

```
src/
  domain/        pure logic: paths, front matter, conversion planning, delta diffing, state
  use-cases/     orchestration against ports; ports/ holds the port types
  infra/         adapters: the Graph library, Bun filesystem, RapidOCR, Winston, stdin, stdout
  presenter/     pure renderers, handed to the use cases through a port
  composition/   option parsing, configuration, dependency wiring
  test-helpers/  hand-written fakes and builders
  main.ts        entry point, the one top-level catch
```
