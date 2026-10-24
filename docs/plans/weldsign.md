# WeldSign

An electronic-signature module for WeldSuite in the class of DocuSign: upload a
PDF, place fields, send it to one or more people, let them sign in the browser
without an account, and get back a signed PDF with a full audit trail.

## Decisions (agreed 2026-10-24)

| Question | Decision |
|---|---|
| Placement | Its own platform module (`/weldsign`, own sidebar entry) with its own worker, `sign-api` (`sign-api(-test).weldsuite.org`), one per module (API-001). |
| Signer page | New Next.js portal `apps/web/sign-portal` (`sign.weldsuite.org` / `sign-test.weldsuite.org`) reading through a `/public/sign-portal/*` mount on sign-api (FE-007, FE-008). |
| Signature level | Simple electronic signature (eIDAS SES / US ESIGN + UETA): drawn, typed or uploaded signature, audit trail, SHA-256 fingerprints and a certificate-of-completion page. No cryptographic PDF seal in v1. |
| Signer identity | The personal email link is enough by default. Per recipient the sender can require a 6-digit code emailed when the link is opened, or an access code the sender shares themselves. |
| File types | PDF only. |
| Billing | Included in the WeldSuite plans, with a monthly quota of sent envelopes per plan. |
| v1 extras | Signing order, reminders and expiry, templates, sending from CRM and WeldDrive. |
| Mobile | Later phase. The signer portal is built mobile-first so signing on a phone works from day one. |

## Concepts

- **Envelope**: one signing request. Has a title, a message, one or more
  documents, recipients, fields, a status and an expiry. What the user "sends".
- **Document**: a PDF inside an envelope, in page order. Up to 10 per envelope,
  25 MB each.
- **Recipient**: a person on the envelope, with a role:
  - `signer` fills in and signs fields,
  - `cc` gets the completed PDF, signs nothing.
  Each has a name, email, locale (en/nl), a routing order and an auth mode
  (`link`, `email_code`, `access_code`).
- **Field**: a box on a page that belongs to one recipient: `signature`,
  `initials`, `date_signed`, `name`, `email`, `text`, `checkbox`. Position in PDF
  points (page index, x, y, width, height), required flag, optional label.
- **Template**: a reusable envelope without real people: documents, fields and
  named **roles** ("Client", "Director") instead of recipients. Using a template
  copies it into a new draft envelope and asks who fills each role.
- **Event**: an append-only audit record (created, sent, opened, code verified,
  consented, field filled, signed, declined, reminded, voided, completed), with
  actor, IP, user agent and time. The certificate page is rendered from these.

### Envelope status

```
draft ──send──▶ sent ──first open──▶ in_progress ──last signer──▶ completed
                  │                      │
                  ├──decline─────────────┴──▶ declined
                  ├──void (sender)───────────▶ voided
                  └──expires_at passes───────▶ expired
```

Per recipient: `pending` (not their turn yet) → `sent` → `opened` → `signed` /
`declined`. With signing order, recipients with the same `routing_order` sign
in parallel; the next group is emailed when the current group is done.

Only a `draft` can be edited. A sent envelope can be voided (with a reason),
resent to a recipient, or have a recipient's email corrected (which revokes the
old link).

## Architecture

### `sign-api` worker (`apps/workers/sign-api`)

Scaffolded with `pnpm create:module-api sign` on `@weldsuite/worker-kit`.
Registered in `packages/core/api-modules/src/index.ts` as
`mod('sign', 8823, ['weldsign'], ['/api/sign'])` and in `API_FORWARD_MODULES`
with a `SIGN_API` binding on app-api.

Staff routes (Clerk, `apiAuth()`), organised by object:

| Route | Purpose |
|---|---|
| `/api/sign/envelopes` | list (filters: status, folder `sent`/`drafts`/`action_required`/`completed`), create draft, get, update draft, delete draft |
| `/api/sign/envelopes/:id/documents` | upload (multipart, proxied to R2), reorder, remove |
| `/api/sign/envelopes/:id/recipients` | add, update, remove, reorder |
| `/api/sign/envelopes/:id/fields` | bulk replace (the editor saves the whole field set) |
| `/api/sign/envelopes/:id/send` · `/void` · `/remind` · `/recipients/:rid/resend` | lifecycle |
| `/api/sign/envelopes/:id/events` | audit trail |
| `/api/sign/envelopes/:id/download` | signed PDF (with certificate) or the original while in progress |
| `/api/sign/templates` | CRUD + `POST /:id/use` → new draft |
| `/api/sign/settings` | defaults: expiry days, reminder cadence, sender name, brand colour/logo |
| `/api/sign/usage` | sent this month vs plan quota |

Public signer routes (`/public/sign-portal/*`, above the Clerk guard, no
workspace slug):

| Route | Purpose |
|---|---|
| `POST /session` | exchange the link token for a signer session; tells the portal whether a code is needed |
| `POST /verify` | email code / access code check (5 tries, then the link locks for 15 min) |
| `GET /envelope` | what this signer may see: documents, their fields, other signers' completed values, branding |
| `GET /documents/:docId` | the PDF bytes (original, or with earlier signers' values flattened) |
| `POST /consent` | records the e-signature disclosure acceptance |
| `POST /complete` | submits all field values + signature images in one request; validated server-side |
| `POST /decline` | with reason |
| `GET /download` | the completed PDF, for signers after completion |

### Signing links: master registry, hashed tokens

The signer link is `https://sign.weldsuite.org/r/<token>`, a random 32-byte
token. Only its SHA-256 is stored, in a master-DB registry
`sign_link_registry (token_hash, workspace_id, envelope_id, recipient_id,
expires_at, revoked_at)` (DATA-009 pattern), so the public mount can find the
tenant without a slug in the URL and a workspace rename never breaks a link.
The tenant row is the source of truth; the registry only routes.

After `session` (and `verify` when a code is required) the portal holds a
short signer session (2 hours, HMAC-signed, bound to recipient + envelope) in
an httpOnly cookie, the same shape as hr-portal and commerce-portal
(COM-007). Voiding, expiry, a recipient change or completion revokes the
registry row, so old links stop at once.

### Data model (tenant DB, `packages/core/db/src/schema/weldsign.ts`)

- `sign_envelopes`: id (`sgn_`), kind (`envelope` | `template`), title,
  message, status, sender member id, expires_at, reminder settings,
  `signing_order_enabled`, `source` (entity type + id when started from CRM or
  Drive), `file_back_folder_id`, completed_at, original/final SHA-256,
  `final_storage_key`, timestamps.
- `sign_documents`: envelope id, name, position, `storage_key`, page count,
  page sizes (jsonb), SHA-256.
- `sign_recipients`: envelope id, role (`signer` | `cc`), template role name,
  name, email, crm person id (nullable), locale, routing_order, auth_mode,
  access_code hash, status, sent/opened/signed/declined timestamps, decline
  reason, signer IP + user agent at signing.
- `sign_fields`: envelope id, document id, recipient id, type, page, x, y,
  width, height, required, label, `value` (text/checkbox/date), `signature_key`
  (R2 key of the adopted signature image).
- `sign_events`: append-only audit trail (no update or delete route; the
  service only inserts).
- `sign_settings`: one row per workspace.

Monthly usage is counted from `sign_envelopes.sent_at`; no separate counter.

Schema changes are fine to add; the tenant and master migrations are generated
only after explicit approval (CLAUDE.md).

### Files

All WeldSign files go to `PRIVATE_STORAGE` (EVT-015) under
`workspaces/<id>/weldsign/<envelopeId>/…`: originals, signature images and the
final PDF. Staff read them through sign-api; signers only through the portal
session. Nothing is put in the public bucket.

### PDF handling

- **Rendering** (platform editor and portal): `pdfjs-dist` (new dependency),
  pages rendered to canvas with an absolutely-positioned field layer on top.
  Field coordinates are stored in PDF points and converted per zoom level, so
  they are independent of screen size.
- **Validation on upload** (sign-api): `pdf-lib` (already used by books and
  payroll on Workers) loads the file, rejects encrypted or broken PDFs,
  stores page count and sizes and the SHA-256 of the original bytes.
- **Finalisation** (sign-api, Cloudflare Workflow `FinalizeEnvelope`, so a
  failed step retries without re-running the rest): flatten every field value
  and signature image onto the pages with `pdf-lib`, append a **certificate of
  completion** page (envelope id, original and final document hashes, each
  recipient with email, auth method, IP, user agent and timestamps of sent /
  opened / consented / signed, all in UTC), compute the final SHA-256, store it,
  then send the completion emails and file the PDF back. The final hash is also
  in the event log, so anyone can check a PDF against WeldSign later.
- Between signers, later signers see earlier values flattened into a working
  copy, so a signed field cannot be changed by the next person.

### Signing experience (sign-portal)

`apps/web/sign-portal`: Next.js 15, port 3023, Vercel, mirrors
`apps/web/hr-portal` (server-side proxy `app/api/portal/[...path]`, token only
in the httpOnly cookie, `APP_API_URL` server-only).

1. Open link → workspace branding (logo, colour), sender, envelope title and
   message.
2. Code screen when the recipient's auth mode asks for it.
3. E-signature disclosure + "I agree to use electronic records and signatures"
   (stored as a `consented` event with the disclosure version).
4. Document view with a guided "Next field" button; required fields are
   highlighted; the finish button unlocks when all required fields are filled.
5. Adopt signature once: draw (pointer/touch canvas), type (choice of three
   script fonts) or upload an image; reused for every signature/initials
   field of that recipient.
6. Finish → thank-you page, download link once the whole envelope is complete.
   Or decline with a reason at any point.

en and nl from the start (`@weldsuite/i18n`, new `weldsign` and portal
namespaces); the recipient's locale is set by the sender, the signer can
switch.

### Platform UI (`apps/web/platform/app/weldsign/`)

Route wrappers in `src/routes/weldsign/`, client in
`@weldsuite/app-api-client` (`domains/weldsign`), hooks in
`hooks/queries/use-weldsign-queries.ts`.

- **Overview** (`/weldsign`): folders *Action required* (envelopes where the
  signed-in member's email is a current signer; opening one goes to the portal
  link), *Waiting for others*, *Drafts*, *Completed*, *Declined/voided*; usage
  bar against the plan quota.
- **New envelope wizard** (`/weldsign/new`, `/weldsign/:id/edit`):
  1. Documents: upload PDFs, or pick from WeldDrive.
  2. Recipients: name + email, or pick a CRM person or workspace member; role,
     signing order (drag to reorder, toggle on/off), auth mode, locale.
  3. Fields: drag field types from a palette onto the pages, one colour per
     recipient; resize, duplicate, required toggle.
  4. Review: subject, message, expiry, reminders → Send.
- **Envelope detail** (`/weldsign/:id`): recipient progress, activity timeline,
  document preview, download (signed PDF / certificate), remind, resend,
  correct email, void.
- **Templates** (`/weldsign/templates`): same editor with roles instead of
  people; "Use template".
- **Settings** (`/settings/weldsign` or a tab in the module): defaults and
  branding.

### Reminders and expiry

`sign-api` gets a cron that runs a due-index sweep (`@weldsuite/worker-kit`
`due-index`, like FLOW-008 / REACH-006): a workspace is marked due when it has
a sent envelope with a reminder or expiry coming up, so the sweep never wakes
idle tenant databases (DATA-008). Each run sends reminders to current signers
who have not signed (default: after 3 days, then every 3 days, at most 3) and
moves past-expiry envelopes to `expired`, revoking their links. Defaults come
from `sign_settings`, overridable per envelope.

### Emails

New templates in `@weldsuite/emails` (`.claude/skills/weldsuite-email`), en +
nl, from `notifications@mail.weldsuite.org` with the workspace name as display
name and the sender's address as Reply-To:

- `sign-request` (please sign, with the link), `sign-reminder`,
  `sign-code` (6-digit code), `sign-completed` (to sender, signers and cc, with
  a download link, PDF attached when under 10 MB), `sign-declined`,
  `sign-voided`, `sign-expired` (to sender).

The send path goes through the outbound guard like any other system email that
reaches external addresses.

### Signing order, CRM and Drive

- **Signing order**: `routing_order` per recipient; `send` emails only the
  lowest group; each signature checks whether its group is done and emails the
  next one.
- **From Drive**: a "Send for signature" action on PDF files in WeldDrive opens
  the wizard with that file. sign-api copies the bytes into its own private
  prefix, so later edits or deletes in Drive do not change what was signed.
- **From CRM**: "Send for signature" on a company, person, opportunity and quote
  (quote: its PDF is generated and attached). Recipients are suggested from the
  record's people. `source` stores the record.
- **Filing back**: on completion the signed PDF is saved to the chosen Drive
  folder (default `WeldSign/<year>`) and, for CRM sources, linked to the record
  as a file and an activity ("Contract signed by …"). sign-api does this through
  shared domain code (`@weldsuite/core-domain` drive helpers, `@weldsuite/crm-domain`)
  or an app-api internal entrypoint (API-008), never by importing another
  worker's folder.

### Entity events

WeldSign publishes entity events (`sign_envelope`: `created`, `sent`,
`viewed`, `signed` (per recipient), `completed`, `declined`, `voided`,
`expired`) so WeldConnect can start a workflow on "contract signed", the audit
log and realtime list refresh keep working, and agents can react. Field values
and signature images are never in the payload (EVT-005): only ids, title,
status and recipient names/emails. `sign_events` stays the legal trail; the
bus is not a substitute for it.

### Permissions

App `weldsign` in `packages/core/permissions/src/apps.ts`, objects
`sign_envelopes` and `sign_templates` (prefixed like `reach_*`, so they don't
collide with a generic object name):

- `sign_envelopes:read|create|update|delete|send|void|manage`,
  `sign_templates:read|create|update|delete`. `sign_envelopes:manage` covers the
  settings and seeing every envelope in the workspace.
- Without `sign_envelopes:manage` a member sees the envelopes they sent and the
  ones they are a recipient of.
- Defaults: OWNER/ADMIN all; MEMBER read/create/update/delete/send/void (own) +
  templates read; VIEWER `sign_envelopes:read` + `sign_templates:read`, which
  only shows envelopes they are a recipient of.

### Plan quota

There is no generic per-plan quota mechanism yet. v1 adds a `weldsign`
limit to the plan definitions in billing (sent envelopes per calendar month),
exposed through the licence context `licenceGate()` already caches
(SEC-007). `POST /send` refuses with `quota_exceeded` above the limit; the UI
shows the usage bar and an upgrade link. Drafts and templates are not limited.

## Phases

| Phase | Scope | Done when |
|---|---|---|
| 0. Skeleton | `sign-api` scaffold + api-modules + forwarder, schema (no migration until approved), permissions, app registration in `use-installed-apps.ts` and the app store, empty module page, `sign-portal` scaffold, docs-repo design doc + ADRs | Module installs and opens; CI green |
| 1. Drafts and editor | Upload + validation, recipients, field editor with pdf.js, save/load drafts, envelope list | A draft with fields survives a reload |
| 2. Send and sign | Link registry, emails, portal session + codes, consent, guided signing, adopt signature, decline, signing order, FinalizeEnvelope workflow, certificate page, download, entity events | Two external signers in order complete an envelope; final PDF has both signatures, the certificate and a matching hash |
| 3. Lifecycle | Reminders + expiry sweep, void, resend, correct email, envelope detail timeline | Expired and voided links stop working; reminders send once per interval |
| 4. Templates | Template editor with roles, use template | A template becomes a sendable draft in two clicks |
| 5. CRM and Drive | Send from Drive and CRM records, file back to Drive and CRM | Signed contract appears on the CRM company and in Drive |
| 6. Quota and docs | Plan limit, usage bar, help docs (`apps/web/docs` guide + screenshots), QA pass | Free plan blocked after its quota; help guide live |

### Progress

**Phase 0: done** (weldsuite/weldsuite#1304). Module, worker, schema, migrations
(tenant `0223_weldsign`, master `0060_weldsign_link_registry`), permissions,
sign-portal scaffold, docs (SIGN-001..004).

**Phase 1: done.**

- sign-api: `/api/sign/envelopes` (list by folder and search, create, get,
  update, delete draft) with `/documents` (multipart upload, reorder, content,
  remove), `/recipients` (add, update, remove) and `/fields` (replace the set).
  PDFs are checked with pdf-lib (readable, not encrypted, at most 500 pages and
  25 MB), stored in `PRIVATE_STORAGE` with their page sizes (crop box as
  displayed, rotation applied) and SHA-256. Fields are checked against the
  documents and recipients (on an existing page, inside it, for a signer).
  Access codes are stored as a keyed hash (HMAC with `SIGN_SESSION_SECRET`,
  bound to the recipient) and never returned. A member without
  `sign_envelopes:manage` sees only their own envelopes; anything else is a 404.
  Mutations publish `sign_envelope` created/updated/deleted.
- Shared contract: `@weldsuite/app-api-client/schemas/weldsign` and
  `/domains/weldsign`.
- Platform: the list (folders, search, new request creates a draft and opens
  it, delete draft) and a four-step editor (documents, recipients, fields,
  review). Fields are placed on pdf.js-rendered pages (`pdfjs-dist` 5.7, loaded
  on demand), moved and resized with the pointer, and saved as a set; leaving
  the fields step saves too. Review lists what is still missing before sending;
  the Send button stays disabled until phase 2.
- Deferred: the "Action required" folder (envelopes where the member is a
  signer) and the per-recipient visibility rule that goes with it; now
  planned for phase 3.

**Phase 2: done.**

- Send (`POST /api/sign/envelopes/:id/send`, `sign_envelopes:send`): checks
  the draft (documents, signers, a signature field per signer, emails), sets
  the expiry (chosen in the send dialog, default 30 days), creates a hashed
  link per recipient of the first signing group and emails them. The batch is
  checked by the outbound guard first (new source `sign`); a refusal changes
  nothing and tells the sender.
- Signer portal mount `/public/sign-portal` (session, verify, resend-code,
  envelope, documents, consent, complete, decline, download), signer sessions
  as HMAC tokens (`SIGN_SESSION_SECRET`, 2 hours), emailed 6-digit codes and
  access codes with 5 tries per 15 minutes, all in KV. The sign-portal app
  keeps one httpOnly session cookie per link, so two links in two tabs stay
  apart.
- Signing stores the signature and initials PNGs, fills name, email and date
  server-side, records IP and browser, and rebuilds a working copy of each
  touched document so later signers see earlier values. The next signing
  group is emailed when the current one is done. The IP is the one
  sign-portal reports (`X-Signer-Ip`), trusted only next to the shared
  `SIGN_PORTAL_SECRET` (`X-Sign-Portal-Key`); any other caller is recorded
  by its own address.
- The last signature starts the `FinalizeEnvelope` Workflow: one PDF (all
  documents with values drawn in, rotation-aware, then the certificate of
  completion), its SHA-256 stored and on the trail, then the "everyone
  signed" email with the PDF attached (up to 10 MB) to signers, copy
  recipients and the sender. If the Workflow cannot start, the last signer
  gets a 503 (their signature stays saved) and finishing again retries the
  start; reopening any link of the request also starts it again. The
  instance id is fixed per request, so a second start leaves a running one
  alone and restarts a failed one.
- Evidence trail: sent, opened, code_verified / code_failed, consented,
  signed, declined, completed, delivered.
- Emails (`@weldsuite/emails`): `sign.request`, `sign.code`,
  `sign.completed`, `sign.declined`, en + nl, workspace-branded.
- Entity events: `sign_envelope` `sent`, `signed`, `declined`, `completed`.
- Platform: Send button with an expiry date, and a status view for sent
  requests (who signed, download of the signed PDF).

**Phase 3: done.**

- Lifecycle sweep: a cron on sign-api (`*/15`) runs a due-index sweep (kind
  `sign_lifecycle`, `SCHEDULE_INDEX` D1). It sends the automatic reminders
  that are due and expires open requests past their expiry (every link
  revoked, the sender told who had not signed). Sending, the next signing
  group and a corrected email re-derive the workspace's next due time; the
  one-time seed reads the master link registry, never the tenant DBs.
- Reminders: first after `reminderAfterDays`, then every `reminderEveryDays`
  (or `reminderAfterDays` again when unset), at most `reminderMaxCount`
  (default 3), never at or after the expiry; once per interval however late
  the sweep runs. Each one is a fresh link in a "Reminder:" variant of the
  request email, through the outbound guard.
- Owner actions on a sent request: void with a reason (`sign_envelopes:void`;
  links revoked, signers who had it are emailed), remind everyone whose turn
  it is (`sign_envelopes:send`; skips anyone emailed in the last hour),
  resend one signer a link, and correct a recipient's name or email (old
  links revoked; on their turn a new link and a fresh start, consent asked
  again). The activity endpoint lists the evidence trail.
- Visibility: a member also sees sent requests they are a recipient of (by
  email), read-only and without the activity. The "Action required" folder
  lists open requests where it is their turn, and "Sign now" gets them a
  fresh link (the portal still asks their code).
- Emails: `sign.request` with a reminder variant, `sign.voided`,
  `sign.expired`, en + nl. Entity events: `sign_envelope` `voided` and
  `expired`; reminders, resends and corrections publish `updated`.
- Platform: the "Action required" folder, Sign now, Remind, Void, Resend link
  and Correct email on a sent request, and its activity timeline.

Changes against the plan above:

- Void notices are not counted by the outbound guard: they only reach people
  who already had the request. Reminders, new links and corrections are.
- A reminder sent by hand does not use up an automatic one; it only moves the
  next automatic reminder a full interval on.
- No `viewed` entity event: a signer opening the link is evidence
  (`sign_events`), not a bus event.
- Completion does not revoke links: they stay valid for 30 days to download
  the signed PDF, and signers and copy recipients get a fresh link in the
  completion email. Decline (and later void and expiry) revokes them.
- The certificate page is in English for every workspace.
- PDFs that do not embed their fonts render with substitute fonts in the
  portal (pdf.js gets no standard-font data yet); the signed PDF itself is
  unaffected.

## Later (not in v1)

- PAdES seal with a WeldSuite certificate (Adobe "signed and unchanged" check),
  long-term validation, and qualified signatures through a trust service
  provider (itsme, iDIN).
- `weldsign-app` mobile app (MOB-001).
- Word and image upload with server-side conversion.
- Bulk send (one template to a list), in-person signing, SMS codes, signer
  attachments, payment collection.
- Public API on external-api (`wsk_` keys, `sign:*` scopes) + outbound webhooks,
  and WeldAgent / MCP tools ("send this quote for signature").

## Docs repo

A new design doc `design/modules/weldsign.md` in `weldsuite-documentation` and
ADRs under a new `SIGN` area, written in phase 0 (skill `weldsuite-docs`):

- SIGN-001 WeldSign is its own module and worker.
- SIGN-002 Signers use a separate portal; links route through a hashed master
  token registry, not a workspace slug.
- SIGN-003 Simple electronic signatures with an append-only evidence trail,
  hashed documents and a certificate page; no PDF seal in v1.
- SIGN-004 Signed artefacts live only in the private bucket.

## Open items

- Quota numbers per plan (proposal: Free 3, Starter 25, Pro/Business unlimited).
- Final wording of the e-signature disclosure (en/nl): needs a legal read
  before launch.
- Retention: how long envelopes, signature images and events are kept after
  completion, and what happens on workspace deletion (proposal: kept until the
  workspace deletes them; deleting a completed envelope keeps its `sign_events`
  and hashes).
- DNS and Vercel project for `sign.weldsuite.org` / `sign-test.weldsuite.org`.
