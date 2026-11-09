# WeldForms

A forms and surveys module for WeldSuite in the class of Typeform. Build a form
with branching logic, scoring and a theme. Share it by link or QR code, embed it
on a website, or email it to people with a personal link each. Responses land in
WeldForms with summaries and drop-off numbers, and flow on into WeldCRM,
WeldDesk, WeldFlow, WeldSheets and WeldConnect.

## Decisions (agreed 2026-11-09)

| Question | Decision |
|---|---|
| Placement | Its own platform module (`/weldforms`, own sidebar entry), app code `weldforms`, module id `forms`, with its own worker `forms-api` (`forms-api(-test).weldsuite.org`) owning `/api/forms` and `/public/forms` (API-001). |
| Backends | TypeScript and Rust together from the first route, as WeldMerge (MERGE-001): every route lands in `forms-api` and `rust/modules/forms` in the same PR. `forms` is in `RUST_PORTED_MODULES` from phase 0, and its conformance suite covers every route, public ones included. |
| Respondent page | `apps/web/forms-portal` (`forms.weldsuite.org` / `forms-test.weldsuite.org`): TanStack Start (FE-015). It reads and writes only through forms-api's `/public/forms/*` (FE-008): over a `FORMS_API` service binding on Global, over HTTP to the Rust backend on Kubernetes (Node build). No database credentials in the public Worker, unlike FE-016. |
| Layouts | Both, chosen per form: `conversational` (one question at a time, the default) and `classic` (all questions on a page, optional page breaks). One definition, one engine. |
| Sharing in v1 | Public link and QR code, embeds (inline, popup, slider, popover, full page) through a script snippet and a website-builder block, email invitations with a personal link each and reminders, URL prefill and hidden fields. |
| Who can respond | Per form: anyone with the link (default), a verified email (6-digit code), or workspace members only (answered inside the platform). |
| v1 extras | Branching logic, variables and calculations, quizzes with score-based endings, recall, welcome and ending screens, themes, partial responses, file upload, signature, AI form generation and AI summaries of answers. |
| Integrations in v1 | WeldCRM (answers to a person, company or lead), WeldConnect trigger and outbound webhooks (entity events), WeldSheets (connected table) and CSV/XLSX export, a WeldDesk ticket, a WeldFlow task. |
| Billing | Included in every plan, with a monthly quota of completed responses per plan. AI from the prepaid credit wallet (BILL-005). |
| Domain | `forms.weldsuite.org/f/<publicId>`. Custom domains in a later phase (Cloudflare for SaaS, FE-015 item 6). |
| Not in v1 | Payments, custom domains, multi-language forms, a mobile app, the public API and MCP tools. See "Later". |

## Concepts

- **Form**: a title, a layout, a draft **definition**, settings, a theme and a
  status (`draft`, `published`, `closed`). What the user builds and shares.
- **Definition**: the content of a form, as JSON validated by one Zod schema:
  - **blocks** in order: a welcome screen, fields (questions), statements,
    question groups, page breaks (classic layout) and ending screens;
  - **hidden fields** (values that come in through the URL or an embed);
  - **variables** (`score` is built in, others are numbers or text);
  - **logic** (jumps, show/hide, variable actions, which ending to show).
  Every block has a generated `id` that never changes and an editable `ref`
  (a slug such as `company_size`) used in recall, prefill, integrations and
  exports.
- **Version**: an immutable snapshot of the definition, taken on publish.
  Editing a published form changes the draft; "Publish changes" makes the next
  version. A response points at the version it answered, and someone halfway
  through finishes on the version they started.
- **Response**: one respondent's answers, keyed by block id, plus hidden
  values, variable values (the score), the ending they reached and metadata.
  `in_progress` until submitted, then `completed`.
- **Invitation**: a personal link emailed to one person, tracked through
  `sent` → `opened` → `started` → `completed`, with reminders.
- **Theme**: a workspace-level look: fonts, colours, background, button and
  field style, logo. Forms pick one.
- **Integration**: an action a form runs on every completed response (CRM,
  Desk, Flow). Configured per form, run by the `ProcessResponse` workflow.
- **Folder**: groups forms on the home page.

### Field types (v1)

| Group | Types |
|---|---|
| Text | short text, long text, email, phone, number, website, date |
| Choice | multiple choice (one or several, "Other", random order), dropdown (long lists, pasted options), picture choice, yes/no, legal (accept terms) |
| Scales | rating (stars, hearts, 3 to 10), opinion scale (0 to 10 with labels), NPS, ranking, matrix (rows by columns, one or several per row) |
| Files | file upload, signature (drawn) |
| Composite | contact info (first name, last name, email, phone, company), address |
| Layout | welcome screen, statement, question group, page break (classic only), ending screens |

Every field has: required, description, an optional image or video, a
placeholder where it applies, validation (length, range, date range, number of
choices) and, in quizzes, a correct answer and points per choice.

### Logic, variables and quizzes

- **Jumps**: per block, rules of the form "if *conditions* go to *block*",
  checked in order, with a default "otherwise". Conditions combine with
  AND/OR groups and can test any earlier answer, hidden field or variable.
  Operators follow the field type: is, is not, contains, starts with, greater
  than, less than, between, before, after, is answered, is empty, any of, all
  of, none of.
- **Classic layout**: the same rules, applied as show/hide on fields and jumps
  between pages.
- **Variables**: actions on an answer (add, subtract, multiply, divide, set).
  Enough for assessments, lead scoring and simple price quotes.
- **Endings**: several ending screens; logic picks one by answers or score.
  An ending can redirect to a URL, with recall in the query string.
- **Recall**: `{{field:company_size}}`, `{{hidden:utm_source}}` and
  `{{var:score}}` in titles, descriptions, endings, redirect URLs and emails.
- **Quizzes**: correct answers and points per choice add to `score`; the
  ending can show the score and, optionally, the correct answers.

### One engine, run on every side

`@weldsuite/forms-engine` (`packages/core/forms-engine`, pure TypeScript, Zod
only) holds the definition schema and the rules: next block, visibility,
variables, recall, ending, answer validation. The builder preview, the portal
and the members-only fill page run it to drive the form. forms-api runs it on
every submit and never trusts the browser's path: it replays the logic over the
submitted answers, drops answers to blocks that are not on the path, checks the
required fields that are, recomputes the variables and the score, and picks the
ending itself.

The Rust backend has its own copy of the rules in `rust/modules/forms`. A
shared fixture set (`packages/core/forms-engine/fixtures/*.json`: definition +
answers → path, variables, ending, errors) is run by Vitest and by `cargo test`,
and the conformance suite compares the submit routes, so the two stay equal.

## Architecture

### `forms-api` worker (`apps/workers/forms-api`)

Scaffolded with `pnpm create:module-api forms` on `@weldsuite/worker-kit`.
Registered in `packages/core/api-modules/src/index.ts` as
`mod('forms', 8828, ['weldforms'], ['/api/forms', '/public/forms'])`, in
`RUST_PORTED_MODULES` and `API_FORWARD_MODULES`, with a `FORMS_API` binding on
app-api. `pnpm rust:catalogs` after each change to events, permissions or
`api-modules`.

Member routes (Clerk, `apiAuth()`), organised by object:

| Route | Purpose |
|---|---|
| `/api/forms/forms` | list (folder, status, search), create (blank, from a template, from AI), get, update draft, duplicate, delete |
| `/api/forms/forms/:id/publish` · `/close` · `/reopen` | lifecycle; publish snapshots a version and refreshes the public cache |
| `/api/forms/forms/:id/versions` | list, get one |
| `/api/forms/forms/:id/access` | the member list of a restricted form |
| `/api/forms/forms/:id/responses` | list (status, date, answer filters, search, cursor), get, delete, bulk delete, export; `POST` for members-only forms |
| `/api/forms/forms/:id/summary` | per-question aggregates for the summary charts |
| `/api/forms/forms/:id/insights` | views, starts, completions, completion rate, average time, drop-off per block, per day and per source; a range covers at most 400 days (how long a day's view count is kept), an earlier `from` is moved up |
| `/api/forms/forms/:id/invitations` | invite (members, CRM people, a CRM list, pasted addresses), list with status, remind, revoke |
| `/api/forms/forms/:id/integrations` | CRUD per kind, test run; `/responses/:rid/actions` log and retry |
| `/api/forms/forms/:id/subscription` | the member's own notification setting for this form |
| `/api/forms/folders` · `/themes` · `/templates` | CRUD; templates = the built-in gallery plus workspace templates |
| `/api/forms/media` | images and videos for questions and themes (public bucket) |
| `/api/forms/ai/generate` · `/forms/:id/ai/summary` | AI (Global only) |
| `/api/forms/settings` · `/usage` | workspace defaults; completed responses this month against the plan quota |
| `/api/forms/erase` | erase one respondent's data by email across all forms (GDPR request) |

Public routes (`/public/forms/*`), called only by forms-portal:

| Route | Purpose |
|---|---|
| `GET /f/:publicId` | the published version, theme, branding, status (open, closed, over quota, suspended) and respondent mode; served from the cache |
| `POST /f/:publicId/view` | counts a view (counter store, no tenant DB) |
| `POST /f/:publicId/sessions` | starts a response: bot check, invitation token or verified email, hidden fields; returns a response session |
| `POST /f/:publicId/send-code` · `/verify` | the email code for verified-email forms |
| `PUT /sessions/progress` | saves progress (and answers, when the form collects partial responses) |
| `POST /sessions/uploads` | a file or signature for one field |
| `POST /sessions/submit` | the final answers; validated by the engine; returns the ending with recall filled in |
| `POST /f/:publicId/report` | an abuse report |

Only the portal may call them: every request carries `FORMS_PORTAL_SECRET` in
`X-Forms-Portal-Key`, and the respondent's IP comes from `X-Respondent-Ip`,
trusted only next to the key (the FE-017 contract, used on both editions here).
Without the key the routes answer 403. Building your own front end on the
public API is "Later", through external-api.

### Links and the master registry

- **Public link**: `forms.weldsuite.org/f/<publicId>`, a random 10-character
  base62 id. Master table `form_link_registry (public_id, workspace_id, form_id,
  suspended_at)` routes it to the tenant (DATA-009), so a workspace rename never
  breaks a link. Written on first publish, removed on delete.
- **Invitation link**: `forms.weldsuite.org/i/<token>`, a random 32-byte
  token; only its SHA-256 is stored, in `form_invitation_registry (token_hash,
  workspace_id, form_id, invitation_id, revoked_at)` (the SIGN-002 pattern).
- The tenant rows are the source of truth; the registries only route.
- Staff can suspend a form (or every public form of a workspace) by setting
  `suspended_at`; the portal then shows "This form is no longer available".

### Published forms are cached

On publish, close, reopen, suspend and quota changes, forms-api writes the
public payload (version definition, theme, branding, status) to the cache: KV
on Global, Valkey on Kubernetes, keyed by public id. The portal also caches it
for 60 seconds with the Cache API (FE-015 item 4). Opening a form therefore
never opens the tenant database; starting, saving and submitting do, because
that is real work for that workspace.

### Respondent sessions

- `POST /sessions` runs the bot check and returns a session token: HMAC-signed
  with `FORMS_SESSION_SECRET`, bound to workspace, form, version, a
  pre-generated response id, the respondent mode and, when known, the
  invitation, verified email or member. Valid 7 days, so a respondent can come
  back to an unfinished form on the same device.
- The token lives in the portal page's memory and `localStorage`, and the
  portal's server routes forward it. Not in a cookie: in an embed on someone
  else's site third-party cookies are blocked, while iframe storage is
  partitioned and still works. The token can only write this one response.
- The response row is created on the first saved progress, not on start, so a
  bounce writes nothing.

### Partial responses and drop-off

- Every session reports progress on each step (debounced): the last block
  reached and the time spent. Drop-off and average time work for every form.
- Answers before submit are stored only when the form turns on "Collect
  partial responses". The owner then sees unfinished responses, labelled.
  One untouched for 24 hours counts as abandoned, computed on read (no timer).
- Without it, an unfinished response keeps progress only, never answers.

### Views and other counters

Views (form page loads, one per tab) and the rate-limit windows live in a
counter store, never in the tenant DB: a `FormCounters` Durable Object per
form on Global (hosted by forms-api) and Valkey on Kubernetes, behind one port.
Starts, completions, time and drop-off come from `form_responses`.

### Bot checks and abuse

- **Bot check behind a port**: Cloudflare Turnstile on Global, ALTCHA
  (self-hosted proof of work, no third party) on Kubernetes. The portal renders
  the widget; forms-api verifies the token when a session starts.
- Honeypot field and a minimum time between start and submit.
- Rate limits per IP and per form (counter store), with defaults the owner can
  lower: sessions per IP per minute, submissions per form per minute.
- One response per person needs an identity: verified email, invitation or
  members-only. For anonymous forms "one response per browser" is offered as a
  soft limit and labelled as such.
- Phishing: every public form has a footer "Never submit passwords through
  WeldForms" and a "Report abuse" link. Reports go to master
  `form_abuse_reports` and the admin console, where staff suspend a form or a
  workspace's forms. Publishing runs a synchronous content screen (credential
  and brand-impersonation patterns in field labels) and holds a suspicious form
  for staff review.

### Respondent modes

- **Anyone with the link**: anonymous, with the checks above.
- **Verified email**: the respondent enters an email and a 6-digit code (10
  minutes, 5 tries, then the address is locked for 15 minutes, in the counter
  store, as WeldSign). Options: one response per email, and "let respondents
  edit their response until the form closes". An invitation link counts as
  verified: the link is personal.
- **Workspace members only**: the public link redirects to the platform
  (`app.weldsuite.org/<workspace>/weldforms/fill/<publicId>`, FE-013), which
  renders the form with the same renderer and submits through
  `POST /api/forms/forms/:id/responses` with the member's session. Options: one
  response per member, and **anonymous to the owner** (for pulse and HR
  surveys): the response stores no member id, only a keyed hash that enforces
  one response per member.

### Renderer

`@weldsuite/forms-renderer` (`packages/design/forms-renderer`): the React
components that show a form, both layouts. Keyboard first (Enter, letter keys
for choices, arrow keys), touch friendly, accessible (labels, focus order,
`aria-live` progress), themed through CSS variables. The built-in texts (Next,
Submit, "press Enter", validation messages) come in the form's language, en or
nl in v1. Used by forms-portal, the builder's live preview and the members-only
fill page, and later by a mobile app.

### Embeds

`@weldsuite/forms-embed` (`packages/sdk/forms-embed`, MIT, OPS-002), served by
forms-portal as `forms.weldsuite.org/embed.js`:

- Modes: inline (`<div data-wf="<publicId>">`), popup, slider (side panel),
  popover (floating button), full page.
- Options as data attributes or JavaScript: hidden fields, auto height, open
  on load, on exit intent or at a scroll depth, hide after submit, and
  `onReady` / `onSubmit` / `onClose` callbacks.
- A postMessage protocol between the SDK and the portal's embed view (height,
  submitted with response id, close). The SDK and the portal must change in
  lockstep, like the helpdesk widget; CLAUDE.md gets that note.
- The portal sends `Content-Security-Policy: frame-ancestors` from the form's
  allowed domains (default: any site).
- **Website builder**: a "WeldForms form" block in
  `packages/design/site-components`, rendered by `apps/web/sites`, picks a
  published form and embeds it inline. Today's contact-form blocks submit
  nowhere, so this is also their way to collect anything.

### forms-portal (`apps/web/forms-portal`)

TanStack Start, port 3025, Workers `weldsuite-forms-portal(-test)` on
`forms(-test).weldsuite.org`, deployed by `deploy.yml` (`start-workers`, entry
in `.github/scripts/deploy-plan.mjs`) after the workers.

- `/f/:publicId`: the form, server-rendered with the theme so the first paint
  is branded, with Open Graph tags (title, description, image) for link
  previews in chat and social apps.
- `/i/:token`: an invitation link.
- `/f/:publicId?embed=…`: the embed view (no footer chrome, postMessage on).
- `/embed.js`: the embed SDK.
- Server routes forward to `/public/forms/*` with the key and the respondent's
  `CF-Connecting-IP`.
- Kubernetes: a Node build (`pnpm build:node`), image target `forms-portal` in
  `rust/Dockerfile`, a `formsPortal` Deployment, Service and Ingress at
  `forms.<domain>` in the Helm chart, `FORMS_PORTAL_SECRET` in the Secret
  (the chart refuses to render without it), `config.forms.portalUrl` for the
  links the backend emails.

### Data model (tenant DB, `packages/core/db/src/schema/weldforms.ts`)

- `form_folders`: id (`ffd_`), name, position.
- `forms`: id (`frm_`), folder id, title, layout, status, `definition` jsonb
  (the draft, `.$type<FormDefinition>()`), `settings` jsonb (respondent mode,
  one response per person, partial responses, opens/closes at, response
  limit, language, progress bar, allowed embed domains, redirect), theme id,
  public id, `published_version_id`, `revision` (optimistic concurrency, as
  CRM-004: a stale save gets 409 and the builder reloads), access
  (`workspace` | `restricted`), owner member id, `response_count`,
  `last_response_at`, timestamps.
- `form_versions`: id (`fve_`), form id, number, definition jsonb, theme
  snapshot, published at and by.
- `form_access`: form id, member id, role (`editor` | `results`), for
  restricted forms.
- `form_themes`: id (`fth_`), name, tokens jsonb, logo and background keys,
  is default.
- `form_responses`: id (`frs_`), form id, version id, number (per form),
  status, `answers` jsonb (by block id), `hidden` jsonb, `variables` jsonb,
  ending id, respondent email, member id, member hash (anonymous member mode),
  CRM person id, invitation id, last block id, started / submitted at,
  duration, metadata jsonb (referrer, UTM values, embed mode, device, country),
  IP hash (for duplicate and abuse checks; no raw IP is kept), a generated
  `tsvector` over the text answers for search. Indexes on (form id, submitted
  at), (form id, status), GIN on `answers`.
- `form_response_files`: id, response id, block id, storage key, name, type,
  size, kind (`upload` | `signature`).
- `form_invitations`: id (`fin_`), form id, email, name, CRM person id, member
  id, locale, status, sent / opened / started / completed at, reminders sent,
  next reminder at, revoked at, response id.
- `form_integrations`: id (`fig_`), form id, kind (`crm` | `desk` | `flow`),
  config jsonb (mapping), enabled, created by.
- `form_response_actions`: response id, integration id, status (`pending`,
  `done`, `failed`, `skipped`), the record it made (entity type + id), error,
  attempts, timestamps.
- `form_subscriptions`: form id, member id, mode (`instant` | `daily` | `off`).
- `form_settings`: one row per workspace: default theme, sender name,
  notification defaults, the "Made with WeldForms" badge.

Master DB: `form_link_registry`, `form_invitation_registry`,
`form_abuse_reports`.

Monthly usage is counted from `form_responses.submitted_at`; no separate
counter. Schema changes are fine to add; migrations are generated only after
explicit approval (CLAUDE.md).

### Files

- Respondent uploads and signatures go to `PRIVATE_STORAGE` (EVT-015). An
  upload during a session lands under `weldforms/pending/<responseId>/…`
  and moves to `workspaces/<id>/weldforms/<formId>/<responseId>/…` on submit.
  A lifecycle rule on the pending prefix deletes what was never submitted
  after 2 days, so no sweep is needed.
- Limits: 25 MB per file, 10 files per field, a type allowlist per field
  (images, PDF, documents, any).
- Staff download through forms-api with `form_responses:read`; exports carry
  app links, never public URLs.
- Images and videos the author puts on questions and themes go to the public
  bucket (`STORAGE`), because respondents see them.

### Submitting and `ProcessResponse`

1. `POST /sessions/submit` validates with the engine, then in one transaction
   completes the response, records the files, marks the invitation completed
   and bumps the form's counters.
2. It publishes `form_response.submitted` and starts **`ProcessResponse`**, a
   durable workflow with the response id as instance id: a Cloudflare Workflow
   on Global, a job on the jobs port (`rust/crates/ports/src/jobs.rs`) on
   Kubernetes, as WeldSign's `FinalizeEnvelope` / `sign.finalize`.
3. One idempotent step per enabled integration, then notifications and the
   receipt email. Each step records itself in `form_response_actions`; a
   failed step retries with backoff without repeating the others, and the
   response shows it with a Retry button.
4. Integration steps act as the member who set up the integration (CONN-004,
   SHEETS-007). If that member loses the permission, the step is skipped and
   the reason shown on the integration.

A respondent who edits a verified response publishes
`form_response.updated`, and the workflow runs again in update mode (the CRM
step updates the person it created).

### Integrations

- **WeldCRM**: match or create a **person** by email (from a contact-info or
  email field), optionally their **company** (by email domain or a company
  field), or create a **lead** instead (CRM-007). Map fields to standard and
  custom fields (DATA-012), each "always overwrite" or "only fill empty". Add
  to a CRM list, and log an activity "Submitted <form>" linking to the
  response. Writes through `@weldsuite/crm-domain` (CRM-005) and
  `rust/crates/crm-domain`. The person page gets a Forms tab with their
  responses (`?personId=` filter on the responses list).
- **WeldDesk**: open a ticket (DESK-008) in a chosen inbox with a subject and
  body built from recall templates, the respondent as requester, priority and
  tags mapped from answers, uploads attached. Through `@weldsuite/desk-domain`
  / `rust/crates/desk-domain`.
- **WeldFlow**: create a task in a chosen project (or as a personal task) with
  title and description templates, an assignee, a due date from an answer,
  labels and the uploads. Through `@weldsuite/flow-domain` /
  `rust/crates/flow-domain`.
- **WeldSheets**: form responses join the connected-table catalog
  (`@weldsuite/app-api-client/schemas/sheet-data`, SHEETS-007) as object
  `form_responses` with the form as parameter; the columns are every field of
  every version plus metadata. "Open in WeldSheets" on Results creates a
  workbook with the table connected. The room refreshes on its schedule, and
  `ProcessResponse` nudges it through a sheets-api internal entrypoint
  (API-008) for near-live updates.
- **WeldConnect and webhooks**: the `form_response` events are in the
  catalog, so a workflow trigger (CONN-006, filtered by form) and a workspace
  webhook (INT-009) work without extra code. A starter workflow template:
  "When a form is submitted, post it to a WeldChat channel".
- **Export**: CSV and XLSX, generated server-side from the same column model
  as the responses table, with app links for files.

### Entity events

`packages/core/entity-events/src/events/forms.ts`:

- `form`: `created`, `updated`, `published`, `closed`, `deleted`
- `form_response`: `submitted`, `updated`, `deleted`
- `form_folder`, `form_theme`, `form_integration`: `created`, `updated`, `deleted`
- `form_invitation`: `sent`, `completed`, `revoked`

Every mutation route publishes one (the event-coverage sweep, EVT-004), which
also keeps realtime list refresh working (EVT-007, `sync-map.ts`). The
`form_response` payload carries ids, the form title, the response number, the
respondent's email, the ending, the score and the **answers keyed by `ref`
with display values**, so WeldConnect and webhooks can use them. Left out:
file contents (names and ids only), signatures, and every field the author
marks **sensitive**. A sensitive answer is stored and shown to members with
`form_responses:read`, and never leaves forms-api otherwise (an extension of
EVT-005's rule to customer-collected data).

### Notifications and emails

- A member subscribed to a form gets a platform notification per response
  (`@weldsuite/notifications`, presence-gated email, EVT-008) or a daily
  digest. The owner is subscribed on create. The digest is timed by a
  due-index sweep (kind `forms_digest`), marked due only when a digest
  subscriber's form gets a response (DATA-008).
- New templates in `@weldsuite/emails` (`.claude/skills/weldsuite-email`), en
  and nl, through the outbound guard (MAIL-006) with a new source `forms`:
  - `forms.invite` (personal link, custom subject and message) and
    `forms.reminder`
  - `forms.code` (the 6-digit code)
  - `forms.receipt`: a copy of the answers to the respondent, **only to a
    verified address** (verified-email mode or an invitation). Never to an
    address typed into an anonymous form, which would let anyone send mail to
    a stranger.
  - `forms.response` (to subscribers; a link only when the form has sensitive
    fields) and `forms.digest`
  - `forms.quota` (to admins at 80 % and 100 % of the plan quota)

### Invitations and reminders

- Invite from the Share tab: workspace members, CRM people, a CRM list
  (CRM-003) or pasted addresses, up to 500 per batch.
- Opening a personal link starts a session as that person, with no code.
- Status per person (sent, opened, started, completed) and a progress bar.
- Reminders by hand ("Remind everyone who has not answered", skipping anyone
  emailed in the last hour) and automatic (after N days, then every N days, at
  most 3, never after the close date). The automatic ones run from a due-index
  sweep (kind `forms_reminders`, `SCHEDULE_INDEX`), the same way as WeldSign's
  lifecycle sweep.
- The outbound guard checks the whole batch first; a refusal sends nothing and
  tells the sender.

### Platform UI (`apps/web/platform/app/weldforms/`)

Route wrappers in `src/routes/weldforms/`, client in `@weldsuite/app-api-client`
(`domains/weldforms`, `schemas/weldforms`), hooks in
`hooks/queries/use-weldforms-queries.ts`. Generic parts come from
`@weldsuite/ui`, and anything missing is added there (CLAUDE.md).

- **Home** (`/weldforms`): forms in folders with status, response count,
  completion rate and last response; search; New form (blank, template, AI).
- **Builder** (`/weldforms/:id/edit`), tabs along the top:
  - *Create*: block outline on the left (drag to reorder, add-block menu),
    live preview in the middle (desktop or phone, either layout), block
    properties on the right (settings, validation, quiz points, this block's
    logic). Autosaves the draft.
  - *Logic*: every jump as a diagram, plus the rule list and variables.
  - *Design*: pick or edit a theme.
  - *Settings*: respondent mode, partial responses, open/close dates,
    response limit, language, redirect, embed domains, access.
  - *Integrations*: CRM, Desk and Flow actions with field mapping and a test
    run.
  - *Share*: link and QR code (PNG/SVG), embed configurator with a live
    preview and the snippet, a prefill/hidden-field URL builder, and email
    invitations with their status.
  - *Results*: *Summary* (a chart per question: bars for choices, NPS split,
    rating average and spread, number statistics, word list and AI summary
    for open text), *Responses* (table with a column picker across versions,
    filters on answers, date, status and score, search, response drawer,
    delete, export) and *Insights* (views, starts, completion rate, average
    time, drop-off per question, by day and by source).
  - "Publish" / "Publish changes"; Preview opens the real renderer and stores
    nothing.
- **Fill** (`/weldforms/fill/:publicId`): members-only forms.
- **Settings** (`/weldforms/settings`): themes, defaults, workspace templates.
- **CRM person page**: the Forms tab.

### Permissions

App `weldforms` in `packages/core/permissions/src/apps.ts`; objects in
`catalog.ts`:

- `forms:read|create|update|delete|publish|send|manage`. `send` is email
  invitations; `manage` covers workspace settings and themes, and opens every
  form, restricted ones included.
- `form_responses:read|export|delete`. Kept apart from `forms:read` on purpose
  (as PASS-002 keeps read and reveal apart): someone can see forms and counts
  without reading answers.
- A restricted form is a 404 to anyone not on its access list, short of
  `forms:manage`.
- Whatever shows answers outside the Results tab takes the right to read
  them on that form too: following a form (its mails carry answers; a
  subscriber who loses `form_responses:read` stops getting them) and an
  integration's test run. Copying a form takes the right to edit it, and the
  copy keeps the original's audience (`access` and the access list).
- Defaults: OWNER/ADMIN all; MEMBER everything except `forms:manage`; VIEWER
  `forms:read` and `form_responses:read`.

### Plan quota

There is no per-plan quota mechanism yet (WeldSign planned one and has not
built it). WeldForms builds it once, generic: a small plan-limit helper in
`@weldsuite/core-domain` reading limits from the plan definitions through the
licence context `licenceGate()` already caches (SEC-007), so WeldSign can use
it too. The WeldForms limit is completed responses per calendar month.

- Above it, forms show "This form is not accepting responses right now"
  (the cache's workspace flag) and admins get `forms.quota` at 80 % and 100 %.
- Someone already in a form can still submit, so nobody loses half-filled
  answers.
- Views, partial responses and previews are not counted.

### AI (Global only)

- **Generate**: describe a form, get a draft. `@weldsuite/ai` with structured
  output validated against the definition schema. In the builder, "Add
  questions about…" does the same for a few blocks.
- **Summarise**: per open-text question, themes with counts and example
  quotes, and sentiment; plus a summary of the whole form on Results. Cached
  per question and response count, regenerated on demand.
- Charged with `chargeAiUsage` (AI-005, BILL-006). On Kubernetes AI is off
  (AI-011): the Rust routes answer 503 `ai_unavailable`, as desk and connect do,
  and the UI hides the buttons.

### i18n

New namespaces `weldforms` (platform) and `forms-portal` (respondent chrome)
in `packages/core/i18n/src/locales/{en,nl}/`. The form's own content is in
whatever language the author writes; translations per form are "Later".

## Phases

Every phase lands in TypeScript and Rust in the same PR, with its routes in the
`forms` conformance suite.

| Phase | Scope | Done when |
|---|---|---|
| 0. Skeleton | `forms-api` scaffold and `rust/modules/forms`, `api-modules` + forwarder + `RUST_PORTED_MODULES`, schema (no migration until approved), permissions, entity-event catalog, app registration (`catalog.ts`, admin seed, `use-installed-apps.ts`, sidebar, icons, i18n), empty module page, `forms-portal` scaffold (Worker + Node build + Helm Deployment), engine and renderer package skeletons, secrets manifest entries, docs-repo design doc and ADRs | Module installs and opens on Global; the Rust backend serves the list route; conformance runs; CI green |
| 1. Builder and engine | Definition schema and engine (logic, variables, quizzes, recall, validation) with the shared fixtures in TS and Rust; renderer in both layouts; builder (Create, Logic, Design, Settings), folders, themes, duplicate, preview, publish and versions, a gallery of 8 starter templates | A branching quiz with three endings previews the same in both layouts, publishes as v1 and v2, and the fixtures pass in both languages |
| 2. Collect | Registries and cache, forms-portal (both layouts, phone, keyboard, en/nl, link previews), sessions, bot checks, rate limits, progress and partial responses, prefill and hidden fields, open/close dates and limits, file upload and signature, verified-email and members-only modes, QR code, embed SDK and configurator, view counter | A phone respondent and an embedded popup on a test page both submit; a request without a bot-check token cannot start; uploads end up in private storage; the Node portal works against the Rust backend |
| 3. Results | Responses table, filters, search, drawer, delete and erase, summary charts, insights and drop-off, CSV/XLSX export, realtime refresh, subscriptions and notifications, receipts | 1,000 seeded responses over two versions show correct summaries and drop-off; the export opens in Excel with every column |
| 4. Send by email | Invitations (members, CRM people, CRM list, pasted), personal links, tracking, manual and automatic reminders, outbound guard source `forms` | Three invitees, one answers; the reminder reaches only the other two, once per interval; a revoked link stops working |
| 5. Integrations | `ProcessResponse` and the actions log; CRM mapping and the person tab; Desk ticket; Flow task; WeldSheets connected table and nudge; WeldConnect template; website-builder block | One submission updates a CRM person with an activity, opens a ticket and creates a task; a failing step retries without repeating the others |
| 6. AI | Generate a form, add questions, summaries (Global; Rust answers `ai_unavailable`) | "Event registration with dietary needs" becomes a publishable form; summaries are charged to the wallet |
| 7. Quota, abuse and launch | Generic plan-limit helper and the response quota, usage bar, quota emails, abuse reports, admin suspend, publish-time content screen, help docs (`apps/web/docs` guide and screenshots), QA, app store row published | A Free workspace stops at its quota with a clear message; staff can suspend a form; the help guide is live |

### Progress

All phases were built in one branch (2026-11-09/10), TypeScript and Rust
together. Migrations: tenant `0250_weldforms`, master
`0065_weldforms_link_registry`.

- **Phase 0.** `forms-api` (port 8828, `/api/forms`, `/public/forms`), app-api
  forwarding (`FORMS_API`), schema and migrations, permissions (`forms:*`,
  `form_responses:*`), entity events (`form`, `form_response`, `form_folder`,
  `form_theme`, `form_integration`, `form_invitation`), the API contract
  (`@weldsuite/app-api-client/schemas/weldforms`, `domains/weldforms`), app
  registration, docs-repo design doc and FORMS-001..006.
- **Phase 1.** `@weldsuite/forms-engine` (definition schema, path, logic,
  variables, quizzes, recall, validation, 8 starter templates; shared JSON
  fixtures), `@weldsuite/forms-renderer` (both layouts, every field type), the
  builder (Create, Logic with a flow diagram, Design, Settings), folders,
  themes, versions, autosave with revision conflicts.
- **Phase 2.** The public mount (registry, KV cache, HMAC sessions,
  Turnstile/ALTCHA/none, rate limits and code attempts in `FormCounters`,
  uploads to a pending prefix, submit through the engine), members-only
  filling with uploads, `forms-portal` (Worker + Node build, Helm
  `formsPortal`, image in CI), `@weldsuite/forms-embed` (inline, popup,
  slider, popover, full page) served at `/embed.js`, the Share tab.
- **Phase 3.** Responses list with answer filters, columns across versions,
  summary, insights and drop-off, CSV/XLSX export, erase, cross-form
  responses for the CRM person tab, notifications (`forms.response`,
  `forms.digest`) and receipts.
- **Phase 4.** Invitations (members, CRM people, static CRM lists, pasted
  addresses), personal links `<portal>/i/<publicId>.<token>`, manual and
  automatic reminders from the due index, the outbound guard source `forms`.
- **Phase 5.** `ProcessResponse` with `crm`, `desk`, `flow`, `notify`,
  `receipt` and `quota` steps and per-step retry, integrations CRUD and test
  run, WeldSheets connected table `form_responses` (`@weldsuite/forms-domain`)
  with a form picker and "Open in WeldSheets", a WeldConnect trigger and
  template, the website-builder block `weldFormsForm`.
- **Phase 6.** AI generate, suggest blocks and open-text summaries (Global;
  the Rust backend answers 503 `ai_unavailable` and lists the edition
  feature `forms-ai` as unavailable, so the platform hides the buttons).
- **Phase 7.** Generic plan limits (`@weldsuite/core-domain/plan-limits`), the
  response quota and `forms.quota` emails, the publish content screen, abuse
  reports, the admin console's WeldForms page, help guide with screenshots
  from `/preview/weldforms` scenes.
- **Rust.** `rust/modules/forms` serves every route, the engine lives in
  `rust/crates/forms-engine` (same fixtures), `ProcessResponse` runs as a
  job and the reminder and digest sweeps as `weldsuite cron forms-reminders`
  and `forms-digest`. The `forms` conformance suite replays the forms-api
  tests against both backends (865 requests, 0 differences, 67 of 67 routes),
  AI routes excepted.

Changes against the plan above:

- Invitation links carry the public id (`/i/<publicId>.<token>`): the
  registry is looked up per form.
- Reminder schedules are fixed on the invitation when it is sent (request or
  workspace defaults, `form_invitations.reminder_*`).
- The WeldDesk integration targets a department (`departmentId`), the
  concept WeldDesk has; ticket attachments are copied to the public bucket
  under an unguessable path, as inbound email attachments are.
- Smart CRM lists can't be invited yet (`LIST_NOT_STATIC`).
- Instant response emails go through the notifications orchestrator, so a
  member's channel preferences apply.
- A filled honeypot or a too-fast submit answers 400 `SUBMISSION_REJECTED`.
- Members-only forms need no `forms:*` permission to answer; the respondent
  mode is the gate.
- WeldSheets has no refresh entrypoint, so new responses appear on the
  sheet's own refresh schedule (no `sheets` nudge step).
- The platform has no site editor, so the website-builder block has no form
  picker yet.
- The EU Flux values keep `formsPortal` off until `FORMS_PORTAL_SECRET`,
  `FORMS_SESSION_SECRET` and `ALTCHA_HMAC_KEY` are in the SOPS secrets.
- In Rust, the instant response email is sent when the notification is
  recorded; Global defers it two minutes through its deferred-email Workflow.

## Later (not in v1)

- Payments: a payment question charging through the workspace's own Stripe
  account (INT-010), for order forms and registrations.
- Custom domains (`forms.acme.com`) through Cloudflare for SaaS, and vanity
  slugs.
- Multi-language forms (one form, translations per language).
- A `weldforms-app` mobile app (MOB-001) for results and new-response pushes.
- Public API on external-api (`forms:*` scopes), headless submissions, and
  WeldAgent / MCP tools ("make a form for…", "summarise last week's
  responses").
- WeldConnect actions ("send this form to a person").
- A booking question (WeldCalendar), video and audio answers, A/B tests,
  scheduled result emails, staff editing of responses, live co-editing in the
  builder.
- Replacing WeldDesk's CSAT surveys and the website builder's contact blocks
  with WeldForms.
- An AI phishing classifier at publish, on top of the content screen.
- Auto-delete responses after N days per form (a due-index kind).

## Docs repo

A design doc `design/modules/weldforms.md` in `weldsuite-documentation` and ADRs
under a new `FORMS` area (a row in `CONTRIBUTING.md`), written in phase 0 with
the `weldsuite-docs` skill:

- FORMS-001 WeldForms is its own module and worker, built in TypeScript and
  Rust together (follows MERGE-001).
- FORMS-002 Respondents use a separate portal that calls forms-api's public
  mount on both editions, keyed by `FORMS_PORTAL_SECRET`; links route through
  master registries; no database credentials in the portal.
- FORMS-003 Forms are versioned: responses point at an immutable published
  snapshot, and one shared engine (with a Rust twin held equal by fixtures)
  decides the path, score and ending on the server.
- FORMS-004 Answers ride the entity-event bus, except files, signatures and
  fields marked sensitive.
- FORMS-005 Bot checks sit behind a port: Turnstile on Global, self-hosted
  proof of work on Kubernetes.
- FORMS-006 Integrations run in a durable `ProcessResponse` workflow, as the
  member who set them up.

CLAUDE.md (this repo) gets WeldForms in the module list, forms-portal in the
apps list and the embed SDK lockstep note.

## Open items

- Quota numbers per plan. Proposal: Free 100 responses a month, Starter 1,000,
  Pro 10,000, Business unlimited; the "Made with WeldForms" badge removable on
  paid plans only.
- Default limits: 25 MB per file, 10 files per field, 500 invitations per
  batch, rate-limit windows.
- Retention: proposal is to keep responses until the workspace deletes them;
  per-form auto-delete is "Later".
- What the analytics subscriber forwards from event `data`: if it passes
  payloads on to Mixpanel, `form_response` answers must be dropped there.
- Whether the Kubernetes object storage supports the lifecycle rule for
  pending uploads; if not, a due-index cleanup.
- Turnstile keys per environment and the ALTCHA key in the Helm chart.
- DNS and routes for `forms.weldsuite.org` / `forms-test.weldsuite.org`, and
  `forms.<domain>` on Kubernetes.
- A respondent privacy line in the portal footer, and a DPA note that the
  workspace is the controller of its respondents' data. Needs a legal read
  before launch.
- Ports: forms-api 8828, forms-portal 3025.
- Turnstile site and secret keys per environment (`TURNSTILE_SITE_KEY` var,
  `TURNSTILE_SECRET_KEY` secret on forms-api) and the new forms-api /
  forms-portal secrets in Doppler before the first deploy.
