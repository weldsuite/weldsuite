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

Known gaps, to pick up in later phases:

- An editor undo that re-creates a deleted table, footnote or section
  re-uses its ids; a concurrent edit aimed at the old one can then land in
  the new one. The editor should undo with fresh ids (phase 3).
- No state checksums between replicas yet (as WeldSheets).
