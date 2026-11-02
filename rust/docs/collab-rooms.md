# Collaborative rooms on Kubernetes (WeldDocs, WeldSheets)

On Global every open document or spreadsheet is one Durable Object
(`DocRoom` in `apps/workers/docs-api`, `SheetRoom` in
`apps/workers/sheets-api`): it orders the edits (`RoomCore` from
`@weldsuite/collab` on the engine's OT adapter), holds the sockets, logs every
committed op in its own storage before the ack leaves, checkpoints the whole
document to R2 (every 200 ops, 30 s after an edit, when the last person
leaves), records the checkpoint on the tenant row and announces `doc:updated` /
`sheet:updated`. SheetRoom also runs connected-table refreshes on its alarm and
the agent tools' reads and writes. The engines (`@weldsuite/docs-engine`,
`@weldsuite/sheets-engine`, ~37k lines) are shared with the browser.

The Kubernetes editions run those classes unchanged, in Node, beside the Rust
server. No engine is rewritten.

## Shape

```
browser ──/api/docs/*, /api/sheets/*──▶ weldsuite serve (Rust: modules/docs, modules/sheets)
   │                                          │  POST /rpc {binding, name, method, args}
   │                                          ▼  (owner pod by room id)
   └──wss /api/{docs,sheets}/connect──▶ Rust proxy ──▶ collab-rooms-N (Node: DocRoom, SheetRoom)
                                                          │ S3 (private bucket), tenant Postgres,
                                                          └─ entity events → POST /internal/collab/events
```

- **`apps/tools/collab-rooms`** (image: `rust/Dockerfile --target collab-rooms`)
  bundles `DocRoom` and `SheetRoom` from the workers with a Durable Object
  runtime for Node (`src/runtime/`): `ctx.storage` is kept in memory and
  written through to S3, one object per key under
  `collab-rooms/<binding>/<room id>/`, with the output gate (a socket send
  waits for the writes issued before it) and per-socket input order;
  sockets are `ws` with attachments; alarms are timers, retried on failure;
  `PRIVATE_STORAGE` / `STORAGE` are the S3 buckets; the tenant database is
  node-postgres, its URL opened from the master with the same keys as Rust;
  `ENTITY_EVENTS.send` posts the hub message to Rust, which publishes it on
  its bus. Rooms stay in memory while a socket is open and are dropped
  after a checkpoint once idle (Durable Object hibernation, without the
  hibernation).
- **Protocol** (all with `x-internal-secret: COLLAB_ROOMS_SECRET`):
  `POST /rpc { binding, name, method, args }` → `200 { result }` / `500
  { error }`, the conformance ledger bridge's wire format, `Uint8Array`
  values as `{ "$bytes": base64 }`. Bindings: `DOC_ROOM`, `SHEET_ROOM` (a
  method of the room named `name`, as `ns.get(ns.idFromName(name))`), and
  `DOC_ENGINE`, `SHEET_ENGINE`: engine work the REST routes need (a new
  document's snapshot, imports, exports), the functions in each worker's
  `src/engine-ops.ts`. Sockets: `GET /api/docs/connect?ticket=…`,
  `/api/sheets/connect`, as on Global.
- **Room ids and sharding**: a room's id is `sha256("<binding>:<name>")` in
  hex, the prefix of its tickets (`<id>.<secret>`), as `idFromName` is on
  Global. The chart runs a StatefulSet; Rust gets the pod URLs
  (`COLLAB_ROOMS_URLS`) and sends a room's RPCs and its sockets to the pod
  that wins rendezvous hashing on the room id, so a ticket is redeemed on the
  pod that issued it and one room lives on one pod. Engine calls go to any
  pod.
- **Persistence**: checkpoints, versions and exports at Global's keys
  (`workspaces/<org>/docs/<id>/…`). Op log entries are written create-only
  (`If-None-Match: *`): while the pod set changes, a room that a second pod
  also holds fails its next commit and reloads from S3, instead of forking the
  document. Tickets live in memory only (a minute, single use).
- **Rust**: serves every REST route (`modules/docs`, `modules/sheets`), the
  room calls through the `CollabRooms` port (`weldsuite_ports::collab`; HTTP
  adapter `adapters-oss/src/collab.rs`; in conformance the test's own
  `fakeRoomNamespace` and engine through `ledger-bridge.ts`), proxies the
  two socket paths outside the session pipeline (the ticket is the
  credential), and answers `POST /internal/collab/events`.

Without `COLLAB_ROOMS_URLS` (the chart's `collabRooms.enabled: false`)
every route that needs a room or an engine (create, session, live
snapshot, version save and restore) answers 503 `Live editing is not
configured`; the records can still be listed, renamed, moved and trashed.

Tests: `apps/tools/collab-rooms/test` (two editors on the engines' own
`CollabClient`, a second service catching up from the op log, the
checkpoint); `apps/tools/collab-rooms/scripts/e2e.ts` (the Rust server,
this service and an S3 stand-in on real databases, or `--pglite`); the
kind smoke test opens a room socket through the server.

## Status

- WeldDocs: ported (`modules/docs`, suite `docs`).
- WeldSheets: the service hosts `SheetRoom` and the engine functions its
  routes need (`apps/workers/sheets-api/src/engine-ops.ts`: a new
  workbook, imports, legacy conversions, version exports), and the
  response schemas are registered; `modules/sheets` (the REST routes) is
  not written yet. Connected tables: their listing code
  (`services/data-sources`) runs in `SheetRoom` for scheduled refreshes
  already; the routes' refresh can call the same code as an engine
  function with the workspace's database rather than porting it to Rust.

Global is untouched: the workers keep their Durable Objects.
