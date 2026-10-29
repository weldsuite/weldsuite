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
row. A checkpoint carries every formula's last result and the arrays formulas
spill (`calculated`), so loading one evaluates only volatile formulas.
Row-chunked snapshots that load the visible part of a sheet first are not
built (see phase 9).

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
- `/api/sheets/:id/versions` (list, name, rename, snapshot, .xlsx export,
  restore) — built
- `GET /api/sheets/:id/export?format=xlsx|csv`, `POST /api/sheets/import`
  (an upload, or a WeldDrive file by id) — built
- `/api/sheets/:id/data-sources` (live WeldSuite data, below) — built
- `POST /api/sheets/convert`: an old WeldFlow project sheet made a spreadsheet
  in place — built
- `SheetsInternal` (a WorkerEntrypoint, bound as `SHEETS_INTERNAL` in
  agent-api, chat-api and app-api): the WeldAgent tools — built
- Entity events: `sheet` created / updated (throttled) / deleted,
  `sheet_version` created / updated, `sheet_data_source` created / updated /
  deleted. Comments are part of the workbook and have no events; a mention
  sends a notification.

### Platform UI (`apps/web/platform/app/weldsheets/`)

- Home: recent, shared with me, templates, import.
- Editor: canvas grid (cell layer + overlay layer for selection and remote
  cursors, DPR-aware, virtualised, frozen panes as four quadrants), DOM cell
  editor, formula bar with autocomplete, toolbar, sheet tabs, side panels
  (comments, version history, conditional formatting, data sources, AI).
- The editor (`SheetController`) calls the engine directly on the main
  thread; it does not run in a Web Worker (see phase 9).

### Access

Workspace permissions open the door (`sheets:read|create|update|delete|share|manage`).
Per sheet, access is the WeldDrive role on its file (owner, editor, viewer:
ownership, shares, folders and general access), resolved in the sheets-api
routes; a sheet the caller cannot see is a 404. A commenter is a Drive viewer
who holds `sheets:comment` (MEMBER and up by default): the room lets them add,
edit and delete their own comments and resolve any thread, and refuses every
other op from them (`room/comment-access.ts`), as WeldDocs does. A WeldFlow
project sheet follows the project's membership instead of Drive roles.

### WeldSuite data and AI

- **Connected tables**: a block of a sheet filled with records of one
  WeldSuite object (companies, people, leads, opportunities, quotes, tickets,
  projects, tasks, products, orders, invoices): chosen fields as columns under
  their own titles, filters, an order and a limit (up to 10,000 records).
  Refreshed by hand or every hour or day (the sheet room's alarm), written
  into the sheet as ops so collaborators see it live. Records are listed with
  the access of the person who connected the table; whoever changes what it
  lists becomes that person, and a scheduled refresh stops (with a reason on
  the table) when they lose the object's permission or edit access to the
  sheet. A new table goes on a tab of its own, named after its object, at
  A1 with its header row frozen and filtered; the sheet grows to hold every
  record, and a filter on the table's header follows it on each refresh.
- **WeldAgent tools**: `find_spreadsheets`, `create_spreadsheet`,
  `list_spreadsheet_tabs`, `read_spreadsheet_range`,
  `write_spreadsheet_range`, run in sheets-api on the engine (writes through
  the sheet's room) for the user the agent acts for.

## Schema

Applied in phase 3 (migration `0221_weldsheets_room`, approved 2026-10-24):
`sheets` gained `revision`, `snapshot_key` (R2) and `snapshot_revision`, and
its unused jsonb `snapshot` became nullable (to be dropped). Owner and general
access are the drive file's, so `sheets` has no copy of them.

Applied in phases 7 and 8 (migration `0227_weldsheets_versions_data_sources`,
approved 2026-10-25): `sheet_versions` (sheet, revision, name, snapshot key,
size, created by; a named version, or the automatic one kept before a
restore), `sheet_data_sources` (sheet, object type, definition, refresh
policy, next and last refresh, last error, row count, created by), and
`sheets.snapshot` dropped. Comments are entries in the workbook (a
`patchComments` op), so there is no comments table.

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
- What a file has that WeldSheets does not (pictures, comments, pivot
  tables, table styles, data bars and icon sets, macros, links to other
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

**Phase 6 (charts and pivot tables): done.**

- Charts are part of the sheet (`sheet.charts`, in its snapshot), changed by
  a `patchCharts` op (by chart id, like the rule ops) with an inverse,
  transforms and shape checks. A chart has a type (column, bar, line and area,
  each also stacked or 100% stacked; pie, doughnut, scatter), series and
  categories as absolute, sheet-qualified references (`Sheet1!$B$2:$B$9`),
  a title, axis titles, a legend position, and a place: a cell plus an offset
  in pixels, and a size in pixels. Its references follow row and column
  inserts, deletes and moves and sheet renames like formulas; when its anchor
  row or column is deleted it moves to the next one.
- WeldSheets draws charts itself on the grid canvas
  (`editor/charts/draw-chart.ts`, no chart library): over the cells,
  scrolling with their anchor cell (one anchored in a frozen pane stays put).
  A chart is picked with a click, moved, resized with eight handles, deleted
  with Delete, and every change undoes. "Insert chart" (toolbar, right-click)
  charts the selection, or the block of data around a single cell: series
  along its longer side, names and labels where there is text, a line chart
  over dates. The chart editor panel changes the type, the data range (rows
  or columns, headers, labels), series colours, titles and legend, saving as
  it goes.
- Pivot tables are a spilling formula,
  `PIVOT(source, rows, columns, values, [filters], [totals])`, for example
  `=PIVOT(Data!$A$1:$E$500, "Region", "Year", "SUM:Amount")`: field names
  for rows and columns (`-Name` sorts descending), `FUNCTION:Field` for
  values (SUM, COUNTA, COUNT, AVERAGE, MIN, MAX, COUNTUNIQUE, MEDIAN), a
  two-column array of field and shown value for filters, totals on unless
  FALSE. Being a formula, a pivot table recalculates live, co-edits and
  undoes as one cell and follows its source when rows and columns move; it
  needs no op or storage of its own. Its labels are English ("SUM of Amount",
  "Grand Total").
- "Create pivot table" (toolbar, right-click) puts one on a new sheet or at a
  given cell, starting with the first text field as rows and the sum of the
  first number field. The pivot editor panel opens when a cell of a pivot
  table is selected and rewrites its formula: source, rows, columns and their
  order, values and how they are summarised, filters (a checklist of the
  field's values), totals. Headings and totals show bold, and values take the
  number format of the field they sum (counts do not); a cell's own format
  wins.
- Files: charts are written to .xlsx as DrawingML charts with cached values,
  so Excel shows them before it recalculates, and read back from Excel files
  (bar, column, line, area, pie, doughnut, scatter; other chart types,
  pictures and shapes are left out, and the import says so). Pivot tables are
  exported as their values; Excel pivot tables are not imported.
- Phase 6 gaps: no combo charts, secondary axes, trendlines or data labels;
  a duplicated sheet's charts still read the original sheet. Pivot tables
  have no calculated fields, date grouping, "show as % of" or drill-down, and
  the editor works out each pivot table's layout again after every change to
  style it (phase 9 moves calculation into a worker).

**Phase 7 (version history, comments, sharing): done.**

- Version history as in WeldDocs: name the current version, rename one,
  download one as .xlsx, or restore one. A restore keeps the sheet as it was
  as an automatic version first, so it can be undone by restoring that; the
  room sends everyone the restored workbook.
- Comments are threads on cells, entries in the workbook set by a
  `patchComments` op, so they co-edit, follow rows and columns as they move,
  and survive a deleted cell (detached, the thread stays). @mentions notify
  the person mentioned when they can open the sheet, and only for the
  author's own comment. A comments panel (open, resolved, all), a composer on
  the active cell (Ctrl+Alt+M, right-click), resolve and reopen, edit and
  delete your own; a corner mark on commented cells. Comments are not part of
  undo.
- Commenters (above) see comments and version history on a read-only sheet.
- Share opens the WeldDrive sharing dialog for the sheet's file; a project
  sheet says its access follows the project and offers its link.

**Phase 8 (WeldSuite data, WeldAgent tools, WeldFlow project sheets): done.**

- Connected tables and the agent tools (above). A WeldSuite data panel
  connects, edits, refreshes and disconnects tables (disconnecting leaves the
  values). On the grid a table has a tinted header row and banded records,
  and while the active cell is in it a chip with its object's name: pressing
  it selects the whole table, and its menu refreshes, filters, edits or
  disconnects it.
- Sheets start at 1,000 rows (like Google Sheets); a bar under the last row
  adds more (1,000 by default), and a paste past the last row or column
  grows the sheet to fit.
- WeldFlow project sheets are WeldSheets spreadsheets that live with the
  project: created, renamed, duplicated and deleted from the project's Sheets
  page, opened in the WeldSheets editor inside the project. An .xlsx saved by
  the old grid becomes a spreadsheet in place the first time anyone opens it
  (same file and link; formats, widths, dropdown columns, links and notes
  carried over, notes as comments); one too big to open is refused. The old
  grid, its strings, `xlsx-js-style` and flow-api's create-sheet route are
  gone.

**Phase 9 (scale): partly done.** Measured with
`pnpm --filter @weldsuite/sheets-engine bench` (Node 22, one machine: two
number columns, a formula reading them, a running total and three
whole-column aggregates; 4 cells a row, half formulas):

| 1,000,000 rows | before | after |
|---|---|---|
| Heap | 2,550 MB (669 B/cell) | 1,013 MB (265 B/cell) |
| Load a checkpoint (parse excluded) | 31.6 s | 7.6 s |
| Load and calculate a new workbook | 24.8 s | 17.2 s |
| Edit one value (+ a whole-column SUM) | 0.7 s | 0.4 s |
| Edit the start of a 1M-long chain | 6.9 s | 5.6 s |
| Insert / delete a row near the top | 36 s | 21–23 s |
| Insert a column after the data | 34 s | 4.9 s |

At 100,000 rows: a checkpoint loads in 0.35 s (was 1.26 s) and a row insert
takes 1.1 s (was 2.4 s).

- Dependency graph: a cell read by one formula holds that formula's key
  rather than a set, and single-cell precedents are kept as numbers. Parsed
  formulas are cached up to 100,000 and parsed again past that.
- Checkpoints carry results and spills (above). A spilling formula caught in
  a cycle now drops its last array (replicas could show different stale
  values).
- Inserting, deleting or moving rows and columns no longer rebuilds the graph
  and re-evaluates every formula: only formulas that moved or were rewritten
  are read again, and only those whose result can change are evaluated (a
  range cut through, a deleted cell read, ROW and COLUMN, spills on that
  sheet). A rewritten defined name still rebuilds everything. A fuzz test
  checks the result against evaluating every formula again.
- Not done: columnar cell storage (a cell still costs about 110 bytes), the
  engine in a Web Worker (a long recalculation blocks the editor), row-chunked
  snapshots with progressive load, and raised import limits. A sheet's room
  holds the whole workbook in a Durable Object with 128 MB, so imports stay at
  250,000 cells; a co-edited sheet of a million rows needs a room that does not
  hold every cell in memory. A row insert at the top of a million formulas is
  bound by rewriting their text (A1 references); shared relative formulas would
  remove that.

**Editing comforts: done.**

- Autofill: dragging the fill handle continues a selection down, up, left
  or right (`editor/model/autofill.ts`): numbers and dates as a linear series
  (Excel's least-squares trend for uneven steps; dates on the same day of the
  month step by months), one number copies and one date counts by a day,
  "Item 1" counts on keeping its zeros, weekday and month names go round (en
  and the sheet's locale), formulas move like copies, anything else repeats,
  styles repeat. Ctrl while dragging copies instead. Pulling the handle back
  inside the selection clears what it left; a double-click fills down as far
  as the column next to it. A hint shows what the last cell gets. Ctrl+D and
  Ctrl+R copy down and right. Fills are plain cell and style writes, so they
  co-edit and undo as one step (at most 1,000,000 cells).
- Dragging a selection by its outline moves it (Ctrl: copies); dragging
  selected whole columns or rows by their headers moves them (`moveDims`).
  A move, like a cut and paste, points formulas that read the moved cells
  (and those inside the block) at where the cells went. Selections, fills
  and moves scroll the grid when held past its edge.
- A double-click on a header border fits the column or row to its contents
  ("Fit to data" in the menu for selected columns or rows).
- Find and replace (Ctrl+F, Ctrl+H): match case, whole cell, in formulas,
  across sheets; replace all is one undo step.
- Paste values only (Ctrl+Shift+V, right-click), Ctrl+; and Ctrl+Shift+;
  (date and time now), Ctrl+\ (clear formatting), Ctrl+5 (strikethrough).

Known gaps, to pick up in later phases:

- Autofill has no custom lists and no "Series" dialog (step and stop
  value); a move does not rewrite references from other spreadsheets or
  defined names, and a cut to another sheet keeps formulas as they were.
- Comments have no reactions or attachments; a mention
  of someone who cannot open the sheet is not offered sharing.
- Connected tables cannot join objects or group rows, and custom fields and
  custom objects are not offered.
- A sheet trashed from WeldSheets gets no automatic 30-day purge (the
  `TrashCleanupWorkflow` is app-api's); emptying the WeldDrive trash removes
  it. A purged sheet's room storage stays behind.
- No state checksums between replicas yet; rebasing keeps them in step, and a
  rejected batch reloads the client from the room.

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
   snapshots and progressive load, benchmarks at 1M rows. (Benchmarks, graph
   memory, stored results and incremental row/column changes are done; the
   rest is open, see Status.)
