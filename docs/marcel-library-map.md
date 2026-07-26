# Using `ask-marcel-office-cli` as a library

Verified against v2.3.0 sources. This is what the `MarcelPort` adapter in `src/infra/` must
handle; the CLI binary is not used anywhere in this repo.

## Call shape

```ts
import { buildDeps, commands } from 'ask-marcel-office-cli';

const { graph, fs } = buildDeps({ interactive: false });
const command = commands['get-drive-delta'];
const result = await command.execute(graph, { driveId, itemId, top: '1000' });
```

Four things bite here:

**Params are `Record<string, string>`, flat.** Booleans are the strings `'true'` / `'false'`,
numbers are numeric strings. The keys are the canonical camelCase option keys, never the CLI's
kebab flags: `get-drive-delta` takes `itemId`, not `folderId`. As of v2.3.0 the flag-alias system
is gone (77 aliases, 4 deprecated command names removed) and every command refuses a key it does
not declare, returning a `validation_error` with code `unknown_parameter` that names the supported
flags; earlier versions silently stripped unknown keys on the library surface and returned data
that looked like it had obeyed. So a param typo now fails the call, which the adapter maps to a
permanent (non-retried) error. This is why the call sites use one canonical spelling each.

**Every ok-value is typed `unknown`.** The registry erases per-command types. Narrowing from
`unknown` to a typed record is our job, and it belongs in `src/domain/` where it is pure and
fully covered, not in the adapter.

**Pagination cursors come back raw.** `execute` returns Graph's body, so the cursors are
`value['@odata.nextLink']` and `value['@odata.deltaLink']`; the hoisting to a top-level
`nextLink` / `deltaLink` is done by the CLI's presenter, which the library does not export.
Feeding a cursor back to `next-page` needs the same canonicalization the presenter applies:
replace `%24` with `$`, and leave every other percent-escape alone.

**Writing bytes to disk is composition-only.** `--output-path` lives in a module the package does
not export, so a download hands back `base64` (or `text`) in the result and we write it ourselves.
The 1M-character inline guard is part of that same unexported module, so it does not apply to us.

## A command can throw as well as fail

`execute` is typed as returning a `Result`, but it can still raise: the package decodes base64 with
`atob`, which throws `InvalidCharacterError: The string contains invalid characters` on a malformed
payload. Seen live on a mail attachment, where it ended an entire mailbox run. The adapter therefore
wraps every call in a `try`/`catch` and reports a throw as a permanent error for that one item.

## Errors

```ts
type GraphError =
  | { type: 'api_error'; status: number; message: string; code?: string; retryAfterSeconds?: number }
  | { type: 'auth_failed'; message: string; code?: string }
  | { type: 'network_error'; message: string; code?: string }
  | { type: 'validation_error'; message: string; code?: string };
```

Only `api_error` carries `status`. Retry policy for this repo: retry `network_error` and
`api_error` with status 429 or >= 500, honouring `retryAfterSeconds` when present (it can be `0`,
so test for `undefined` rather than falsiness). Never retry `validation_error` or a 4xx, and treat
`auth_failed` as a run-ending condition after one login attempt.

Some `api_error`s are synthesized client-side with an invented status (400 when a folder is passed
where a file was expected, 404 for a missing local file, 500 for an unexpected envelope), so
`status` is not always an HTTP status.

## Mail delta and page size (truncation fixed in v2.3.0)

History, verified against a live 67-message Inbox on 2026-07-23 under v2.2.0: calling
`list-mail-folder-messages-delta` with `top: 2` returned **2 messages and a `deltaLink`** (not a
`nextLink`), and following that cursor returned zero. The other 65 messages were unreachable, with
the sync believing itself complete. Under v2.2.0 the same call without `top` paged correctly, ten
messages at a time, with a `nextLink` until the last page.

**v2.3.0 fixed the truncation**: `top` on a mail delta is now sent as a `Prefer: odata.maxpagesize`
header, which pages normally instead of reading a satisfied `$top` as "sync complete". So the sweep
now sends `top: 100` (drive delta uses `top: 1000`), cutting round trips on a large folder while
keeping each response small; paging continues through `nextLink` if Graph caps the page lower. The
pre-2.3.0 history stays here because it was a silent data-loss trap worth remembering. Note `skip`
and `orderby` are no longer accepted on the mail delta, and `filter`/`orderby` are gone from the two
drive deltas.

The cost of this is real: ten messages per request means a mailbox with a 6000-message archive
needs some 600 sequential requests on its first run. Later runs read only what changed.

## Timeouts: already handled

The Graph client sets its own `AbortSignal.timeout` on every request: 60s for JSON calls, 5min for
binary transfers. There is no knob and no way to pass a signal in. This satisfies rule 29 through
the dependency, so the adapter adds no deadline of its own; it only adds the retry policy above.

## Authentication

`buildDeps()` performs no IO and never opens a browser by itself; the auth ladder runs on the first
Graph call. `interactive` defaults to `process.stdin.isTTY`. Pass `{ interactive: false }` for the
`update` subcommand so a lapsed token fails fast with `auth_failed` instead of blocking a headless
run on a browser sign-in. Never call `makeLoginAuth()`, which re-enables the browser path.

## Command reference (the surface this repo uses)

Params are listed with their canonical keys; `?` marks optional.

| Command | Params | Ok-value |
|---|---|---|
| `search-all-accessible-sites` | `query?`, `countFiles?` | `{ value: site[], count, truncated?, ...counters }` |
| `get-sharepoint-site-by-path` | `hostname`, `path` | one `site` |
| `list-sharepoint-site-drives` | `siteId`, OData minus `skip` | `{ value: drive[] }` |
| `get-drive-root-item` | `driveId`, `select?`, `expand?` | one `driveItem` |
| `get-drive-delta` | `driveId`, `itemId`, `top?`, `select?`, `expand?` (no `filter`, `orderby`, `skip`) | `{ value: driveItem[], '@odata.nextLink'?, '@odata.deltaLink'? }` |
| `list-folder-files` | `driveId`, `itemId`, `tenantId?`, OData minus `skip` | `{ value: driveItem[] }` |
| `next-page` | `url` (absolute, `https://graph.microsoft.com/v1.0/...`) | the originating shape |
| `download-drive-item-content` | `driveId`, `itemId`, `tenantId?` | `{ contentType, size, text }` when the bytes are valid UTF-8, else `{ contentType, size, base64 }` |
| `download-drive-item-as-pdf` | `driveId`, `itemId`, `tenantId?` | `{ contentType: 'application/pdf', size, base64 }`; a plain-text source short-circuits to `{ ..., text, passthrough: true, note }` |
| `download-drive-item-as-markdown` | `driveId`, `itemId`, `tenantId?`, `includeMetadata?`, `inlineImages?`, `keepQuoted?`, `maxCells?` | `{ contentType: 'text/markdown' \| 'text/plain', size, text }` |
| `convert-local-file-to-markdown` | `path`, `includeMetadata?`, `inlineImages?`, `keepQuoted?`, `includeImages?`, `maxCells?` | single file: `{ contentType, size, text }`; zip: `{ count, files: [{ path, contentType, size, text } \| { path, note }] }` |
| `list-mail-folders` | OData only, strict schema | `{ value: mailFolder[] }`; **no `wellKnownName` in v1.0**, so Junk/Deleted/Drafts/Outbox can only be matched by localised `displayName` |
| `list-mail-child-folders` | `mailFolderId`, OData | `{ value: mailFolder[] }` |
| `list-mail-folder-messages-delta` | `mailFolderId`, `top?`, `select?`, `filter?`, `expand?` (no `skip`, `orderby`) | `{ value: message[], '@odata.nextLink'?, '@odata.deltaLink'? }` |
| `list-conversation-messages` | `conversationId`, `top?`, `skip?`, `select?`, `expand?` (no `filter`, no `orderby`) | `{ value: message[] }`, unordered |
| `convert-mail-to-markdown` | `messageId`, `inlineImages?`, `keepQuoted?` | `{ contentType: 'text/markdown', size, text, note? }` |
| `list-mail-attachments` | `messageId`, OData | `{ value: attachment[] }`; omitting `select` injects `id,name,contentType,size,isInline` |
| `get-mail-attachment` | `messageId`, `attachmentId`, `select?`, `expand?` | the Graph attachment, plus a `base64` mirror of `contentBytes` for file attachments (both fields carry the same bytes) |
| `convert-mail-attachment-to-markdown` | `messageId`, `attachmentId`, `includeMetadata?`, `keepQuoted?` | `{ contentType, size, text }` |
| `convert-mail-attachment-to-pdf` | `messageId`, `attachmentId` | `{ contentType, size, base64 }`, with a `passthrough: true` + `note` branch that still uses `base64` |
| `extract-sharepoint-links-in-mail` | `messageId` | `{ messageId, subject?, links: [{ url, driveId, itemId, name, webUrl } \| { url, error }], truncated, skippedCount }`, capped at 25 URLs |

`convert-local-file-to-markdown` is the one command called as
`command.executeLocal(fs, params)`; its `execute` is a deliberate 400 stub.

`size` on every converted result is a UTF-8 byte count, not a character count.

## Ports we reuse, and one we cannot

`FileSystem` (`createBunFileSystem()`) is reused for writes: `writeText` and `writeBytes` create
parent directories on their own. It has no directory listing and no rename, so this repo keeps its
own `Files` port for those.

`ProcessRunner` (`createBunProcessRunner()`) is **not** usable here. Its only method is
`runInherit`, whose stdio is always inherited by the parent process, so there is no way to capture
a subprocess's stdout. RapidOCR's recognized text arrives on stdout (as JSON, via a bundled Python
script), so this repo needs its own process port that captures output.
