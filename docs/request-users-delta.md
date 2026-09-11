# Request: let a consumer read the directory, and only what changed in it

**Package:** `ask-marcel-office-cli` 2.7.0
**Category:** users
**Kind:** missing commands. Nothing is broken. One person can be read; the people cannot be listed,
and nothing says which of them changed since last time.

## Context

`decant` mirrors Microsoft 365 into markdown for local agents. Since 2026-09-11 it syncs the people
directory: one page per colleague with their title, department, manager, phones, office and Teams,
plus an org chart drawn from the manager links, so an agent can answer "who is X, who do they
report to, how do I reach them" without a Graph call.

It was built on what 2.7.0 offers, and it works. Verified live on a real tenant: 254 colleagues
found, written, and re-read the next run with nothing rewritten. The cost of that second run is the
subject of this request.

## What exists in 2.7.0

| Command | Graph path | What it gives |
|---|---|---|
| `get-user` | `/users/{id}` | one profile, `$select` and `$expand=manager` honoured, on the basic token |
| `get-user-manager` | `/users/{id}/manager` | one hop up |
| `list-user-direct-reports` | `/users/{id}/directReports` | one hop down |
| `list-team-members` | `/teams/{id}/members` | who is in a Team, paged |
| `list-relevant-people` | `/me/people` | the people the signed-in user interacts with, ranked, not the directory |

So the directory is reachable one person at a time, and the only way to know who to ask about is a
roster: `decant` takes the union of `list-team-members` over every joined Team, which on a tenant
with an all-employees Team is the directory and on any other tenant is everyone the user works with.

## What is missing

| Wanted | Graph path | Why |
|---|---|---|
| `list-users-delta` | `/users/delta` | the one thing that turns a daily re-read into a real update |
| `list-users` | `/users` | the directory itself, without going through Team rosters |

### `list-users-delta`, the real ask

Every run today reads every profile again: a few paged roster calls, then one `get-user` per
person. On this tenant that is 254 calls, some twenty seconds at concurrency 4, to find out that
nobody changed, which is the usual answer. A fingerprint over each profile in the consumer's state
keeps the *writes* down to what changed; nothing keeps the *reads* down, because nothing in the
library can say who changed.

`/users/delta` is Graph's answer to exactly this. The first call walks the directory and ends with
an `@odata.deltaLink`; a later call with that link returns only the users created, changed or
deleted since, a deleted one arriving as `{ id, "@removed": { "reason": "deleted" } }`. `$select`
narrows both what is returned and what counts as a change, so a consumer that selects
`displayName,jobTitle,department,mail,mobilePhone,businessPhones,officeLocation,accountEnabled,
userType` is told about a new title and not about a new photo. A run where nobody changed becomes
one call.

Shape asked for, following `list-team-channel-messages-delta`, which is the same idea on a channel:

```
list-users-delta [--select ...] [--top n]
```

taking the standard `$select` and `$top` passthrough, answering the raw Graph body so the cursors
are `@odata.nextLink` / `@odata.deltaLink` inside it as they are on every other delta, and feeding
either back through `next-page`. Two things to state in `COMMANDS.md`, since a consumer cannot find
them out except by trying:

- **Scope.** `/users/delta` needs `User.Read.All` delegated, where `get-user` gets by on
  `User.ReadBasic.All`. Whether the basic token carries it decides whether this can ship on the
  basic token at all. If it cannot, saying so is worth as much as the command: the consumer keeps
  the full re-read and stops hoping.
- **`$expand=manager`.** Graph documents `$expand=manager($select=id)` on the users delta, so a
  manager change is reported. If it holds up, a consumer needs no second call per changed person;
  if it does not, `get-user` with the expand still works for the few that changed.

### `list-users`, the smaller ask

`/users` with `$select`, `$filter` and `$top` (Graph caps at 999) and paging through
`@odata.nextLink`. Basic properties come back on `User.ReadBasic.All`, so this one very likely
works on the basic token already.

It would let a consumer enumerate the directory without depending on a Team happening to hold
everyone, and filter server-side (`accountEnabled eq true and userType eq 'Member'`) instead of
reading guests and disabled accounts only to drop them. It is second on the list because on its own
it is still a full read every run; with the delta it is the first run, and the delta is every run
after.

## What the consumer does meanwhile

`decant` reads every profile every run and rewrites nothing that did not change. The
`update` subcommand runs it with the other sources; the people are last, so a run that stops on a
lapsed sign-in has already refreshed everything else.

If the delta needs a scope the basic token cannot carry, the consumer's fallback is a throttle:
re-read profiles every few days rather than daily, while still reading the rosters daily so joiners
and leavers are caught. That is honest about staleness and it is not a delta.

When `list-users-delta` lands, the change is confined to one adapter method and the use-case's
state, which gains a cursor beside the fingerprints; the pages, the org chart, the archive and the
report do not move. `list-users` would replace the roster walk with one paged listing and keep the
Teams only as a field on each page. The same prediction was made in
`request-teams-channel-messages.md` and held: when 2.7.0 landed those commands, wiring them was one
adapter and one category entry.
