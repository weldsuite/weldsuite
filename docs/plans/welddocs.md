# WeldDocs

A word processor for WeldSuite in the class of Google Docs and Microsoft Word,
built entirely in-house: document model, text layout and pagination, editing,
live co-editing, and the .docx and PDF reader/writers. No editor, layout,
document or file-format libraries. It follows WeldSheets
([weldsheets.md](weldsheets.md)) in layout, architecture and phasing.

## Decisions to make

Proposed answers, to confirm before phase 1 starts.

| Question | Proposal | Alternatives |
|---|---|---|
| Placement | Its own module (`/welddocs`, own rail and sidebar entry). Documents are WeldDrive files. | A WeldFlow sub-page. |
| Engine | Written from scratch: `@weldsuite/docs-engine`, pure TypeScript, zero dependencies, no DOM. Nothing from BlockNote, the `paginated-doc-editor` or `@weldsuite/ui/lib/editor-commands`. | — |
| Rendering | Own layout engine (line breaking, pagination) drawing **DOM pages**: each laid-out line is an absolutely positioned element, pages are virtualised, caret and selection are an overlay we draw, typing and IME go through a hidden textarea. Like Word Online. | **Canvas** per page (Google Docs since 2021, the WeldSheets grid): fastest, but selection, IME and accessibility are all ours. **contenteditable** driven by our model through `beforeinput`: native IME and spellcheck, but pagination, headers/footers and exact layout are approximate. |
| Page model | Paged by default (A4/Letter, margins, orientation, headers/footers, page numbers), with a pageless view per document as in Google Docs. | Paged only. |
| Collaboration | Real-time co-editing, server-authoritative OT in a `DocRoom` Durable Object, the WeldSheets model. | Yjs-style CRDT (would need a library or a CRDT of our own; the `docs.yjs_state` column was reserved for one). |
| Backend | New `docs-api` worker (`docs-api(-test).weldsuite.org`, port 8824), path `/api/docs`. `/api/documents` stays with flow-api until phase 8. | — |
| Existing documents | WeldDocs replaces the current document stack: `docs` rows (BlockNote JSON) and legacy .docx convert on first open, `/documents/:fileId` and WeldFlow project documents open in WeldDocs, and the old editors are deleted (phase 8). | Keep both. |
| Shared code with WeldSheets | Move the ZIP container and XML scanner out of `sheets-engine/files` into a shared zero-dependency package, and make the collab `RoomCore` / `CollabClient` generic over the op type so both engines use one implementation. | Copy them into docs-engine. |
| Spell check | Browser spellcheck does not reach text we draw ourselves. v1 ships without; a later phase adds our own checker (Hunspell-format dictionaries for en and nl, read by our own code) and grammar through `@weldsuite/ai`. | Fall back to a contenteditable surface (see Rendering). |
| PDF export | Our own PDF writer: text, vector shapes and images; fonts embedded as subsets by our own TrueType/OpenType subsetter. | Browser print-to-PDF only. |

## Architecture

### `@weldsuite/docs-engine` (`packages/core/docs-engine`)

Pure TypeScript, zero dependencies, no DOM. The same code runs in the browser,
in the `DocRoom` Durable Object, and in any worker that reads or writes
documents (exports, imports, agent tools).

- **Model: one linear sequence**, the model Google Docs uses. A document is a
  sequence of characters in which structure is marked by control characters:
  a paragraph ends with a paragraph mark, tables are delimited by table, row
  and cell marks, and inline objects (images, page and section breaks,
  footnote refs, page-number fields, mentions) are single placeholder
  characters. Every position in the document is one integer, which keeps ops
  and their transforms small and provable.
  - Text lives in a balanced tree of chunks with summed lengths (a rope), so
    an edit, a position lookup and a paragraph lookup are O(log n) on a
    500-page document.
  - **Character styles** (font, size, bold, italic, underline, strikethrough,
    colour, highlight, super/subscript, link) are runs over the sequence, each
    pointing to an interned style in a document style table.
  - **Paragraph properties** (named style, alignment, indents, spacing, line
    height, list id and level, keep-with-next, page break before, borders,
    shading) hang off the paragraph mark, as in Word.
  - **Named styles** (Normal, Title, Subtitle, Heading 1–6, Quote, Code, and
    custom) with inheritance; editing a style updates every paragraph using it.
  - **Lists**: list definitions (bullet glyphs, numbering formats per level,
    restart) shared by paragraphs; checklists are a list kind.
  - **Sections**: page size, orientation, margins, columns, header/footer per
    section (first page / odd / even), page-number format. A section break is
    a placeholder character.
  - **Separate stories** for headers, footers and footnotes, each its own
    sequence addressed by id, edited with the same ops.
  - **Anchors** (comments, suggestions, bookmarks, remote cursors) are ranges
    that ops move along, never stored as characters.
- **Operations**: every edit is a serialisable op: `insertText`,
  `deleteRange`, `setTextStyle`, `setParagraphStyle`, `insertObject`,
  `setObjectProps`, `table*` (insert/delete row or column, merge, size,
  cell props), `setSection`, `patchStyles`, `patchLists`, `patchAnchors`.
  `apply` returns the inverse op (undo) and `transform(a, b)` resolves
  concurrent ops. Structural validity (balanced table marks, a final paragraph
  mark) is an invariant every op keeps, checked by `validateOp` and a
  convergence fuzz like WeldSheets'.
- **Layout** (`layout/`): measurement behind a `TextMeasurer` interface (canvas
  `measureText` in the browser, a metrics table in Node for tests and the
  server), so the same layout runs everywhere.
  - Line breaking on Unicode break opportunities (spaces, hyphens, soft
    hyphens, CJK between characters), justification, tabs and tab stops,
    leaders.
  - Pagination: lines flow into page boxes per section; widow/orphan control,
    keep-with-next, keep lines together, page break before; table rows split
    across pages with a repeating header row; headers, footers and footnotes
    reserve their space.
  - Incremental: a paragraph's lines are cached by its content version;
    an edit re-lays its paragraph and re-paginates forward only until page
    breaks line up with the previous layout again.
  - Geometry queries: position → caret rectangle, point → position,
    range → selection rectangles, line/word/paragraph boundaries for
    keyboard movement.
- **Serialisation**: a compact snapshot format (JSON with the text as one
  string plus run and property tables) for storage, and plain text, HTML and
  Markdown in both directions (HTML in is what paste from Word and Google Docs
  gives us).
- **Files** (`files/`): own WordprocessingML (.docx) reader and writer on the
  shared ZIP and XML layer, and own PDF writer.

### Collaboration

The WeldSheets model, unchanged: a `DocRoom` Durable Object per open document
(SQLite storage, WebSocket hibernation) orders ops, transforms late arrivals
against what was committed since their base revision, writes each op to its
storage before the ack, broadcasts, and checkpoints the snapshot to R2 (every
200 ops, 30 s after an edit, when the last client leaves). Clients rebase their
unconfirmed ops on incoming ones. Presence (caret, selection, colour, name) on
the same socket, never persisted. Undo is per user. Tickets for the socket
through `POST /api/docs/:id/session`, as for sheets.

### `docs-api` worker

Hono on `@weldsuite/worker-kit`, owns `/api/docs*`:

- `GET/POST /api/docs`, `GET/PATCH/DELETE /api/docs/:id` (metadata; the drive
  `files` row is created alongside; delete moves it to the trash)
- `POST /api/docs/:id/session` + `GET /api/docs/connect?ticket=…` → `DocRoom`
- `/api/docs/:id/versions` (list, name, restore), `/comments`
- `GET /api/docs/:id/export?format=docx|pdf|html|md|txt`,
  `POST /api/docs/import` (an upload, or a WeldDrive file by id)
- Entity events: `doc` created / updated (at checkpoints) / deleted / shared,
  `doc_comment` created.

### Platform UI (`apps/web/platform/app/welddocs/`)

Same structure and chrome as `app/weldsheets/`:

- `layout.tsx` (breadcrumb root → `AppHeader` → `ModuleContent`, gated on the
  app being installed and `docs:read`), `page.tsx` home (recent, shared with
  me, templates, new document, import a file).
- `doc/`: `page.tsx`, `doc-chrome.tsx` (title, star, move, saved state, peer
  avatars, Share, Download menu), `live-doc.tsx` / `local-doc.tsx` (room vs
  IndexedDB for the signed-out preview).
- `editor/`: menu bar (File, Edit, View, Insert, Format, Tools), toolbar
  (undo/redo, print, zoom, style picker, font, size, bold/italic/underline,
  colour, highlight, link, comment, image, alignment, line spacing, lists,
  indent, clear formatting, editing/suggesting/viewing mode), horizontal and
  vertical rulers (margins, indents, tab stops by drag), the page view, a
  document outline side panel, find & replace, word count, page setup dialog,
  status bar.
- `editor/model/doc-controller.ts`: every edit goes through it, as
  `SheetController` does for sheets; keyboard map in `keyboard.ts`, clipboard
  in `clipboard.ts`.
- `editor/view/`: page renderer, caret and selection overlay, remote carets,
  hidden-textarea input (composition events for IME), drag-select, drag-drop
  of text and images, table and image handles.
- `collab/doc-connection.ts` on the shared collab client.
- Routes `src/routes/welddocs/{route,index,$docId/index}.tsx` and the
  unauthenticated `/preview/welddocs` mirror (support videos and help
  screenshots).

### Access

Workspace permissions open the door (`docs:read|create|update|delete|share|manage`).
Per document, access is the WeldDrive role on its file (owner, editor, viewer),
resolved through `@weldsuite/core-domain/drive-access`; a document the caller
cannot see is a 404. Commenter and suggester roles need a WeldDrive role that
does not exist yet (phase 7).

### WeldSuite data and AI (phase 8)

- **Smart chips**: @mention a person, a CRM customer, a WeldFlow task, a date;
  rendered live from the record.
- **WeldAgent tools**: `docs.read`, `docs.find`, `docs.create`,
  `docs.insert` / `docs.replace` (as ops, so collaborators see the agent
  write), run server-side on the engine.
- **Writing help** through `@weldsuite/ai`: rewrite, summarise, translate a
  selection, charged with `chargeAiUsage`.

## Schema

Each change needs approval before a migration.

- Reuse the `docs` table (it is already 1:1 with a drive `files` row): add
  `revision`, `snapshot_key` (R2) and `snapshot_revision`, make `content`
  nullable (kept read-only so phase 8 can convert BlockNote documents, then
  dropped) and drop `yjs_state` (never used).
- `doc_versions` (doc, revision, name, snapshot_key, created_by); the existing
  `document_versions` rows convert with their documents.
- `doc_comments` (doc, thread, anchor, body, mentions, resolved, suggestion
  link).

## Phases (one PR each)

1. **Engine core**: linear model on a rope, styles, paragraph properties,
   lists, sections and stories, anchors, ops with apply/invert/transform,
   `validateOp`, snapshot and plain text/HTML/Markdown serialisation.
   Convergence fuzz. Shared ZIP/XML package and generic collab core
   extracted from sheets-engine (sheets tests stay green).
2. **Layout engine**: `TextMeasurer`, line breaking, justification, tabs,
   pagination with widow/orphan and keep rules, headers/footers, incremental
   relayout, geometry queries. Benchmarks: a 300-page document lays out in
   under 1 s, an edit relays in under 16 ms.
3. **Editor, local only**: module registration (rail, sidebar, routes, i18n
   en/nl, `docs:*` permissions with role defaults, app-store seed, reserved
   slug, `docs` in api-modules), home page, page view, caret and selection,
   typing and IME, keyboard navigation, menu bar and toolbar, rulers, styles,
   lists, links, undo/redo, clipboard to and from Word and Google Docs, find
   & replace, word count, page setup, headers/footers and page numbers,
   outline, pageless view, print. IndexedDB storage until phase 4.
4. **Backend and live co-editing**: `docs-api`, `DocRoom`, schema and
   migration, WeldDrive integration (create, open, trash, "Open in WeldDocs"),
   presence with remote carets and avatars, entity events.
5. **Tables, images and layout objects**: tables (insert, resize, merge and
   split, borders, shading, header rows, nested tables), images (inline,
   wrapped, resize, crop, upload to drive), page and section breaks, columns,
   footnotes, table of contents, horizontal rules, equations later.
6. **Files**: .docx reader and writer (styles, numbering, sections,
   headers/footers, tables, images, footnotes, comments and tracked changes
   once phase 7 exists), PDF writer with embedded font subsets, HTML, Markdown
   and text export; import from WeldDrive; "Open in WeldDocs" on .docx, .md,
   .txt and .html.
7. **Review**: comments with @mentions and replies, suggesting mode (tracked
   insertions, deletions and formatting with accept/reject), version history
   (named versions, restore, compare), sharing dialog, commenter role.
8. **Migration, WeldSuite data and AI**: BlockNote documents and legacy .docx
   convert on first open, `/documents/:fileId` and WeldFlow project
   documents open in WeldDocs, BlockNote document editor and
   `paginated-doc-editor` deleted, flow-api `/api/documents` retired; smart
   chips, WeldAgent tools, writing help, templates.
9. **Polish and scale**: own spell checker (en, nl), accessibility (a
   screen-reader mirror of the visible text and caret), right-to-left and
   bidirectional text, 1,000-page documents, mobile read-only view.

## Status

Decisions above agreed 2026-10-24.

**Phase 1 (engine core): done**, in `packages/core/docs-engine`.

- Shared packages: `@weldsuite/zip-xml` (the ZIP container and XML scanner,
  moved out of sheets-engine) and `@weldsuite/collab` (the room, client and
  protocol made generic over an `OtAdapter`; sheets-engine keeps its API on
  top of it).
- Model: stories in chunks of at most 1,024 code units with lazy prefix
  sums; a style id per character (styles interned per replica, never sent);
  paragraph and object data on the characters that have it. Tables are
  objects that own one story per cell (`cell:<table>:<row>:<col>`), so table
  structure ops never touch positions; footnotes and section breaks own
  their stories the same way. Every story ends with a paragraph mark that is
  never deleted.
- Ops: insert, delete, format text / paragraphs (as runs), set object, table
  rows and columns (insert/delete by index, formatting by id), cells,
  headers and footers, doc props, named styles, lists, anchors. Each `apply`
  returns the exact inverse, including what a delete takes with it (tables,
  cells, footnotes, anchors it moves). `transform` only maps positions;
  everything else is by id. `isWellFormedOp` checks untrusted JSON down to the
  last style key; `validateOp` checks an op (a batch op by op) against the
  document.
- Serialisation: snapshot, plain text, HTML out (inline CSS, h1–h6, nested
  ul/ol, tables) and in (own tokenizer; Google Docs and Word clipboards,
  `mso-list` lists, spans on a grid, unsafe links dropped, formatting equal to
  the paragraph's style dropped), Markdown out and in (CommonMark + GFM
  tables, task lists, strikethrough).
- Tests: a 3,000-edit fuzz of the chunked store against a plain string;
  exact inverses for 3,000 random ops; a room with four clients, random
  delays and 600 random edits per session converges with no refused batch
  (40 sessions in CI, 300 when written).

**Phase 2 (layout engine): done**, in `packages/core/docs-engine/src/layout`.

- Measurement behind `TextMeasurer`: `CanvasMeasurer` in the browser,
  `MetricsMeasurer` (standard Helvetica/Times/Courier widths, an em for CJK
  and emoji) in Node and workers, both behind a width cache.
- Paragraphs: words with hanging trailing spaces, line breaks after spaces,
  hyphens and around CJK (a practical subset of UAX #14), words wider than a
  line broken between characters, left/centre/right/justify, first-line and
  hanging indents, list markers in the hanging indent, tab stops (left,
  centre, right, decimal, leaders), line height as a multiple or exact,
  superscript and subscript, small and all caps, inline images, footnote
  references, fields, chips, horizontal rules, page/column/section breaks.
- Tables: columns scaled to fit, each cell's story laid out at its width,
  rows as tall as their tallest cell, merges across rows and columns,
  vertical alignment.
- Pagination: sections with their own page setup and numbering, headers and
  footers (first page, even pages, linked to earlier sections), columns,
  footnotes at the foot of the page that refers to them, widow/orphan
  control, keep with next, keep lines together, page break before, table
  rows that never split with header rows repeated, pageless view.
- Incremental: an op tells the layout which paragraphs it touched
  (`DocLayout.apply` / `applied`); a story changed behind its back
  (`stale()`, remote edits) is re-scanned, reusing the layout of every
  unchanged paragraph. List numbers, footnote numbers and table contents are
  part of a paragraph's cache key.
- Geometry: caret rectangles (with wrap affinity), hit testing (merged cells
  and nested tables included), selection rectangles, visual line bounds.
- Measured (Node, built-in metrics): 2,400 paragraphs (320 pages) laid out in
  0.3 s; an edit re-laid and re-paginated in 2.5 ms.

**Phase 3 (editor, local only): done**, in `apps/web/platform/app/welddocs`.

- Module registered like WeldSheets: routes `/welddocs` and `/welddocs/$docId`
  (+ the unauthenticated `/preview/welddocs` mirror), rail and module
  sidebar, `docs:*` permissions with role defaults, `docs` in api-modules
  (port 8824, `/api/docs`, worker not built yet), reserved slug, app-store
  seed and fallback catalog entries, icons, en/nl translations.
- Engine: `editing/` (typing, Backspace/Delete by grapheme or word, Enter
  with the style's `next` style, Google Docs' paragraph joining, lists and
  indents, links, objects, paste with fresh ids, find and replace, word
  count) and `layout/display.ts`, a page's drawing as absolute items that the
  DOM renderer (and the PDF writer, phase 6) draws.
- Editor: pages rendered as absolutely placed DOM in points, only near the
  viewport; caret, selection and find highlights drawn from the layout's
  geometry; typing through a hidden textarea (`beforeinput`, IME
  composition); mouse click, drag, double and triple click, Shift+click,
  Ctrl+click on links; keyboard navigation and the Google Docs shortcuts;
  menu bar (File, Edit, View, Insert, Format, Tools, Help), toolbar (styles,
  font, size, marks, colours, link, alignment, spacing, lists, indents),
  ruler with draggable margins and indents, outline, find and replace,
  page setup (paper, orientation, margins, columns, page colour, first-page
  header, pageless), word count, link and shortcut dialogs, headers and
  footers (double-click a margin), page numbers, footnotes, page breaks,
  printing through the browser at the real page size, and downloads as
  HTML, Markdown and text.
- Clipboard: HTML and text for other apps, plus the exact fragment (a custom
  type, and in an HTML comment) for pasting back without loss.
- Every edit goes through `DocController.apply`. Documents are kept in
  IndexedDB per workspace until phase 4.

**Phase 4 (backend and live co-editing): done**, in `apps/workers/docs-api`
and `apps/web/platform/app/welddocs`.

- `/api/docs` (list, create, get, rename and move, trash, session, live
  snapshot), `DocRoom` (Durable Object per document, `createDocRoom` /
  `restoreDocRoom`, checkpoints to R2), built file for file on sheets-api.
  A document is a drive file (`fileType: 'document'`, mime
  `application/vnd.weldsuite.doc+json`, `metadata.weldDocId`) plus a `docs`
  row. Create takes an optional initial snapshot (an imported file), checked by
  loading it.
- Migration 0225 (`docs`): `revision`, `snapshot_key`, `snapshot_revision`;
  `content` nullable. **A WeldDocs row is the one with `content` null** (and
  a checkpoint key); flow-api `/api/documents` reads it as `content: []` and
  refuses every write to it with a 409 (`isWeldDocsRow`), so BlockNote JSON
  never lands in it. Phase 8 converts the old rows and retires that route.
- app-api forwards `/api/docs*` (the room socket included) over `DOCS_API`;
  WeldDrive opens a file with `metadata.weldDocId` at `/welddocs/<id>`; a
  drive purge deletes the `docs` row (and the document's version rows).
- `doc` entity events: created, updated (rename, move, and at each checkpoint
  with the revision), deleted.
- Platform: in a workspace the home page lists documents from docs-api and an
  open document is edited through `DocConnection` (the engine's collab client
  over the room socket: reconnects, re-sends unconfirmed edits, warns before
  leaving with any); undo entries move past other people's ops; each person's
  caret and selection are drawn in their colour with a name flag while they
  move or type, with avatars in the header (click to jump to them). Files
  imported on the home page (.md, .html, .txt) are read in the browser and
  sent as the new document's first snapshot. Only the signed-out preview
  still keeps documents in IndexedDB.

**Phase 5 (tables, images and layout objects): done.**

- Tables: Insert › Table and the toolbar's grid pick a size; the caret goes
  into the first cell. Tab and Shift+Tab move between cells (selecting the
  next cell's text) and Tab in the last cell adds a row; Up and Down move
  between the body and the cells. Format › Table and the right-click menu
  add and delete rows and columns, merge right or down and unmerge,
  distribute columns, repeat the first row on every page, and set cell
  background, vertical alignment, table alignment and borders. Column
  borders on the page drag to resize (the next column gives or takes the
  space). Tables nest: a table inserted in a cell lays out inside it.
- Images: Insert › Image uploads to WeldDrive storage (in the signed-out
  preview, the image is kept inside the document) or takes an https
  address; inserted images fit the column. A click selects an image: a
  corner handle resizes it keeping its proportions, and a small bar sets
  text wrapping, alt text, the original size or deletes it. Wrapped images
  float in their paragraph: text wraps beside them (`square`), moves below
  them (`topBottom`) or ignores them (`behind`, `front`), and they move
  by dragging. Floats are local to their paragraph (a paragraph shorter
  than its floats gets the difference as space after it). Cropping is drawn
  (from .docx imports); there is no crop tool yet.
- Breaks: Insert › Break adds page, column (with more than one column) and
  section breaks (next page or continuous). A section break carries a copy
  of the section it splits, and page setup now changes the caret's section.
- Table of contents: Insert › Table of contents lists headings 1–3, each
  linked to a bookmark on the heading (Ctrl+click follows it) with a dotted
  tab and a `pageRef` field showing the page it is on, worked out at layout.
  The table is covered by a `toc:` bookmark; Insert › Update table of
  contents rebuilds it after headings change.
- A table row taller than a page now pushes what follows below it (it still
  overflows the page; rows do not split).
- Equations stay for later.

**Phase 6 (files): done.**

- Engine (`src/files/`, no libraries): a .docx reader and writer on the
  shared ZIP and XML layer (styles, numbering, sections with their headers
  and footers, footnotes, tables with merges and header rows, pictures,
  links, fields), and a PDF writer drawn from the same display list as the
  screen (standard fonts with the layout's widths, an embedded TrueType
  subset for other characters when a font is given, PNG and JPEG, outlines
  from headings, links). Bookmarks round-trip through .docx as anchors,
  `PAGEREF` as `pageRef` fields, internal links as `w:anchor`, and
  anchored pictures as floating images with their wrapping and offsets; in
  a PDF a link to a bookmark jumps to its page.
- Import and export run in the browser, the same in a workspace and in the
  signed-out preview. Import on the home page takes .docx, .md, .txt and
  .html; a .docx's pictures go to WeldDrive storage (in the preview they
  stay inside the document), and a note says what the file had that the
  document does not (comments, tracked changes, text boxes, charts, …).
  File › Download adds Word (.docx) and PDF next to HTML, Markdown and
  text; pictures in private WeldDrive storage are fetched with the member's
  session, and a note says when some could not be added.
- WeldDrive: "Open in WeldDocs" on .docx, .md, .txt and .html files (card
  menu, row menu, preview) makes a new document from the file and opens it.
- Not yet: comments and tracked changes in .docx (phase 7), PDF fonts for
  characters outside Latin unless a font is supplied (the PDF shows "?";
  printing from the browser has them), a server-side export for the API
  (phase 8, with the WeldAgent tools).

Known gaps, to pick up in later phases:

- Table rows never split across pages, so a row taller than a page
  overflows it. Floating images stay with their paragraph's first page.
- Right-to-left and bidirectional text lay out left to right (phase 9).
- An undo that re-creates a deleted table, footnote or section re-uses its
  ids (exact undo needs them); a concurrent edit aimed at the old one can
  land in the restored one, or be refused by the room (the client then
  reloads from the room).
- A remote op makes the layout re-scan the stories (reusing every unchanged
  paragraph's lines); fine at today's sizes, incremental in phase 9.
- No state checksums between replicas yet (as WeldSheets).
