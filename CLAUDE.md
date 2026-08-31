# CLAUDE.md

This repo follows the atelier coding standard. Consult the `atelier` skill for every
code task here; its hard rules 1-34 bind (TDD with hand-written fakes, `Result` at IO
boundaries, branded types at trust boundaries, and the production disciplines: privacy,
isolation, reliability, observability). Run the `atelier-review-me` skill before landing
changes. Journals: `.claude/LESSONS.md` (append-only memory), `.claude/PLAN.md` (current plan).

## What this repo is

`decant`, a Bun CLI that mirrors Microsoft 365 sources into `kb/` as markdown for local agents to
read. The name is the job: to decant is to pour the wine off the sediment, and what lands in `kb/`
is what a reader or an agent can use, with Outlook's link wrappers and a notification's chrome left
in the bottle. Sources:
SharePoint document libraries and the Outlook mailbox (conversations, attachments, linked files).
Graph access goes through the `ask-marcel-office-cli` package used as a **library**
(`commands['<name>'].execute(graph, params)`), never by shelling out to its CLI binary.

`kb/` is generated output and is gitignored.
