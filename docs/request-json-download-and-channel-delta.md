# Request: download a JSON file, and read the posts of each channel

**Package:** `ask-marcel-office-cli` 2.8.0
**Category:** drive, teams
**Kind:** two failures that `decant` found on a new knowledge base on 2026-10-25. In each failure,
the package returns an error for an item that Graph can give.

## Context

`decant` mirrors Microsoft 365 into markdown for local agents. On 2026-10-25, a full sync into a new
folder found two failures. decant cannot repair them, because each one comes from the answer of a
command. `decant` does not edit what the package returns: a gap goes upstream. decant names each
failure in its report, and the rest of the run continues.

All line numbers refer to `dist/index.js` in 2.8.0.

## 1. A file that holds JSON does not download

A library holds `moov-deck/scripts/figtree-metrics.json`. `download-drive-item-content` returns this
error for it, on each of three runs, in two libraries:

```
transient: unexpected envelope: response had no @microsoft.graph.downloadUrl, no base64 bytes, and no text body
```

`fetchRawBytes` (lines 6316-6328) reads the answer of `callBinary`. When the answer has no
`@microsoft.graph.downloadUrl`, `decodeBlobBytes` (lines 6304-6314) looks for a `base64` field or a
`text` field. A file with the content type `application/json` probably arrives as the parsed JSON of
the file. That object has none of the three fields, so the command fails. We did not examine the
raw answer. Thus this cause is probable, not certain.

The package marks the error as `api_error` with status 500, and decant reads it as `transient`. Thus
decant tries the file again on the next two runs, and then gives up.

What a consumer needs: the bytes of the file, as for any other file. If the answer is JSON that is
not an envelope, the bytes of that JSON are the content of the file.

## 2. Graph refuses the posts delta of a channel

On the first sync of a team, `list-team-channel-messages-delta` (line 14160) failed for one channel
with:

```
BadRequest: Parameter 'DeltaToken' not supported for this request.
```

decant calls the command with `teamId`, `channelId` and `top`, and no cursor. Then it follows each
`@odata.nextLink` with `next-page`. We do not know if the first call or a later page failed, and we
do not know the type of the channel. The same team gave its other channels with no error.

What a consumer needs:

- The error tells which call failed: the first call, or a page that a link gave.
- When Graph does not support the delta for a channel, a way to read its posts all the same. For
  example, the command can read the channel with `GET /teams/{id}/channels/{id}/messages` and
  `$expand=replies`, as the command at line 14570 does when it has no `since`. Then it returns no
  `deltaLink`.

## What decant does now

- The file of section 1 fails three times, then the report names it as given up.
- Since 2026-10-25, a channel whose posts do not list is named as failed in the report of its team.
  decant keeps no cursor for it, and the next run tries it again. The other channels continue.
