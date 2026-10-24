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
  `setFreeze`, `setFilter`, `patchConditionalFormats`, `patchValidations`, …).
  `apply` returns the inverse op (undo), and
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

Every committed op is written to the room's storage before its ack leaves.
The room checkpoints the workbook (with its revision) to one R2 object per
sheet every 200 ops, 30 s after an edit and when the last client leaves, then
trims its log to the last 500 ops and records the checkpoint on the `sheets`
row. Row-chunked snapshots, so a 1M-row sheet loads the visible part first,
come with phase 9.

Browsers cannot send a bearer token on a WebSocket: `POST
/api/sheets/:id/session` (normal auth and access checks) asks the room for a
single-use ticket, and the socket (`/api/sheets/connect?ticket=…`) presents
it. Messages over 256 KB travel as numbered parts.

### `sheets-api` worker

Hono on `@weldsuite/worker-kit`, owns `/api/sheets*`:

- `GET/POST /api/sheets`, `GET/PATCH/DELETE /api/sheets/:id` (metadata; the
  drive `files` row is created alongside; delete moves it to the trash) — built
- `POST /api/sheets/:id/session` + `GET /api/sheets/connect?ticket=…` →
  WebSocket into `SheetRoom` — built
- `/api/sheets/:id/versions` (list, name, restore), `/comments`
- `GET /api/sheets/:id/export?format=xlsx|csv`, `POST /api/sheets/import`
  (an upload, or a WeldDrive file by id) — built
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
Per sheet, access is the WeldDrive role on its file (owner, editor, viewer:
ownership, shares, folders and general access), resolved in the sheets-api
routes; a sheet the caller cannot see is a 404. A commenter role (phase 7)
does not exist in WeldDrive yet.

### WeldSuite data and AI

- **Connected ranges**: insert a live table from a WeldSuite object (CRM
  customers, Books invoices, Commerce orders, …) with filters and columns;
  refreshed on open, on demand or on a schedule by `sheets-api` through the
  domain packages, written into the sheet as ops so collaborators see it live.
- **WeldAgent tools**: `sheets.read_range`, `sheets.write_range`,
  `sheets.create`, `sheets.find`, run server-side on the engine.

## Schema

Applied in phase 3 (migration `0221_weldsheets_room`, approved 2026-10-24):
`sheets` gained `revision`, `snapshot_key` (R2) and `snapshot_revision`, and
its unused jsonb `snapshot` became nullable (to be dropped). Owner and general
access are the drive file's, so `sheets` has no copy of them.

Still proposed (each needs approval before a migration):

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

**Phase 2 (editor, local only): done**, in `apps/web/platform/app/weldsheets`.

- Module registered: route `/weldsheets` (+ an unauthenticated `/preview/weldsheets`
  mirror for support videos and help screenshots), rail and module sidebar,
  `sheets:*` permissions with role defaults, `sheets` in api-modules (port 8822,
  `/api/sheets`, worker not built yet), reserved slug, app-store seed entry,
  en/nl translations.
- Editor: canvas grid (frozen panes, merges, text overflow and wrapping,
  borders, fills, number formats), in-cell editor and formula bar kept in sync,
  formula autocomplete, reference highlighting and point mode (click cells
  while typing a formula), toolbar (formats, fonts, colours, borders, merge,
  alignment, wrapping, freeze, Σ), sheet tabs (add, rename, duplicate,
  delete, colour, reorder), right-click menu (insert/delete/hide rows and
  columns), clipboard to and from Excel/Google Sheets, undo/redo,
  status-bar sum/average/count.
- Every edit goes through `SheetController.apply`.
- Storage was an IndexedDB store in the browser until phase 3; only the
  signed-out preview still uses it. The app only appears where an admin has
  installed it from the catalog.

**Phase 3 (backend and live co-editing): done.**

- `apps/workers/sheets-api`: the routes above, and the `SheetRoom` Durable
  Object around the engine's `RoomCore` (op log in its storage, checkpoints in
  R2, hibernatable sockets, single-use tickets). app-api forwards
  `/api/sheets*` to it, WebSocket upgrades included.
- Engine `collab/`: protocol, `RoomCore`, `CollabClient` (rebasing), message
  framing, `validateOp`; a simulation test runs a room and four clients
  through random edits, delays and reconnects and checks they converge.
- Platform: the home page lists sheets from sheets-api; an open sheet is
  edited through `SheetConnection` (reconnects, re-sends unconfirmed edits,
  warns before leaving with any); undo is moved past other people's ops;
  presence draws each person's selection in their colour with a name flag,
  with avatars in the header (click to jump to them).
- WeldDrive: a sheet is a drive file (`metadata.weldsheetId`) and opens in the
  editor from WeldDrive; purging it removes its `sheets` row too.
- `sheet` entity events: created, updated (rename, and content at each
  checkpoint), deleted.

**Phase 4 (sort, filter, conditional formatting, data validation): done.**
Freeze and merge came with phase 2.

- Engine `model/rules.ts` and `rules/evaluate.ts`: one `Condition` type
  (empty, text, number comparisons, between, custom formula) shared by
  filters, conditional formats and validation rules. Rules are part of the
  sheet and its snapshot, changed by three new ops (`setFilter`,
  `patchConditionalFormats`, `patchValidations`, the last two by rule id) with
  inverses, transforms and shape checks. Rule ranges and formulas follow row
  and column inserts, deletes and moves; undoing one brings back what it
  trimmed.
- Filter: one per sheet, its first row the header; per column, values to hide
  and/or a condition. Filtered rows are derived, not stored: they are worked
  out again after every recalculation, so a filter follows the data live.
  SUBTOTAL and AGGREGATE now skip hidden rows as in Excel (SUBTOTAL 1–11
  skips filtered rows, 101–111 manually hidden ones too) and nested subtotals.
- Sort: worked out in the client (`sortRangeOp`) and sent as plain cell and
  style writes, so it co-edits like a paste and undoes exactly. Formulas move
  like copied formulas, as in Excel. Blanks go last; numbers, then text,
  booleans, errors. A range with merged cells is not sorted.
- Conditional formatting: a condition with a style (fill, text colour, bold,
  italic, underline, strikethrough), or a colour scale of two or three points.
  Rules are ordered; the first that matches a cell wins.
- Data validation: dropdown (listed items or a range), checkbox, or a
  condition; invalid input is rejected or marked. A rejected entry keeps the
  cell editor open with a message; formula results and pasted values are only
  marked. Checkboxes toggle by click or Space.
- Editor: filter buttons with a menu (sort, filter by condition, by values
  with search), toolbar (filter, sort A→Z / Z→A, a sort dialog with several
  keys), side panels for conditional formatting and data validation, and
  right-click entries for both.

**Phase 5 (files): done.**

- Engine `files/`: a ZIP reader and writer on the platform's
  `CompressionStream` / `DecompressionStream` (ZIP64 on read; every entry
  inflated against a size budget, so a zip bomb stops with an error), a small
  XML scanner (no DTDs, no entity expansion), and SpreadsheetML in both
  directions: values and formulas with their last values (shared and array
  formulas on read; spilled formulas written as Excel 365 dynamic arrays;
  `_xlfn.` prefixes dropped and added), styles (fonts, fills, borders,
  alignment, number formats; theme and indexed colours on read), column
  widths and row heights, hidden rows and columns, merges, frozen panes, tab
  colours, hidden sheets, defined names, the filter, conditional formats
  (condition rules and colour scales) and data validation (including Excel
  2010's cross-sheet lists). CSV and TSV: reading as typed input in the
  reader's locale (separator detected), writing displayed values (';' where
  the decimal is a comma).
- What a file has that WeldSheets does not (charts and pictures, comments,
  pivot tables, table styles, data bars and icon sets, macros, links to other
  files, formatting within a cell) is left out, and the import says so.
  Formulas WeldSheets cannot read keep their last value.
- sheets-api: `POST /api/sheets/import` makes a new spreadsheet from an
  upload or a WeldDrive file (next to it when the caller may add there; the
  file stays as it is), up to 25 MB and 250,000 cells until phase 9.
  `GET /api/sheets/:id/export` is written by the sheet's room from its live
  workbook, so it includes edits not yet checkpointed. sheets-api now reads
  the public `STORAGE` bucket too, for drive files uploaded before private
  storage.
- Platform: "Import a file" on the WeldSheets home page (the preview reads
  the file in the browser); a Download menu in the sheet header (.xlsx, or
  the current tab as .csv), written in the browser from the editor's own
  workbook; in WeldDrive, "Open in WeldSheets" on .xlsx, .csv and .tsv files,
  and WeldSheets files download as .xlsx.

Known gaps, to pick up in later phases:

- Autofill (dragging the fill handle) and auto-fit on double-clicking a
  column border are not built yet; a double-click resets the size.
- Comments, sharing UI and version history arrive in phase 7.
- A sheet trashed from WeldSheets gets no automatic 30-day purge (the
  `TrashCleanupWorkflow` is app-api's); emptying the WeldDrive trash removes
  it. A purged sheet's room storage stays behind.
- No state checksums between replicas yet; rebasing keeps them in step, and a
  rejected batch reloads the client from the room.

- Row/column insert, delete and move rebuild the whole dependency graph
  (phase 9: incremental).
- Spilled arrays are not persisted, so every formula is evaluated on load
  (phase 9: store spills in the snapshot).
- Files: no .xls (binary), .ods or Numbers; imports always make a new
  spreadsheet (no "insert as new tabs" or "replace"); a whole-number or date
  validation rule comes in as a number rule; a list rule over 255 characters
  or with commas in its items is left out of an .xlsx.
- One filter per sheet; no filter views or slicers. Ctrl+Enter and paste
  write past a strict validation rule (the values are marked).
- No multi-area references (`(A1:B2,C3)`), structured table references, or
  LET/LAMBDA.
- Lookups lifted over many values rescan the key column each time; a
  per-pass lookup index would make exact matches O(1).

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
