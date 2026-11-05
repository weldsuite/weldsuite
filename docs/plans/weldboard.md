# WeldBoard

An online whiteboard for WeldSuite in the class of Miro: an infinite canvas
with sticky notes, shapes, connectors, text, drawing, images and frames, live
co-editing, templates and facilitation tools (presenting, voting, timer),
WeldSuite records on the board, and AI. It is built in-house like WeldSheets
([weldsheets.md](weldsheets.md)) and WeldDocs ([welddocs.md](welddocs.md)):
own board model, renderer and co-editing, no whiteboard or canvas libraries.

WeldFlow's project whiteboards move into it. After this plan there is one
whiteboard editor in the product, and a project's whiteboards are WeldBoard
boards that live with the project, the way project sheets became WeldSheets
spreadsheets.

## Decisions

Agreed with the product owner on 2026-11-05:

| Question | Decision |
|---|---|
| Placement | Its own module (`/weldboard`, own rail and sidebar entry, `boards:*` permissions, own App Store entry). A board is a WeldDrive file. |
| WeldFlow whiteboards | Merged: one editor. A project's whiteboards are WeldBoard boards that live with the project, open in the WeldBoard editor inside the project and follow project membership. Old boards convert on first open, keeping their id and link. The WeldFlow editor is deleted. |
| Engine | Written from scratch: `@weldsuite/board-engine`, pure TypeScript, zero runtime dependencies, no DOM. Nothing from the WeldFlow editor is reused; its element format matters only to the converter. |
| Scope | All four areas: core canvas, facilitation, WeldSuite data, AI. Phased below. |
| Access | Workspace members only, through WeldDrive roles (owner, editor, commenter, viewer). No guest or public links for now. |

Technical choices, proposed in the plan and also agreed on 2026-11-05:

| Question | Decision | Alternatives considered |
|---|---|---|
| Rendering | **Canvas 2D**, DPR-aware, only what is in view, with a cached layer for still content and an overlay layer for selection, handles and remote cursors. Text editing through a hidden textarea over the element, as in WeldDocs. | SVG/DOM (what WeldFlow does today): easy hit-testing and text, but it slows down past a few thousand elements and on long pen strokes. WebGL: fastest, far more work for text. |
| Collaboration | Server-sequenced OT on the shared `@weldsuite/collab` core, in a `BoardRoom` Durable Object in `board-api`: the WeldSheets and WeldDocs model ([SHEETS-003](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/SHEETS-003-server-sequenced-ot-in-a-durable-object.md)). | A CRDT. That would need a library or a CRDT of our own, and it would be a second sync stack next to `@weldsuite/collab`. |
| Text inside elements | A sticky's, shape's or text box's content is a small **docs-engine text story** (paragraphs, bold, italic, underline, strikethrough, colour, links, lists, mentions). Two people typing in one sticky merge by character, and paste from WeldDocs, Word and Google Docs works. | Whole-text last-writer-wins with a lock while someone edits (Miro's behaviour). Simpler, but two people can't type in the same sticky. |
| Look | Clean shapes (Miro style). A hand-drawn stroke style can come later as a style option. | Hand-drawn by default (Excalidraw style). |
| Project boards without WeldBoard installed | Keep working. A workspace with only WeldFlow keeps its project whiteboards (today they are part of WeldFlow); the `/weldboard` home needs WeldBoard installed. In api-modules the module lists `['weldboard', 'weldflow']`. | Project whiteboards need WeldBoard installed. That would take away a feature WeldFlow-only workspaces have today. |
| Legacy APIs | `/api/whiteboards` (flow-api), `/v1/whiteboards` (external-api) and the `*_whiteboard` MCP tools keep working through a legacy-shape adapter, marked deprecated. New `/v1/boards` and `*_board` tools are added. | Refuse writes to converted boards with a 409, as flow-api does for WeldDocs rows. That breaks public API users. |
| Kubernetes editions (EU, self-hosted) | WeldBoard ships on Global (TypeScript workers) first, hidden on the Kubernetes editions until the port (phase 11). The project Whiteboards tab is hidden there too in the meantime (EU is dormant). | Port before launch. |

## What exists today

- **WeldFlow whiteboards**: `project_whiteboards` (`packages/core/db/src/schema/project-whiteboards.ts`),
  one `elements[]` jsonb array per board, saved whole on every change.
  - Routes: `apps/workers/flow-api/src/routes/whiteboards/index.ts` (`/api/whiteboards`, `projects:*` permissions plus project membership). Entity type `project_whiteboard`.
  - Editor: `apps/web/platform/components/weldflow/whiteboard/`. `whiteboard-view.tsx` is about 4,600 lines of SVG editor, plus `whiteboard-geometry.ts`, `whiteboard-merge.ts` (per-element three-way merge before each save), `remote-cursors.tsx` and `presence-indicator.tsx`. Pages are under `app/weldflow/project/[projectId]/whiteboard/` and `app/weldflow/whiteboard/` (a read-only index across projects).
  - Element types: rectangle (with corner radius), ellipse, text, sticky, pen path (partial erase stored as `erasedPaths`), and arrow (line, arrow or elbow, attachable to elements, with a curve handle). Elements can also carry links and a lock.
  - Live editing: `WhiteboardRoom` in `apps/workers/realtime-worker`, keyed `projectId:whiteboardId`, with a project-membership gate (`lib/project-room-access.ts`). It fans out element ops, cursors, selections and presence, and persists nothing. Client: `useWhiteboardRoom` in `@weldsuite/realtime`, `hooks/use-whiteboard-collaboration.ts`.
  - Other readers: external-api `/v1/whiteboards`, mcp-server `search|get|create|update|delete_whiteboard`, Rust `rust/modules/flow/src/whiteboards.rs` (listed in `rust/conformance/suites.json`), and WeldDrive's aggregated view (`apps/workers/app-api/src/services/drive-aggregation.ts`).
  - Known gap: `PATCH /whiteboards/:id` has no version check, so a race can still drop a change.
- **An unused `whiteboards` table** (`packages/core/db/src/schema/whiteboards.ts`, migration 0151), labelled "WeldBoard". It pairs 1:1 with a drive `files` row and has a jsonb Excalidraw `scene`. No route reads or writes it. The drive purge (`apps/workers/flow-api/src/cron/purge-deleted-files.ts`) already deletes its rows with their file.
- **An orphaned i18n key**, `welddrive.*.openInWeldBoard` (en, nl, es).
- **Building blocks to reuse**: `@weldsuite/collab` (RoomCore, CollabClient, protocol over an `OtAdapter`), `@weldsuite/docs-engine` (text stories, layout, the PDF writer), `@weldsuite/zip-xml`, the `docs-api` / `sheets-api` worker and room structure, `@weldsuite/core-domain/drive-access`, `resolveProjectAccess` in `@weldsuite/flow-domain`, record chats for comments ([CHAT-007](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/CHAT-007-sheet-and-document-comments-are-record-chat-threads.md)).

## Architecture

### `@weldsuite/board-engine` (`packages/core/board-engine`)

Pure TypeScript, zero runtime dependencies besides `@weldsuite/docs-engine`
(for element text) and no DOM. The same code runs in the browser, in the
`BoardRoom` Durable Object, and in any worker that reads or writes a board
(exports, thumbnails, the legacy adapter, WeldAgent tools).

- **Model**: a board is a map of elements by id plus board properties
  (background, grid, default styles, facilitation state).
  - Every element has `type`, `parentId` (a frame or group, or the board), a
    fractional-index `order` string for z-order among its siblings (so
    concurrent reorders never renumber anything), geometry (`x`, `y`, `w`,
    `h`, `rotation`), `locked`, `link`, `createdBy`, and style (fill, stroke,
    stroke width and style, opacity, font, size, alignment).
  - Element types:
    - **sticky**: text, colour, size preset, author tag
    - **shape**: rectangle, rounded rectangle, ellipse, triangle, diamond, parallelogram, star, hexagon, cylinder, cloud, callout and the flowchart set, all with text inside
    - **text**: a free text box
    - **connector**: ends either bound to an element (side or relative anchor) or free; straight, elbow or curved routing; arrowheads; labels along the line
    - **pen**: a stroke with pressure, simplified on commit; a highlighter variant
    - **image**: a drive file ref, with crop
    - **file**: a drive file card with a preview
    - **frame**: name, background, presentation order
    - **group**
    - **card**: title, description, assignee, due date, tags
    - **record**: a live WeldSuite record ref (phase 9)
    - **mindmap node**: a shape with parent and side, auto-laid out (phase 5)
    - **comment pin**: an anchor only, with no text (phase 8)
    - **voting session** and **timer** (phase 7)
  - Text in a sticky, shape, text box, card or connector label is a docs-engine story (see Decisions).
- **Operations**: `create` (one or more elements), `delete`, `set` (a patch of
  element properties), `reorder`, `setBoard`, `editText` (wraps a docs-engine
  text op for one element), `batch`.
  - `apply` returns the exact inverse; `transform` works by element id.
  - Concurrent `set`s on the same property: the room's tie-break wins. A `set` on a deleted element drops. `editText` transforms through docs-engine. Deleting a frame or group takes its children (the inverse restores them). A connector whose bound element is deleted keeps its last point and unbinds.
  - `isWellFormedOp` checks untrusted JSON; `validate` checks an op against the board (ids exist, sizes in range, no parent cycles).
  - A convergence fuzz on `RoomCore`, as WeldDocs has.
- **Geometry** (`geometry/`):
  - Bounds and rotated bounds; hit-testing per type (stroke tolerance by zoom, filled vs outline, text boxes).
  - A spatial index (an R-tree, or a grid hash per zoom band) for viewport culling, hit-testing and marquee selection.
  - Snapping and alignment guides, equal-spacing hints, align and distribute.
  - Connector anchors and routing: elbow routing around obstacles (a sparse-grid search) and curved routing with a draggable control.
  - Mind-map tree layout.
- **Text**: element text lays out through docs-engine's `TextMeasurer` and
  paragraph line breaking: `CanvasMeasurer` in the browser, `MetricsMeasurer`
  in workers, so a board renders the same everywhere. Sticky and shape text
  can shrink to fit.
- **Display list** (`display/`): a board (or a region, or a frame) turns into
  a flat list of draw items (paths, fills, strokes, text runs, images). The
  canvas renderer, the SVG writer and the PDF writer all draw from it, so
  exports match the screen.
- **Serialisation**: a compact JSON snapshot (with plain text extraction for
  search and agents); board fragments for copy/paste and templates; SVG out;
  PDF out through docs-engine's PDF writer (moved into a shared package if it
  needs board-only changes, as `@weldsuite/zip-xml` was).
- **Legacy** (`legacy/`): converts a `project_whiteboards` `elements[]` into a
  board, and back for the compatibility API. A board → legacy export maps the
  types WeldFlow knew and skips the rest. A legacy `elements[]` write becomes
  a diff of ops. Pen strokes with `erasedPaths` are split where the eraser
  cut them.

### Rendering and editor

- **Canvas renderer**: infinite pan and zoom (2% to 4,000%), DPR-aware. Only
  elements in view are drawn, with level-of-detail at low zoom (text becomes
  bars, small elements merge). Still content is cached in a bitmap layer and
  redrawn only when it changes; an overlay layer holds selection, handles,
  guides, remote cursors and selections.
- **Input**: mouse, touch, pen (pressure) and trackpad pinch through one
  pointer pipeline; keyboard shortcuts close to Miro's.
- **Text editing**: a hidden textarea positioned over the element takes input
  and IME composition. The caret and selection are drawn from the engine's
  text layout, so there is no jump between editing and display.
- **`BoardController`** (`app/weldboard/editor/model/board-controller.ts`):
  every edit goes through it, as `SheetController` and `DocController` do.
  Undo is per user and moves past other people's ops.

### Collaboration

The WeldDocs model with a board adapter:

- A `BoardRoom` Durable Object per open board (SQLite storage, WebSocket hibernation) orders ops, transforms late arrivals, writes each op before the ack and broadcasts.
- It checkpoints the snapshot to R2 every 200 ops, 30 s after an edit, and when the last client leaves.
- Presence goes on the same socket and is never persisted: cursor (throttled to about 20 Hz), selection, viewport (for follow mode), colour, name, the element being edited.
- Tickets through `POST /api/boards/:id/session`, socket at `GET /api/boards/connect?ticket=…`.
- Viewers join read-only. Commenters may only add, move and resolve comment pins.

The realtime-worker `WhiteboardRoom` is retired in phase 4.

### `board-api` worker

Hono on `@weldsuite/worker-kit`, port **8826**, host
`board-api(-test).weldsuite.org`, binding `BOARD_API`, owns `/api/boards*`:

- `GET/POST /api/boards`, `GET/PATCH/DELETE /api/boards/:id`. This is metadata; the drive `files` row is created alongside, and delete moves it to the trash. `?projectId=` lists a project's boards, including unconverted legacy ones.
- `POST /api/boards/:id/session` and `GET /api/boards/connect` → `BoardRoom`.
- `GET /api/boards/:id/snapshot` (live) and `GET /api/boards/:id/thumbnail`.
- `POST /api/boards/convert` turns a legacy project whiteboard into a board in place.
- `POST /api/boards/import` (.excalidraw, image or CSV files, a WeldDrive file by id).
- `/api/boards/:id/versions` (phase 8). Templates are boards flagged as templates (phase 7).
- `BoardsInternal` (a WorkerEntrypoint): read, find and apply ops through the room. It is bound in flow-api and external-api (the legacy adapter), agent-api and mcp-server (the agent tools) and chat-api (record chat).
- Entity events: `board` created / updated (rename, move, and at each checkpoint with the revision) / deleted, and `board_version` (phase 8). Run `pnpm rust:catalogs` after adding them.

### Platform UI (`apps/web/platform/app/weldboard/`)

Same structure as `app/weldsheets/` and `app/welddocs/`:

- `layout.tsx` (breadcrumb root → `AppHeader` → `ModuleContent`, gated on the app being installed and `boards:read`).
- `page.tsx`, the home: recent, starred, shared with me, project boards, the template gallery, new board, import.
- `board/`: `board-chrome.tsx` (title, star, move, saved state, peer avatars, follow, Share, Export, Present), `live-board.tsx` / `local-board.tsx` (room vs IndexedDB for the signed-out preview).
- `editor/`:
  - the left toolbar (select, hand, sticky, shapes, connector, text, pen and highlighter, eraser, frame, image and file, templates, more)
  - a context toolbar over the selection (colour, font, size, align, connector style, lock, link, convert to task, more)
  - the frames panel, minimap, zoom controls, keyboard shortcuts dialog
  - the canvas view, the hidden-textarea text input, the controller, keyboard map and clipboard
- `collab/board-connection.ts` on the shared collab client.
- The editor is a component that WeldFlow mounts inside project chrome (phase 4).
- Routes:
  - `src/routes/weldboard/{route,index,$boardId/index}.tsx`
  - the unauthenticated `/preview/weldboard` mirror, for support videos and help screenshots

### Access

- Workspace permissions open the door: `boards:read|create|update|comment|delete|share|manage`, with role defaults like `sheets:*` (OWNER/ADMIN all, MEMBER all but `manage`, VIEWER `read`).
- Per board, access is the WeldDrive role on its file, resolved through `@weldsuite/core-domain/drive-access`. A board the caller cannot see is a 404.
- A project board follows `resolveProjectAccess` (`@weldsuite/flow-domain`): members may write, project viewers may read. This is the same rule the REST routes and the old room gate used, so `realtime-worker/src/lib/project-room-access.ts` and its keep-in-lockstep note go away with `WhiteboardRoom`.

### WeldFlow integration

- **Project boards** are boards whose `files` row has `entity_type='project'` and `entity_id=<projectId>`.
  - The project's Whiteboards page lists, creates, renames, duplicates and deletes through board-api.
  - `/weldflow/project/:projectId/whiteboard/:id` renders the WeldBoard editor inside the project.
  - The cross-project index at `/weldflow/whiteboard` lists them through board-api.
- **Convert on first open**: a `project_whiteboards` row becomes a board with the **same id** (`pwb_…`), so links, bookmarks and API ids keep working.
  - The old row is soft-deleted. A board row with that id is how every reader knows it was converted.
  - Converting runs server-side in board-api (`POST /api/boards/convert`), idempotently, from the legacy adapter in the engine.
- **Compatibility**:
  - flow-api `/api/whiteboards` becomes a façade. List and get merge unconverted rows with converted boards (legacy shape from the engine). Writes to a converted board go through `BoardsInternal`.
  - external-api `/v1/whiteboards` and the MCP whiteboard tools are the same façade, marked deprecated in api-docs.
  - The Rust flow module changes with it, because `/api/whiteboards` is in the conformance suite.
- **Deleted** at the end of phase 4:
  - `components/weldflow/whiteboard/*`
  - `hooks/use-whiteboard-collaboration.ts`, `lib/realtime/whiteboard/`
  - `useWhiteboardRoom` / `whiteboard-client` in `@weldsuite/realtime`
  - the realtime-worker `WhiteboardRoom` (with a wrangler `deleted_classes` migration) and its routes
  - the `sweep.weldflow.whiteboardView.*` strings
- WeldDrive's aggregated view stops listing `project_whiteboards` separately: project boards are drive files now.

### WeldSuite data and AI (phases 9 and 10)

- **Record cards**: a WeldFlow task, a project, a CRM company, person or opportunity, a WeldDesk ticket. They render live from the record (refreshed through the realtime cache-invalidation hub, [EVT-007](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/EVT-007-realtime-sync-by-cache-invalidation.md)). Pasting a platform link makes a card; opening one goes to the record.
- **Stickies to tasks**: turn a selection into WeldFlow tasks in a chosen project. The stickies become task cards in place.
- **Mentions and comments**: @mentions in element text notify the member. Comments are threads in the board's record chat ([CHAT-007](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/CHAT-007-sheet-and-document-comments-are-record-chat-threads.md)): entity type `board`, with a provider next to `drive-file.ts`. The board keeps only the pins.
- **Search**: board text is extracted at checkpoints into the search index.
- **AI**: all through `@weldsuite/ai`, charged with `chargeAiUsage`:
  - generate a mind map, flowchart, diagram or sticky set from a prompt (structured output → engine ops)
  - cluster stickies by theme
  - summarise a selection or a board into a WeldDocs document or into tasks
  - suggest ideas next to a sticky
- **WeldAgent tools** through `BoardsInternal`: `boards.read`, `boards.find`, `boards.create`, `boards.add`, `boards.update`. They apply as ops through the room, so collaborators watch the agent work, as WeldSheets' agent tools do ([AGENT-015](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/AGENT-015-default-weldagent-edits-the-sheets-you-point-at.md)).

## Schema

Each change needs approval before a migration.

- **Reshape the unused `whiteboards` table** (it is already 1:1 with a drive `files` row, and the purge already deletes it):
  - drop `scene` (no code writes it; check that it holds no rows on test and production first)
  - add `revision`, `snapshot_key` (R2), `snapshot_revision`, `is_template`, `template_category`
  - the table name stays `whiteboards`
  - ids: `brd_…` for new boards, `pwb_…` kept for converted ones
- `board_versions` (board, revision, name, snapshot_key, created_by, created_at), with cascade on the board. Phase 8.
- `project_whiteboards` stays read-only for the converter and the compatibility API. It is dropped in a later release, once the compatibility API is retired.

## Phases (one PR each)

1. **Engine core**: the model, element types, fractional order, ops with apply, invert and transform, `isWellFormedOp` / `validate`, the `OtAdapter`, snapshot and fragments, element text on docs-engine stories, the spatial index, geometry and hit-testing, the legacy converter (tested on real WeldFlow element sets, including `erasedPaths` and bound elbow arrows), and a convergence fuzz on `RoomCore`.
2. **Editor, local only**:
   - Module registration, as WeldDocs phase 3 did:
     - routes, rail and module sidebar
     - `boards:*` permissions with role defaults, `weldboard` in `PERMISSION_APPS`
     - `board` in api-modules (port 8826, `/api/boards`, worker not built yet)
     - reserved slug, App Store seed and fallback catalog, logo and icons
     - en/nl translations, and the `openInWeldBoard` key reused
   - The home page and the canvas renderer.
   - Tools: select, hand, sticky, shapes (basic set), connector (straight and elbow, bound), text, pen, highlighter, eraser, frame, image upload.
   - Editing: selection, marquee, transform handles with rotation, snapping and guides, align and distribute, group, lock, z-order, copy/paste/duplicate (in-board and to other apps), undo/redo.
   - Text editing with the rich-text marks, the context toolbar, minimap, zoom to fit or selection, keyboard shortcuts, dark mode, touch and pen.
   - Storage in IndexedDB until phase 3, and the `/preview/weldboard` mirror.
3. **Backend and live co-editing**:
   - `board-api` with its routes and `BoardRoom` (checkpoints to R2), the schema change and migration.
   - app-api forwarding (`BOARD_API`), worker secrets in `scripts/secrets/manifest.ts`, the deploy wiring (wrangler test/production, `deploy.yml`, CI area).
   - WeldDrive: create, open, trash and purge, "Open in WeldBoard".
   - Presence: live cursors with names, remote selections, the avatar stack, follow a person, "editing" marks on elements.
   - `board` entity events and the thumbnail.
4. **WeldFlow merge**:
   - Project boards on board-api, with the editor mounted in the project.
   - Convert on first open (same id and link).
   - Project-membership access, and the `/weldflow/whiteboard` index on board-api.
   - The `/api/whiteboards`, `/v1/whiteboards` and MCP façades through `BoardsInternal`, with `rust/modules/flow/src/whiteboards.rs` and the conformance suite in the same PR.
   - The drive aggregation fix.
   - Delete the WeldFlow editor, the `WhiteboardRoom`, its client and strings.
   - Update the e2e specs (`e2e/specs/weldflow/project-views.spec.ts`, `interactions.spec.ts`, `smoke/weldflow.smoke.spec.ts`) and the help docs (`apps/web/docs/src/app/weldflow/`).
5. **Diagramming depth**: the full shape library (flowchart, basic, arrows, callouts), curved connectors and connector labels, elbow routing around obstacles, mind maps (Tab / Enter to add nodes, auto layout, collapse), cards, image crop, file cards with preview, link cards (`POST /api/boards/unfurl`), the style painter, find on board.
6. **Files and export**:
   - Export: PNG (board, frame or selection, 1x/2x/4x), SVG and PDF (frames as pages) from the display list; copy as image.
   - Import: `.excalidraw` files, images by drag and drop and paste, CSV or text lines as stickies.
   - A board JSON backup, and "Open in WeldBoard" on `.excalidraw` files in WeldDrive.
7. **Facilitation**:
   - Templates: a gallery of built-ins shipped with the engine (retro, brainstorm, flowchart, user story map, kanban, SWOT, lean canvas, customer journey, mind map, weekly planning), plus workspace templates saved from any board.
   - Presentation mode by frame order, with followers.
   - "Bring everyone to me" and follow mode, the voting session (votes per person, anonymous or visible, results on the board), the shared timer, emoji reactions, and private mode (stickies hidden until revealed).
8. **Review and sharing**:
   - Comment pins on elements or points as record chat threads (CHAT-007), with @mentions, resolve, and the `boards:comment` commenter role in the room.
   - Version history (`board_versions`: name, restore, automatic versions), the WeldDrive share dialog in the header, and board settings (lock board, default view).
9. **WeldSuite data**:
   - Record cards (task, project, company, person, opportunity, ticket), pasting a platform link as a card, stickies to tasks.
   - Creating a board from a project, and linking boards to records.
   - Board text in search, and the board preview in WeldChat and WeldDrive.
10. **AI, agent tools and public API**:
    - The AI actions above through `@weldsuite/ai` with credit metering.
    - The WeldAgent tools on `BoardsInternal`.
    - The `/v1/boards` external API and MCP `*_board` tools (scopes `boards:read|write`), and api-docs pages.
11. **Scale, accessibility, mobile and Kubernetes**:
    - Benchmarks and tuning: 10,000 elements panning at 60 fps; a 50,000-element board loads in under 2 s; an op applies in under 1 ms.
    - Moving the engine into a Web Worker if needed.
    - Accessibility: keyboard focus through elements, and a screen-reader outline of frames and text.
    - A read-only board viewer in `apps/mobile/weldflow-app`.
    - The Rust port: board-api's REST routes in Rust, `BoardRoom` on the collab-rooms sidecar (`apps/tools/collab-rooms`), a conformance suite, and `board` in `RUST_PORTED_MODULES`. This un-hides WeldBoard and project whiteboards on EU and self-hosted.

## Design doc and ADRs

Recorded in `weldsuite-documentation` (skill `weldsuite-docs`) on 2026-11-05,
all **Proposed** until the code lands:

- [`design/modules/weldboard.md`](https://github.com/weldsuite/weldsuite-documentation/blob/main/design/modules/weldboard.md)
- [BOARD-001](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/BOARD-001-weldboard-is-its-own-module-and-weldflow-whiteboards-move-into-it.md): WeldBoard is its own module, and WeldFlow's project whiteboards move into it.
- [BOARD-002](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/BOARD-002-engine-built-in-house-drawn-on-canvas.md): the engine is built in-house, and boards are drawn on a canvas.
- [BOARD-003](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/BOARD-003-server-sequenced-ot-in-a-board-room.md): co-editing is server-sequenced OT in a `BoardRoom`, and element text merges by character.

The `weldflow.md` and `events-and-realtime.md` design docs point at them.
When the work lands:

- Flip each ADR to Accepted as its phase lands (BOARD-002 and BOARD-003 with phase 3, BOARD-001 with phase 4).
- Update `search-and-files.md` (boards are drive files) and `editions-and-self-hosting-status.md` (the port) at the same time.

## Risks

- **Scope**: Miro is a large product. Phases 1–4 are the merge-critical path (a better editor that replaces WeldFlow's); phases 5–11 can be reordered by demand.
- **Text on canvas**: own text layout and IME on a canvas are the hardest part of the editor. Reusing docs-engine's stories, layout and hidden-textarea input (already proven in WeldDocs) is the mitigation.
- **Large boards**: the snapshot is one JSON in R2. Past about 50,000 elements, load time and the room's memory need measuring. Region-chunked snapshots are the fallback, as WeldSheets chunks rows.
- **Compatibility façade**: keeping `/v1/whiteboards` writes working means a legacy-shape diff into ops. Elements WeldFlow never knew (frames, mind maps) are invisible there, which the deprecation note has to say.
- **Bundle size**: the editor pulls in docs-engine for text. Lazy-load the module so the platform shell does not grow.

## Status

All decisions above agreed 2026-11-05 and recorded as BOARD-001 to BOARD-003
(Proposed until the code is merged). The plan went in with
weldsuite/weldsuite#1460; the implementation is one PR,
weldsuite/weldsuite#1468, built phase by phase:

- Phase 1, engine core: done (`packages/core/board-engine`).
- Phase 2, editor: done (`apps/web/platform/app/weldboard`, the preview mirror).
- Phase 3, backend: done. `apps/workers/board-api` (routes, `BoardRoom`,
  `BoardsInternal`), tenant migration 0241 (`whiteboards` reshaped,
  `board_versions`), app-api forwarding, secrets, WeldDrive links, download
  and purge (TypeScript and Rust).
- Phase 4, WeldFlow merge: done. Project boards on board-api, converted in
  place on first open; flow-api's `/api/whiteboards` retired (TypeScript and
  Rust); `/v1/whiteboards` and the MCP whiteboard tools kept on boards through
  `BoardsInternal`; the old editor, `WhiteboardRoom` and its strings deleted.
- Phase 5, diagramming depth: done (shapes, connectors, mind maps, cards, crop,
  file and link cards, the style painter, find on board).
- Phase 6, files: done (export, `.excalidraw`/image/CSV import, "Open in
  WeldBoard" in WeldDrive).
- Phase 7, facilitation: done (templates, presentation, follow, timer, voting,
  reactions, private mode).
- Phase 8, review: done (comment pins as record-chat threads, version history).
- Phase 9, WeldSuite data: done (record cards, stickies to tasks, the `board`
  global search type in TypeScript and Rust).
- Phase 10, AI and APIs: done. Board specs in the engine
  (`serialize/spec.ts`: described content laid out by the engine), the AI
  actions (`POST /api/boards/:id/ai`: mind map, flowchart, sticky notes,
  group by theme, more ideas, summary into WeldDocs), the WeldAgent board
  tools, `/v1/boards` with the MCP board tools (scopes `boards:read|write`)
  and its api-docs page.
- Phase 11: done except the Rust port. The performance budgets are engine
  tests (`src/perf.test.ts`) and hold on the main thread, so there is no Web
  Worker; Tab/Shift+Tab walk the board in reading order, with a live region
  and a screen-reader outline; the WeldFlow mobile app has a read-only viewer
  on `GET /api/boards/:id/render`.
- **Not done: the Rust port** (board-api's routes in Rust, `BoardRoom` on the
  collab-rooms service with a `BOARD_ENGINE` binding, conformance suites, and
  `board` in `RUST_PORTED_MODULES`). Until then WeldBoard and project
  whiteboards stay hidden on the EU and self-hosted editions, as they are now.
