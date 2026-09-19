# Request: let a consumer find the Planner plans it can read

**Package:** `ask-marcel-office-cli` 2.7.0
**Category:** tasks
**Kind:** missing commands. Nothing is broken. A plan can be read whole once its id is known; the
plans a person can read cannot be listed, and a plan's labels cannot be named.

## Context

`decant` mirrors Microsoft 365 into markdown for local agents. It is adding Planner: one folder per
plan, one markdown file per task under the bucket it sits in, with its description, checklist and
references, and a board file that lays the whole plan out as a table, so an agent can answer "what
is open on the Atlas project, who has it, when is it due" without a Graph call.

It was built on what 2.7.0 offers, and the reading half works. Verified live on a real tenant: a
plan named by id is read whole (`get-planner-plan`, `list-plan-buckets`, `list-plan-tasks`, one
`get-planner-task-details` per task), every shape as Graph documents it. The finding half is the
subject of this request.

## What exists in 2.7.0

| Command | Graph path | What it gives |
|---|---|---|
| `list-planner-plans` | `/me/planner/plans` | the plans shared with the signed-in user |
| `list-planner-tasks` | `/me/planner/tasks` | the tasks assigned to the signed-in user, across plans |
| `get-planner-plan` | `/planner/plans/{id}` | one plan: title, owner group, container |
| `list-plan-buckets` | `/planner/plans/{id}/buckets` | the lanes of a plan |
| `list-plan-tasks` | `/planner/plans/{id}/tasks` | every task in a plan |
| `get-planner-task-details` | `/planner/tasks/{id}/details` | description, checklist, references |

## What is missing

| Wanted | Graph path | Why |
|---|---|---|
| `list-group-planner-plans` | `/groups/{group-id}/planner/plans` | the plans that actually exist |
| `get-planner-plan-details` | `/planner/plans/{id}/details` | what the labels are called |

### `list-group-planner-plans`, the real ask

On the tenant this was verified against, `/me/planner/plans` answers **no plans** and
`/me/planner/tasks` **no tasks**, while the four Microsoft 365 groups the user belongs to hold
**three plans** between them, reachable through `/groups/{id}/planner/plans` and readable from
there with every command above. Graph's `/me/planner/plans` lists the plans a person has been added
to in Planner's own sense; a group's plans are the group's, and belonging to the group is what
grants them, so the group route is the one that finds what a member can read. Without it a consumer
cannot offer a single plan to choose from unless the person pastes a plan id, which nobody has to
hand.

Shape asked for, following `list-group-threads`, which is the same idea on a group's inbox:

```
list-group-planner-plans --group-id <id> [--select ...]
```

answering the raw Graph body (`value`, and `@odata.nextLink` if Graph ever pages it, which it does
not today). The consumer already lists the groups through `list-my-memberships` and asks each in
turn, the way it asks each site for its OneNote notebooks; a group that refuses costs its own plans
and not the listing.

### `get-planner-plan-details`, the smaller ask

A task's labels travel as `appliedCategories: { category3: true }`, and the names behind
`category1`…`category25` live in the plan's details (`categoryDescriptions`), which no command
reaches. Until it does, a consumer can only leave the labels out or print `category3`, which says
nothing; it leaves them out.

## What the consumer does meanwhile

`decant` lists what `/me/planner/plans` answers, asks every group for its plans through
`list-group-planner-plans` and takes the refusal quietly while the command does not exist, and
accepts a plan named by id on the command line (`--plan <id>`), which is how it was verified. When
`list-group-planner-plans` lands, nothing in the consumer moves: the adapter already calls it by
name, and the picker fills in.
