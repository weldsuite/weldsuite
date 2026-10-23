# WeldSheets

A spreadsheet module for WeldSuite in the class of Google Sheets and Excel,
built entirely in-house: grid, formula engine, recalculation, live co-editing,
and the .xlsx/.csv reader and writer. No spreadsheet libraries.

## Decisions (agreed 2026-10-23)

| Question | Decision |
|---|---|
| Placement | Its own module (`/weldsheets`, own sidebar entry). Sheets are WeldDrive files. WeldFlow project sheets move to the new editor and the old grid (`app/weldflow/project/[projectId]/table/`) is retired. |
| Engine | Written from scratch. Nothing from the WeldFlow grid, no Univer, no SheetJS. |
| Collaboration | Real-time co-editing from day one: live edits, cursors and selections. |
| Backend | New `sheets-api` worker (`sheets-api(-test).weldsuite.org`), one per module. |
| Scale | Excel-scale: 1,048,576 rows × 16,384 columns per sheet, smooth at 1M filled rows. |
| v1 sheet features | Formulas, formatting, tabs, undo/redo, clipboard, import/export xlsx & csv, sort, filter, freeze, merge, conditional formatting, data validation, charts, pivot tables. |
| v1 platform features | Version history, comments with @mentions, per-sheet sharing, live WeldSuite data in sheets, WeldAgent tools. |

This supersedes FLOW-005 for sheets (documents are unchanged): a sheet's
source of truth is no longer an .xlsx in R2.

## Architecture

### `@weldsuite/sheets-engine` (`packages/core/sheets-engine`)

Pure TypeScript, zero dependencies, no DOM. The same code runs in the browser
(main thread or a Web Worker), in the `SheetRoom` Durable Object, and in any
worker that reads or writes sheets (exports, data refresh, agent tools).

- **Model**: `Workbook` → `Sheet[]`, each sheet addressed by a stable id (names
  change). Cells live in a sparse, row-block store behind a `CellStore`
  interface so the representation can move to columnar typed arrays for the
  1M-row target without touching callers. Styles are interned in a workbook
  style table; a cell holds a style id. Row and column sizes are sparse
  overrides over a default with prefix sums, so pixel offset ↔ index is a binary
  search.
- **Formulas**: own lexer, Pratt parser (AST), printer, evaluator and function
  library (Excel semantics and error values, so xlsx round-trips). Reference
  rewriting (insert/delete/move rows and columns, sheet rename) works on the
  token stream, which is also what operational transform uses.
- **Recalculation**: dependency graph with a point index for single-cell
  precedents and a bucketed spatial index for range precedents. A change marks
  its transitive dependents, which are evaluated in topological order
  (iterative DFS, no recursion, so a million-long chain cannot overflow the
  stack). Cycles evaluate to an error. Volatile functions (`NOW`, `RAND`,
  `INDIRECT`, `OFFSET`) recalc on every pass.
- **Operations**: every edit is a serialisable op (`setCells`, `setStyle`,
  `insertDims`, `deleteDims`, `moveDims`, `resizeDims`, `addSheet`, `merge`,
  `setFreeze`, …). `apply` returns the inverse op (undo), and
  `transform(a, b)` resolves concurrent ops, including rewriting formula
  references inside an op when rows or columns shift under it.
- **Formats**: Excel number format codes (parse + render), date serials, and
  input parsing (`12%`, `€1,000`, `1/2/2026`, `=…`).
- **Files**: own ZIP container on the platform `CompressionStream` /
  `DecompressionStream` (`deflate-raw`) and own OOXML (SpreadsheetML)
  reader/writer, plus CSV.

### Collaboration

Server-authoritative OT, the model Google Sheets uses. One `SheetRoom` Durable
Object (SQLite storage, WebSocket hibernation) per open sheet:

1. A client sends `{ baseRevision, ops }`.
2. The room transforms them against every op committed since `baseRevision`,
   applies them to its in-memory workbook, appends them to the op log with the
   next revision, acks the sender and broadcasts to the others.
3. Clients rebase rather than transform both ways: on an incoming op they undo
   their unacknowledged ops (the inverses `applyOp` returned), apply the
   incoming op, and re-apply their own as `transform(own, incoming, true)`,
   exactly what the room will compute. Every replica runs the same ops in the
   same order, so they agree even where the two transform directions do not
   commute (a range format racing the row/column style it inherits from).

Only inputs travel; each client recalculates locally (the engine is
deterministic apart from volatile functions). Presence (cursor, selection,
editing cell, colour) rides the same socket and is never persisted. Undo is
per user: the inverse of the user's own op, transformed through everything
committed after it.

The room checkpoints a snapshot to R2 every N ops and when the last client
leaves; the op log since the checkpoint stays in the DO. Snapshots are stored
in row chunks so a 1M-row sheet loads the visible part first.

### `sheets-api` worker

Hono on `@weldsuite/worker-kit`, owns `/api/sheets*`:

- `GET/POST /api/sheets`, `GET/PATCH/DELETE /api/sheets/:id` (metadata; the
  drive `files` row is created alongside)
- `GET /api/sheets/:id/connect` → WebSocket upgrade into `SheetRoom`
- `/api/sheets/:id/versions` (list, name, restore), `/comments`, `/members`
- `/api/sheets/:id/export?format=xlsx|csv`, `POST /api/sheets/import`
- `/api/sheets/:id/data-sources` (live WeldSuite data, below)
- Entity events: `sheet` created / updated (throttled) / deleted / shared,
  `sheet_comment` created.

### Platform UI (`apps/web/platform/app/weldsheets/`)

- Home: recent, shared with me, templates, import.
- Editor: canvas grid (cell layer + overlay layer for selection and remote
  cursors, DPR-aware, virtualised, frozen panes as four quadrants), DOM cell
  editor, formula bar with autocomplete, toolbar, sheet tabs, side panels
  (comments, version history, conditional formatting, data sources, AI).
- The UI talks to an `EngineClient` interface, so the engine can move into a
  Web Worker for large sheets without UI changes.

### Access

Workspace permissions open the door (`sheets:read|create|update|delete|share|manage`).
Per sheet: owner, editor, commenter, viewer, plus a general-access level for
the whole workspace (Google-style). Every route resolves access through one
`requireSheetAccess` helper; a sheet the caller cannot see is a 404.

### WeldSuite data and AI

- **Connected ranges**: insert a live table from a WeldSuite object (CRM
  customers, Books invoices, Commerce orders, …) with filters and columns;
  refreshed on open, on demand or on a schedule by `sheets-api` through the
  domain packages, written into the sheet as ops so collaborators see it live.
- **WeldAgent tools**: `sheets.read_range`, `sheets.write_range`,
  `sheets.create`, `sheets.find`, run server-side on the engine.

## Schema (needs approval before any migration)

The unused `sheets` table (`packages/core/db/src/schema/sheets.ts`, migration
0148) holds a jsonb snapshot, which cannot carry a 1M-row workbook. Proposed:

- `sheets`: add `revision`, `snapshot_key` (R2), `general_access`, `owner_id`;
  make `snapshot` nullable (dropped later).
- `sheet_members` (sheet, user, role)
- `sheet_versions` (sheet, revision, name, snapshot_key, created_by)
- `sheet_comments` (sheet, thread, anchor sheet id + cell, body, mentions,
  resolved)
- `sheet_data_sources` (sheet, target range, object type, query, refresh policy)

## Status

**Phase 1 (engine core): done**, in `packages/core/sheets-engine`.

- 337 functions across math, statistics, logical, info, text, date/time,
  lookup (dynamic arrays included) and financial; Excel number formats (en/nl);
  typed-input parsing; formula separators per locale (`;` and decimal comma
  for nl).
- Recalculation with spills; ops with exact inverses; transform checked by a
  convergence fuzz (400 random concurrent pairs in CI, 40,000 across 20 seeds
  when written).
- Measured (Node, 200k values + 200k dependent formulas): bulk load and
  calculate 1.0 s, a single edit 5 ms, a row insert 1.0 s (full graph rebuild),
  snapshot 90 ms / 12 MB.

Known gaps, to pick up in later phases:

- Row/column insert, delete and move rebuild the whole dependency graph
  (phase 9: incremental).
- Spilled arrays are not persisted, so every formula is evaluated on load
  (phase 9: store spills in the snapshot).
- SUBTOTAL/AGGREGATE do not skip hidden rows yet: the eval host has no row
  visibility (phase 4, with filters).
- No multi-area references (`(A1:B2,C3)`), structured table references, or
  LET/LAMBDA.
- Lookups lifted over many values rescan the key column each time; a
  per-pass lookup index would make exact matches O(1).
- A concurrent row move and delete across a merged range can leave replicas
  disagreeing about the merge; the room's checksum resync (phase 3) covers it.

## Phases (one PR each)

1. **Engine core**: model, addresses, values, number formats, formula
   lexer/parser/printer/evaluator, function library, dependency graph and
   recalculation, ops with apply/invert/transform. Unit tests.
2. **Editor, local only**: module registration (sidebar, routes, i18n, app
   store), canvas grid, editing, formula bar, toolbar, tabs, clipboard, undo.
3. **Backend + live co-editing**: `sheets-api`, `SheetRoom`, schema and
   migration, drive integration, presence.
4. **Sort, filter, freeze, merge, conditional formatting, data validation.**
5. **Files**: ZIP + xlsx reader/writer, csv, import/export from drive.
6. **Charts and pivot tables.**
7. **Version history, comments and mentions, sharing.**
8. **WeldSuite data and WeldAgent tools**; WeldFlow project sheets move to
   WeldSheets (existing .xlsx files convert on first open) and the old grid is
   deleted.
9. **Excel scale**: engine in a Web Worker, columnar cell storage, chunked
   snapshots and progressive load, benchmarks at 1M rows.
