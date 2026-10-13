# WeldReach: cold email outreach on Mailpool

Status (2026-10-12): built on branch `claude/weldsuite-cold-email-platform-72f54d`
(phases 1–4 and the code parts of phase 5); not deployed. Phase 0 checks with
real Mailpool mailboxes are still open, and the "Rollout checklist" below lists
the ops steps. Migrations were generated with the owner's go-ahead.

WeldReach is a new `weld*` module for cold email outreach. Mailpool provides the
sending infrastructure (mailboxes, warmup; domains come from WeldHost and are
connected to Mailpool through Cloudflare) and WeldSuite runs the
campaigns: sequences, mailbox rotation, limits, reply detection, a unified reply
inbox and the hand-off to WeldCRM. It is **on request only**: a workspace asks
for access, WeldSuite staff approve it in the admin console, and only then can
the module be installed.

## Decisions

| Question | Decision |
|---|---|
| Sending infrastructure | Mailpool (`https://app.mailpool.io/v1/api`), under **WeldSuite's own Mailpool account**. WeldSuite resells inboxes to approved workspaces. |
| Runtime | **Cloudflare Workers only.** SMTP over TCP sockets (`cloudflare:sockets`, ports 465/587) from the module worker. No VPS, no containers. |
| Reply detection | Mailpool mailboxes **forward incoming mail** (`forwardTo`) to a per-mailbox subaddress `reply+<token>@reply.weldreach.com` (test: `reply-test.weldreach.com`), received by Cloudflare Email Routing → the module worker's `email()` handler. Changed from `reply.weldsuite.org` (2026-10-12): every WeldSuite zone's catch-all already goes to WeldMail's inbound worker, catch-all rules are apex-only, so one literal rule per subdomain for `reply@…` plus subaddressing carries all tokens. No IMAP in v1; IMAP credentials are stored for a later fallback. |
| Where it lives | New module **WeldReach**: app code `weldreach`, worker `apps/workers/reach-api`, host `reach-api(-test).weldsuite.org`, paths `/api/reach/*`, dev port 8821. |
| Prospects | Separate prospect store in WeldReach (CSV import, CRM lists, WeldData leads). A CRM person (+ company) is created or linked **only when a prospect replies**, or when a user marks them interested. |
| Billing | **Stripe add-on per inbox: $5 per inbox per month**, all inbox types. A separate WeldReach subscription per workspace with one price, quantity = active inboxes (same pattern as `billing-worker/src/routes/phone-billing.ts`). Mailpool's cost is $3 (shared) / $4 (Google) per month. Domains are not billed by WeldReach (see below). |
| Domains | **Domains are normal WeldHost domains.** The customer buys them in WeldHost (WeldHost's prices, purchase and renewal billing), or brings an existing domain into WeldHost by transfer or by pointing its nameservers at WeldHost. WeldReach then **connects** a WeldHost domain to Mailpool through Mailpool's Cloudflare integration: DNS stays on Cloudflare, and Mailpool writes the mail records with its Cloudflare token. Nobody logs in to Mailpool. |
| Cloudflare account | **WeldSuite's main Cloudflare account** (the one WeldHost registers in), which Mailpool already has a token for. Owner's decision (2026-10-12), with the risk accepted (see Risks). |
| Access | **In-app request + admin approval.** Owner/admin submits a request form from the app store; staff approve, reject or suspend in the admin console. New requests are emailed to a configured address. |
| Limits | Per workspace, **editable in the admin console**. Defaults on approval: **10 mailboxes, 3 domains, 300 sends/day**. |
| Recipients | **B2B only.** Free-mail and consumer domains (gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com, …) are rejected at import and at send. Staff can lift this per workspace in the admin console. |
| v1 scope | Core (WeldHost domains connected to Mailpool, inboxes via Mailpool, campaigns with steps, rotation and limits, stop on reply, opt-out + suppression) **plus the unified reply inbox and AI reply classification**. |
| Inbox types in v1 | Mailpool `google` and `shared` (both return SMTP/IMAP credentials). **No `private`** in v1: it needs a dedicated-IP server ($200/month at Mailpool) that $5 per inbox doesn't cover. **No `outlook`**: Mailpool returns only email + password for those, so they need a Microsoft OAuth (Graph) integration first. |
| Tracking | No open-tracking pixel and no link tracking in v1. Nothing in an outbound email references a WeldSuite domain. |

Defaults (from the plan, confirmed by the owner):

- A new mailbox may join campaigns after 14 days of warmup. Per-mailbox cap: 30 sends/day by default, 50 maximum, ramping up from 10.
- Opt-out is a text line ("reply 'stop' to opt out") plus a `List-Unsubscribe: <mailto:…>` header pointing at the mailbox itself. No unsubscribe link in v1 (see "Deliverability rules").

## Where we are today

- **No outbound cold-email path exists.** Every WeldSuite send goes through the Cloudflare `send_email` binding (`packages/domains/mail/src/send.ts`, `apps/workers/app-api/src/services/internal-email.ts`). That service is for transactional mail and must never carry cold email.
- **CRM sequences** (`apps/workers/crm-api/src/routes/sequences/`, `packages/domains/crm/src/workflows/execute-sequence.ts`) run one Cloudflare Workflow per enrollment. They have no reply detection, rotation, throttling, sending windows or suppression, and they send through Cloudflare. WeldReach is built separately; it copies only the durable-execution ideas.
- **Mail campaigns** (`apps/workers/mail-api/src/services/mail/campaigns.ts`) are CRUD only; the fan-out worker was never built. Unrelated to WeldReach.
- **Gating building blocks**: Flagship flags (`packages/core/feature-flags`, toggled only in the Cloudflare dashboard); `workspace_licences.allowedApps` + `licenceGate` for partner workspaces; the KV workspace context (`ws:<org>`, 300 s TTL, `packages/core/worker-kit/src/db.ts`). There is no "workspace requests a gated app" flow yet.
- **Credentials at rest**: `encryptField`/`decryptField` in `@weldsuite/db/lib/crypto` (example: `apps/workers/books-api/src/services/bank-feeds/credentials.ts`), and `SENSITIVE_COLUMNS` in `packages/core/db/src/lib/sensitive-columns.ts`.
- **Inbound mail** reaches `apps/workers/mail-inbound-worker` through Cloudflare Email Routing (`email()` handler, `postal-mime`).
- **Timers**: crons must not wake tenant DBs; scheduled work goes through the D1 due index (`packages/core/worker-kit/src/due-index.ts`, kinds `mail_snooze | calendar_replan | domain_renew`).
- **No SMTP/IMAP client** and no `cloudflare:sockets` use anywhere in the repo.

## Mailpool (what we use)

Their API reference is at `mailpool.stoplight.io/docs/mailpool` (OpenAPI export: `Mailpool-API.yaml`). We need API access requested via their onboarding call.

- **Auth**: API key in the `X-Api-Authorization` header. Lists page with `limit`/`offset`. No documented rate limits, so the client retries with backoff on 429/5xx.
- **Cloudflare connection.** The owner has already connected WeldSuite's Cloudflare account to Mailpool. Today the connect calls exist only in Mailpool's web app (`https://app.mailpool.ai/v1`). **Mailpool is adding them to the public API** (confirmed by the owner, 2026-10-12). WeldReach uses only the public API version and never calls the web-app endpoints from production. The web-app versions show the expected shape:
  - `GET /domains/cloudflare/zones` lists every zone the token can see: `id`, `name`, `status`, `nameServers`, `alreadyConnected`, `unavailable`.
  - `POST /domains/cloudflare/connect` with `{ "domains": ["example.com"] }` returns `connected[]` and `skipped[]`. A connected domain comes back with its Mailpool `id`, `status: "Active"` and `dnsType: "CloudflareToken"`, nameservers unchanged.
  - Once Mailpool publishes it: re-export their OpenAPI file, regenerate the client types, and check the path, auth and response against the above.
- **Domains** (public API): DNS records (read/update), DMARC policy and report address, domain info, delete. WeldReach does **not** use Mailpool's registration, renewal, import (`/domains/transfer`) or domain-owner endpoints; WeldHost owns registration.
- **Mailboxes**: create (with `forwardTo`, signature, avatar), update, delete, bulk delete, scheduled deletion and cancel. Types `google | shared | private | outlook`. For google/shared/private the response carries `smtpHost/Port/TLS/Username/Password` and `imap*`.
- **Warmup**: add mailboxes, start, pause, ramp-up settings (`dailyTarget`, `replyRate`), status and day counter.
- **Checks**: spam checks, IP blacklist checks, inbox placement tests.
- **Subscriptions**: slots per inbox type (get/update/increase/decrease). WeldSuite's account must hold enough slots for all workspaces' inboxes.
- **Webhooks**: `domains.registered|updated`, `mailboxes.created|updated|deleted`, `spam-checks.*`, `ip-blacklist-checks.*`, `inbox-placements.*`. Signed with HMAC-SHA256 in `X-Signature`, computed over `JSON.stringify(payload)` (not the raw body). Verify against the parsed body with a timing-safe compare.

The client lives in `apps/workers/reach-api/src/lib/mailpool/`. Types are generated from the OpenAPI file with `openapi-typescript` and committed with the spec version; a thin `fetch` wrapper handles auth, retries and error mapping. Development and tests use Stoplight's mock server or a fetch stub.

## Architecture

```
platform SPA ──/api/reach/*──▶ reach-api (Hono, worker-kit apiAuth + reachAccessGate)
                                 │  ├─ Mailpool REST (connect domains, mailboxes, warmup, slots)
                                 │  ├─ WeldHost domains (tenant `domains` table, read-only ownership check)
                                 │  ├─ billing-worker (Stripe WeldReach subscription)
                                 │  └─ tenant DB (reach_* tables), master DB (access, routes)
cron * * * * * ─▶ due-index sweep (D1) ─▶ queue reach-send ─▶ consumer: SMTP send (sockets)
Mailpool mailbox ──forwardTo──▶ reply+<token>@reply.weldreach.com ─Email Routing─▶ reach-api email()
Mailpool webhooks ─▶ reach-api /webhooks/mailpool (HMAC) ─▶ master route lookup ─▶ tenant DB
admin console ─▶ master DB (workspace_app_access) + tenant install + KV cache bust
```

## Data model

All new tables are tenant tables in `packages/core/db/src/schema/reach.ts` unless marked master. IDs via `generateId()`. Every tenant query is workspace-scoped through the kit's tenant DB.

### Master DB

**`workspace_app_access`** (generic, so later gated apps reuse it)
- `id`, `workspaceId`, `appCode` (`weldreach`), unique (`workspaceId`, `appCode`)
- `status`: `requested | approved | rejected | suspended | revoked`
- `request` jsonb: company legal name, website, use case, target countries, expected daily volume, list source, contact, `termsAcceptedAt`, `termsAcceptedBy`, terms version
- `limits` jsonb: `maxDomains` (default 3), `maxMailboxes` (default 10), `maxDailySends` (default 300), `allowConsumerRecipients` (default false). Defaults live in one shared constant used by the admin console and reach-api.
- `requestedBy`, `requestedAt`, `reviewedBy`, `reviewedAt`, `reviewNotes`, `rejectionReason`, `suspendedReason`

**`app_catalog.requires_approval`** (boolean, new column). The install endpoint refuses such apps unless `workspace_app_access.status = 'approved'`.

**`reach_routes`**: maps external identifiers to a workspace, for webhooks and inbound mail.
- `kind`: `mailpool_domain | mailpool_mailbox | inbound_token`
- `externalId` (Mailpool id or inbound token), `workspaceId`, `tenantEntityId`
- `mailboxType`, `status` (for slot reconciliation)
- unique (`kind`, `externalId`)

### Tenant DB

**`reach_settings`** (one row): sender identity for the footer (company name, address), defaults (timezone, window, caps), `stopOnReplyScope` (`prospect | company`).

**`reach_domains`**: a WeldHost domain connected to Mailpool. `hostDomainId` (WeldHost `domains.id`, unique), `name`, `mailpoolDomainId`, `status` (`connecting | active | error | disconnecting`), `dnsStatus` (SPF/DKIM/DMARC), `dmarcPolicy`, `connectedAt`, `connectedBy`, `lastError`. Registration, expiry and renewal stay on the WeldHost row.

**`reach_mailboxes`**
- `domainId`, `mailpoolMailboxId`, `email`, `firstName`, `lastName`, `signature`, `type` (`google | shared | private`)
- `status`: `provisioning | warming | active | paused | suspended | error | deleting | deleted`
- `smtpCredentials`, `imapCredentials`: text, `encryptField(JSON)`. Registered in `SENSITIVE_COLUMNS`.
- `inboundToken`, `warmupStartedAt`, `warmupDay`, `dailyCap`, `rampCurrent`, `lastSentAt`
- `pausedReason`, `lastError`

**`reach_prospects`**: `email` (unique, lower-cased), `firstName`, `lastName`, `companyName`, `companyDomain`, `title`, `timezone`, `customFields` jsonb, `source` (`csv | crm_list | welddata | manual`), `sourceRef`, `personId` (CRM link, nullable), `validation` (`valid | role | no_mx | invalid | suppressed`).

**`reach_prospect_lists`** + **`reach_prospect_list_members`**: imported batches and saved lists.

**`reach_campaigns`**
- `name`, `status`: `draft | active | paused | completed | archived`
- `timezone`, `sendDays`, `windowStart`, `windowEnd`, `dailyLimit`, `minGapMinutes`
- `stopOnAutoReply`, `ownerId`, `pausedReason`
- `stats` jsonb: denormalised counters refreshed on events

**`reach_campaign_mailboxes`**: which mailboxes rotate in a campaign.

**`reach_campaign_steps`**: `order`, `delayDays`, `delayHours`, `subject`, `body` (plain text with simple markup), `replyInThread` (bool).

**`reach_enrollments`**
- `campaignId`, `prospectId`, `mailboxId` (sticky sender, chosen at first send)
- `status`: `queued | active | replied | bounced | unsubscribed | completed | paused | failed`
- `currentStep`, `nextSendAt`, `claimedAt`, `lastMessageId`, `threadRootMessageId`, `stoppedReason`
- unique (`campaignId`, `prospectId`)

**`reach_messages`**
- `direction`: `out | in`
- `campaignId`, `enrollmentId`, `stepId`, `mailboxId`, `prospectId`
- `messageIdHeader` (indexed), `inReplyTo`, `references`, `subject`, `snippet`, `r2Key` (raw .eml)
- `status`: `sending | sent | failed | unknown` (out); `kind` (in): `reply | auto_reply | bounce`
- `smtpResponse`, `classification`, `classifiedAt`, `readAt`, `handledAt`, `handledBy`, `sentAt`, `receivedAt`

**`reach_suppressions`**: `email` or `domain`, `reason` (`unsubscribed | bounced | complained | manual | negative_reply`), `source`, `createdBy`, unique on value.

Indexes that matter:
- `reach_enrollments (status, next_send_at)`
- `reach_messages (message_id_header)`
- `reach_messages (mailbox_id, sent_at)` for daily caps
- `reach_prospects (email)`
- `reach_suppressions (email)`

## Access and gating

1. **Catalog.** Master `app_catalog` row `weldreach` with `requiresApproval = true` (created in admin "App Catalog"). Platform registration: `app-registry.ts`, `MODULE_CONFIGS.weldreach`, `APP_NAMES`, `FALLBACK_CATALOG`, layout guard `useAppAccess('weldreach')`.
2. **Request.** In the app store, a `requiresApproval` app shows **Request access** instead of Install. The OWNER/ADMIN fills in the request form (fields as in `workspace_app_access.request`):
   - company legal name, website, contact person
   - use case (free text) and expected sends per day
   - target countries (required, multi-select)
   - where the lists come from: own customers / own research / bought list / other

   Terms the requester must tick, each one separately (the text is versioned; `termsVersion` is stored with the request):
   1. We email business addresses only, never consumers.
   2. We comply with anti-spam and privacy law (GDPR, ePrivacy, CAN-SPAM, …) in every country we email. Some countries, including the Netherlands and Germany, require prior consent for business addresses too, unless there is an existing customer relationship.
   3. Every email identifies us as the sender and contains a working opt-out. Opt-outs are honoured permanently.
   4. We don't use bought lists that were collected without a lawful basis.
   5. WeldSuite may pause or suspend sending at any time, for example on complaints, high bounce rates or a legal request, and may share our details with authorities when required by law.
   6. We are responsible for the content we send and the people we contact.

   Countries are not refused outright. The form shows a notice when the Netherlands or Germany is selected, and the reviewer sees the selected countries and list source next to the request. **Have a lawyer review the terms text before the first approval.**

   Endpoints live in **app-api** (the core app store, reachable before approval):
   - `POST /api/app-catalog/:code/access-request`
   - `GET /api/app-catalog/:code/access-request`

   A new request is emailed to the address in the app-api var `ACCESS_REQUEST_NOTIFY_EMAIL` (`gert@weldsuite.org`; new template `app-access-requested`, with a link to the admin console request) and shows up in the admin console list.
3. **Review.** Admin console: a new "Access requests" nav item, and a "WeldReach access" card on `app/workspaces/[id]`. Actions: approve, reject (reason), suspend/unsuspend, and **edit limits at any time**. The limits form is prefilled with the defaults (10 mailboxes, 3 domains, 300 sends/day; free-mail recipients off). The card also shows usage against the limits: domains, mailboxes, sends in the last 7 days, bounce and reply rates. Server actions follow `actions/workspaces.ts`: `guardWrite()`, master update, `recordConsoleAudit`, `revalidatePath`.
   - On approve: insert `workspace_installed_apps` (`weldreach`) in the tenant DB and bust the workspace KV context.
   - Approved and rejected emails use new `@weldsuite/emails` templates (`weldreach-access-approved`, `weldreach-access-rejected`, en + nl).
4. **Enforcement in reach-api.**
   - `reachAccessGate` middleware after `apiAuth()` reads `approvedApps` from the KV workspace context. Extend `getWorkspaceContextForOrg` the same way `licensedApps` is carried. Not approved → 404 (same as the payroll flag pattern).
   - The send consumer re-checks `workspace_app_access.status` in the master DB on every batch, so a suspension stops sending within a minute regardless of the KV TTL.
5. **Kill switch.** Flagship boolean `weldreach-sending` (default `true`). Off = no SMTP sends anywhere; campaigns stay as they are.

## Mailboxes, domains and warmup

> **Warmup is being replaced** by WeldSuite's own warmup network, with no Mailpool
> fallback: see [weldreach-warmup.md](weldreach-warmup.md). The Mailpool warmup
> described below is what the first build uses until that lands.

Onboarding wizard (first visit after approval):

1. Sender identity for the email footer (stored in `reach_settings`).
2. Payment method for inboxes (Stripe Checkout in setup mode via billing-worker).
3. Domains. The step lists the workspace's WeldHost domains that can be connected, with two shortcuts:
   - **Buy a new domain**: opens WeldHost's normal purchase flow (its own price and billing) and returns to the wizard. The UI recommends outreach look-alike domains (e.g. `getacme.com`), never the main company domain.
   - **Bring an existing domain**: opens WeldHost's transfer, or its "point your nameservers to WeldHost" flow. Once the domain is active in WeldHost, it shows up in the list.

   **Connect** calls Mailpool's Cloudflare connect for that domain. reach-api checks before connecting:
   - **Ownership.** The domain must be a row in *this workspace's* WeldHost `domains` table, active, with its zone in WeldSuite's Cloudflare account. The domain name is never taken from the client unchecked: Mailpool's token sees every zone in the account, including other customers' WeldHost domains.
   - **Existing mail and websites.** If the domain has MX records or a website (A/AAAA on the apex or `www`), the connect is blocked with an explanation. Mailpool writes its own MX, SPF, DKIM and DMARC, which would break the customer's existing email. Staff can force it from the admin console.
   - **Limits**: `maxDomains` from the approval.
4. Mailboxes: persona names, signature, type (`google` or `shared`).
   - Before each create: Stripe quantity +1, then the Mailpool slot increase for that type if needed, then Mailpool create with `forwardTo = reply+<inboundToken>@reply.weldreach.com`.
   - Store the credentials encrypted, write `reach_routes` rows, add the mailbox to Mailpool warmup.

Lifecycle:
- **Status changes** come from Mailpool webhooks (`mailboxes.updated`, `domains.updated`) routed through `reach_routes`.
- **Warmup progress** is pulled by a due-index sweep (kind `reach_warmup`; each workspace is due once a day, the hourly cron works through them in batches of 40). A mailbox becomes `active` after 14 warmup days or when DNS and warmup report healthy, whichever is later.
- **Deleting a mailbox**: Mailpool scheduled deletion, then Stripe quantity -1, then the route is marked deleted.
- **Disconnecting a domain**: only once it has no mailboxes left. Mailpool domain delete, then the `reach_domains` row is removed. The domain stays in WeldHost. Phase 0 checks whether Mailpool removes the records it wrote in Cloudflare; if not, reach-api removes them through `@weldsuite/cloudflare-zones`.
- **WeldHost side** (host-api):
  - a connected domain shows a "Used by WeldReach" badge, and the mail records Mailpool wrote are read-only in WeldHost's DNS editor;
  - deleting, transferring out or changing the nameservers of a connected domain is blocked until it's disconnected in WeldReach;
  - if a WeldHost domain expires or isn't renewed, reach-api pauses its mailboxes (via the `domain` entity events WeldHost already publishes).
- **Slot reconciliation**: a daily cron on the **master DB only** compares active `reach_routes` per type with Mailpool's subscription slots, decreases surplus and alerts on drift.

Limits from `workspace_app_access.limits` are enforced on every create.

## Sending engine

**SMTP client.** New package `@weldsuite/smtp` (`packages/core/smtp`) over `cloudflare:sockets`:
- implicit TLS (465) and STARTTLS (587, `socket.startTls()`), AUTH PLAIN/LOGIN, `MAIL FROM` / `RCPT TO` / `DATA` with dot-stuffing, `QUIT`, per-command timeouts;
- response classification: 4xx retryable, 5xx permanent, recipient 5.1.x as a hard bounce.

MIME is built with `mimetext` (already used in `packages/core/email`). Phase 0 also evaluates `worker-mailer` as an alternative to writing the client.

**Scheduling** follows the due-index rule (no tenant fan-out on a timer):
- When an enrollment gets a `nextSendAt`, the request path calls `markWorkspaceDue(workspaceId, 'reach_send', at)`.
- Cron `* * * * *` in reach-api runs `runDueIndexSweep` for `reach_send` and enqueues one `reach-send` queue message per due workspace.
- The queue consumer handles one workspace per message:
  1. check access status (master) and the kill switch;
  2. claim due enrollments (`UPDATE … SET claimed_at = now() WHERE status='active' AND next_send_at <= now() AND (claimed_at IS NULL OR claimed_at < now() - interval '10 min') RETURNING …`);
  3. group them by mailbox and send at most one email per mailbox per tick, honouring the mailbox daily cap, ramp, `minGapMinutes` (+ random jitter) and the campaign window in the campaign's timezone;
  4. re-mark the workspace due for the earliest next send.
- **No double sends**: the `reach_messages` row is written with status `sending` and a pre-generated `Message-ID` *before* the SMTP transaction. A row still in `sending` after a crash becomes `unknown` and is never retried automatically.

**Rotation.** A prospect's first email picks the campaign mailbox with the most remaining capacity today. That mailbox is sticky for the rest of the sequence, so follow-ups stay in one thread from one sender.

**Rendering.**
- Variables: `{{firstName}}`, `{{companyName}}`, custom fields, fallbacks `{{firstName|there}}`. A prospect with an unresolved variable is skipped and flagged, never sent with braces (same principle as the workflow engine's `resolve-inputs`).
- Plain text first, light HTML, mailbox signature.
- Every email gets the opt-out line and the sender identity footer from `reach_settings`.
- Follow-ups with `replyInThread` use `Re: <subject>`, `In-Reply-To` and `References`.

**Prospect validation on import.**
- syntax, de-duplication, the suppression list;
- consumer and free-mail domains rejected unless `allowConsumerRecipients` is on for the workspace (list kept in `@weldsuite/smtp` or a shared constant, checked again at send time);
- role addresses (`info@`, `sales@`, …) excluded by default;
- MX check through the existing MX-lookup cache in `packages/domains/mail` recipient validation.

A paid verification provider is a follow-up.

**Guardrails.**
- Auto-pause a mailbox after 5 hard bounces in a day, or when Mailpool reports it unhealthy.
- Auto-pause a campaign when its bounce rate exceeds 3% over the last 50 sends.
- Notify on unusually high negative or unsubscribe replies.
- Workspace `maxDailySends` caps the total across all campaigns.

## Replies, unified inbox and AI

**Inbound route.**
- Cloudflare Email Routing on the subdomain `reply.weldreach.com` (test: `reply-test.weldreach.com`) with subaddressing on and a literal rule `reply@<subdomain>` → reach-api's `email()` handler (catch-all is apex-only; weldreach.com's own catch-all stays with WeldMail).
- The local part is the mailbox's random `inboundToken`, resolved through master `reach_routes` to the workspace and mailbox. Unknown tokens are dropped.

**Processing** (in the handler, heavy parts via `waitUntil` or the queue):
1. Parse with `postal-mime`; store the raw message in R2 (as mail-inbound-worker does); de-duplicate on `Message-ID`.
2. Classify the kind:
   - **bounce**: `multipart/report; report-type=delivery-status`; parse `Final-Recipient` and `Status`;
   - **auto-reply**: `Auto-Submitted`, `X-Autoreply`, `Precedence`, out-of-office patterns;
   - otherwise **reply**.
3. Match to the outbound message through `In-Reply-To` / `References` against `reach_messages.messageIdHeader`. Fall back to the sender address with an active enrollment on that mailbox.
4. Effects:
   - **Reply**: enrollment → `replied`; stop the prospect's other enrollments (or the whole company domain when `stopOnReplyScope = company`). Create or link the CRM person and company through `@weldsuite/crm-domain/people` and `/companies`, log an activity through `/activities`. Publish entity events and send a realtime notification.
   - **Bounce**: enrollment → `bounced`, suppression (`bounced`), counts toward the mailbox and campaign guardrails.
   - **Auto-reply**: recorded only; the sequence continues unless `stopOnAutoReply`.
5. **AI classification** for replies via `@weldsuite/ai`, metered with `@weldsuite/core-domain/ai-billing` against the prepaid wallet.
   - Labels: `interested | meeting_request | not_interested | not_now | out_of_office | wrong_person | unsubscribe | other`.
   - `unsubscribe` adds a suppression. With an empty wallet the reply is stored as `unclassified`; reply processing never blocks on AI.
   - Needs the `CF_ACCOUNT_ID` + AI token secrets on reach-api.

**Unified inbox** (`app/weldreach/inbox`):
- Threads with filters: label, campaign, mailbox, unread, handled.
- The thread view shows the sent steps plus the replies.
- The composer sends through SMTP from the same mailbox with threading headers, stored as an outbound message.
- Actions: change label, mark handled, add to CRM (person, optionally an opportunity in a chosen pipeline), suppress.

Limitation (v1): an answer sent directly from the mailbox in Gmail, outside WeldSuite, is not captured. IMAP sync is the follow-up.

## Deliverability rules (hard requirements)

- **No WeldSuite domain anywhere in outbound cold email**: no links, pixels, `X-Mailer` or other headers. Otherwise weldsuite.org risks domain blocklists (Spamhaus DBL), which would hurt every WeldSuite email.
- No open tracking in v1.
- `List-Unsubscribe: <mailto:{mailbox}?subject=unsubscribe>` on every message, plus the opt-out text line. An "unsubscribe" email arriving through the forward is processed like a reply with that intent.
- Per-mailbox caps and ramp-up, random gaps, sending windows. Warmup stays on while a mailbox is in use.
- Suppression is checked at import **and** right before every send.

## Billing

New billing-worker routes `routes/reach-billing.ts`, modelled on `phone-billing.ts`:

- **One WeldReach subscription per workspace.** One price, **$5 per inbox per month**, quantity = active inboxes. Created on the first inbox.
- **Domains are not billed here.** WeldHost bills purchase and renewal with its existing pricing and renewal billing (`apps/workers/host-api/src/services/domain-renewal-billing.ts`). Connecting a domain to Mailpool is free.
- **Endpoints for reach-api** (service binding `BILLING_WORKER`):
  - `ensure-customer` (setup-mode checkout for a payment method)
  - `increment` / `decrement` (inbox quantity)
  - `status`
- **Order of operations**: Stripe first, then Mailpool. If Mailpool fails, the quantity is rolled back.
- **Payment failure** (`invoice.payment_failed` webhook): mark WeldReach billing `past_due` and notify. After a grace period (7 days, configurable), campaigns pause. Mailboxes are never deleted automatically.
- **Price**: $5.00 USD per inbox per month, a Stripe price created once per environment (ID in config).
- **Margin check**: $5 against Mailpool's $3 (shared) / $4 (Google) per inbox. The daily slot reconciliation also reports monthly Mailpool cost against Stripe revenue.

## Permissions

New app in `PERMISSION_APPS`: `{ code: 'weldreach', label: 'WeldReach', objects: [...] }`. Objects in `PERMISSION_CATALOG_OBJECTS`, mirrored in `apps/web/platform/lib/apps/app-permission-objects.ts`:

| Object | Covers | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| `reach_campaigns` | campaigns, steps, enrollments | all | read/create/update/delete | read |
| `reach_prospects` | prospects, lists, imports | all | read/create/update/delete | read |
| `reach_inbox` | replies, labels, sending replies | all | read/update/create | read |
| `reach_mailboxes` | domains, mailboxes, warmup (these cost money) | all | read | read |
| `reach_settings` | sender identity, suppressions, billing view | all | read | none |

OWNER keeps `*`. Requesting access is OWNER/ADMIN only (app-api route check).

## Entity events

New catalog file `packages/core/entity-events/src/events/reach.ts`:
- `reach_campaign`: created / updated / deleted / launched / paused / completed
- `reach_mailbox`: created / updated / deleted / suspended
- `reach_domain`: registered / updated
- `reach_prospect`: created / updated / deleted
- `reach_reply`: received / classified

Payloads never include credentials (`SENSITIVE_COLUMNS` covers the encrypted columns). The `reach_reply.classified` event (label `interested`) is what lets WeldConnect workflows create opportunities or notify sales.

## Platform UI

`apps/web/platform/app/weldreach/`, route wrappers in `src/routes/weldreach/`, hooks in `hooks/queries/use-reach-*-queries.ts`, client in `@weldsuite/app-api-client` (`domains/reach`, schemas `schemas/reach`).

- **Overview**: sends today, reply rate, interested count, mailbox health, warmup progress.
- **Campaigns**: list; builder (steps, prospects, mailboxes, schedule, settings); launch/pause; per-step stats.
- **Prospects**: lists, CSV import with column mapping and a validation report, add from CRM list, add from WeldData.
- **Inbox**: the unified reply inbox.
- **Mailboxes & domains**: connect WeldHost domains (with links to buy or bring one in WeldHost), create inboxes, warmup status, DNS health, pause/delete, disconnect.
- **Settings**: sender identity, defaults, suppression list (import/export), billing summary.
- **App store**: request-access dialog and status (pending, approved, rejected with reason).

i18n: new `reach` namespace in `packages/core/i18n/src/locales/en/reach.ts` and `nl/reach.ts`. Help docs: a WeldReach guide in `apps/web/docs` with screenshots (help-docs skill).

## Delivery

### Phase 0: spike and Mailpool onboarding (no merge)

- Mailpool onboarding call, to confirm:
  - API access, and the reseller/white-label terms for serving our customers from our account
  - **when the public Cloudflare connect endpoint ships**, and its final path and response
  - whether warmup is included in the inbox price; recommended per-inbox limits; how mailbox status changes appear in webhooks
- On a test domain (`appointspot.com` is already connected): which records Mailpool writes in Cloudflare, whether it overwrites existing MX/SPF/DMARC records, and whether it removes them when the domain is deleted in Mailpool.
- Prove from a deployed test Worker:
  - SMTP to a Mailpool `google` mailbox (465, app password) **without Google blocking sign-ins from Cloudflare egress IPs**;
  - SMTP to a `shared` mailbox (587 STARTTLS).
- Prove that `forwardTo` delivers replies, auto-replies and bounces with `Message-ID`, `In-Reply-To` and `References` intact, for both google and shared mailboxes.
- Prove Email Routing on the `reply-test.weldreach.com` subdomain to a worker, and that Mailpool accepts a `reply+<token>@…` forward address.
- Check the real shapes the code had to assume: Mailpool webhook payloads (the OpenAPI export had no webhook bodies; the parser accepts `event|type|eventType|name` with `data|payload|body|object`), the public Cloudflare connect endpoint, and whether `forwardTo` forwards inline or as an attachment.
- Update this plan's "To verify" list with the results. **If forwarding or Google sign-ins fail, stop and re-plan** (fallback: IMAP via Cloudflare Containers).

### Phase 1: foundation and access (PR 1)

- `api-modules`: `mod('reach', 8821, ['weldreach'], ['/api/reach'])`; `pnpm create:module-api reach`; `API_FORWARD_MODULES`; secrets manifest.
- Permissions, Flagship flag `weldreach-sending`.
- Master `workspace_app_access` + `app_catalog.requires_approval`. **Master migration needs approval.**
- app-api access-request routes and an install guard for `requiresApproval`.
- KV context `approvedApps` + `reachAccessGate`.
- Admin console: requests list, workspace card, actions, audit; email templates.
- Platform: app-store request UI, module shell (empty pages), sidebar, i18n.

### Phase 2: Mailpool, mailboxes and billing (PRs 2–3)

- Mailpool client + generated types; webhook route with HMAC verification; master `reach_routes`.
- Tenant tables `reach_settings`, `reach_domains`, `reach_mailboxes`. **Migrations need approval.**
- Encrypted credentials + `SENSITIVE_COLUMNS`.
- Domain flow: list connectable WeldHost domains, connect through Mailpool's public Cloudflare connect endpoint (ownership, MX/website and limit guards), DNS status, disconnect. **Depends on Mailpool shipping that endpoint.** Everything else in this phase can be built and merged first, with the connect step behind the endpoint's arrival.
- host-api: "Used by WeldReach" badge, read-only Mailpool records, blocks on delete / transfer-out / nameserver change, mailbox pause on domain expiry.
- Mailbox flow: create with `forwardTo`, warmup, pause, delete.
- Due-index kind `reach_warmup`; slot reconciliation cron.
- billing-worker `reach-billing` routes ($5 inbox price), webhook handling.
- Onboarding wizard + Mailboxes & domains pages (linking to WeldHost's purchase and transfer flows).

### Phase 3: sending engine (PRs 4–5)

- `@weldsuite/smtp` package with tests.
- Prospects, lists, import + validation, CRM list and WeldData sources.
- Campaigns, steps, enrollments, suppressions, messages. **Migrations need approval.**
- Due-index kind `reach_send`, cron, `reach-send` queue + consumer, claiming, rotation, caps, ramp, windows, rendering, opt-out, guardrails + auto-pause.
- Campaign builder and stats UI.

### Phase 4: replies, unified inbox, AI (PRs 6–7)

- `email()` handler, Email Routing config, R2 storage, matching, bounce/auto-reply parsing, stop-on-reply, suppression.
- CRM hand-off (person, company, activity) and entity events.
- AI classification with credit metering; realtime notifications.
- Unified inbox UI with reply sending.

### Phase 5: hardening and first customer

- Dashboards, alerting (bounce spikes, Mailpool errors, slot drift), runbook (suspending a workspace, Mailpool incident, payment failure).
- Help docs + screenshots, Playwright specs for request → approve → campaign launch (against the mock).
- Onboard the first approved workspace with low limits (e.g. 5 mailboxes, 150 sends/day), then raise.

## Tests

- **reach-api** (vitest + worker-kit pglite harness):
  - gate (not requested / pending / approved / suspended);
  - limits; claiming without double sends; caps, ramp, gaps, windows across timezones and DST;
  - rotation stickiness; rendering with fallbacks and unresolved variables;
  - suppression at send time; guardrail auto-pause;
  - billing order with rollback on Mailpool failure;
  - domain connect guards: another workspace's WeldHost domain is refused, as is a domain that isn't in WeldHost, one with MX records or a website (unless staff forced it), and one over `maxDomains`;
  - consumer-domain filter at import and at send, and the `allowConsumerRecipients` override;
  - webhook signature (valid, tampered, wrong secret) and routing.
- **host-api**: connected-domain badge, read-only Mailpool records, blocked delete / transfer-out / nameserver change.
- **`@weldsuite/smtp`**: fake socket scripts for 465/587, AUTH failures, 4xx/5xx paths, dot-stuffing, timeouts.
- **`email()` handler**: fixture `.eml` files for a Gmail reply, a forwarded reply, an Outlook reply, an out-of-office, DSN bounces from Gmail/Outlook/Postfix, a reply without threading headers, an unknown token, a duplicate.
- **app-api**: access-request routes, install guard.
- **billing-worker**: reach-billing quantity changes, `past_due` handling.
- **Admin console**: server actions (approve installs the app and busts the cache; suspend stops the consumer).
- **Platform**: hooks and key components; i18n keys present in en + nl.

## Risks

- **One Mailpool account for all customers.** Abuse by one workspace can get WeldSuite's Mailpool account restricted for everyone. Mitigation: approval, limits, guardrails, the kill switch, monitoring. Keep the data model ready for a per-workspace Mailpool key later.
- **Mailpool's Cloudflare token covers WeldSuite's whole account** (accepted by the owner, 2026-10-12). Mailpool, or anyone who compromises Mailpool, can change DNS for `weldsuite.org`, the other WeldSuite zones and every customer's WeldHost domain. Mitigation:
  - give the token only Zone Read + DNS Edit, nothing else, and rotate it;
  - alert on DNS changes made by that token to zones that aren't connected to WeldReach (Cloudflare audit logs);
  - keep the move to a separate Cloudflare account for outreach domains as a follow-up.
- **Cold-email domains share a Cloudflare account with weldsuite.org.** Abuse complaints about outreach domains land on the same account. Same mitigation as above: approval, limits and suspension.
- **Mailpool's public Cloudflare connect endpoint isn't released yet.** WeldReach can't connect domains until it is. Phase 2 is built so everything else merges first; never fall back to the web-app endpoints.
- **Google blocking SMTP sign-ins from Cloudflare egress IPs** for `google` mailboxes. Phase 0 must prove it; fallback is `shared` inboxes only.
- **Forwarding reliability** (missing headers, delays, Mailpool forwarding limits). Phase 0 must prove it; fallback is IMAP polling from Cloudflare Containers.
- **Legal exposure.** WeldSuite provides the tool and the infrastructure. Mitigation: terms acceptance with the request, stated target countries, suspension on complaints, opt-out in every email, suppression enforcement. Have the terms text reviewed by a lawyer before the first approval.
- **weldsuite.org reputation**: guarded by the "no WeldSuite domain in outbound mail" rule and code review.
- **Cost drift** between Mailpool slots and Stripe quantities: the daily reconciliation and alerts catch it.
- **Undocumented Mailpool rate limits**: client backoff; bulk operations queued, never fired in parallel.
- **Spoofed replies** (found while building): when a reply has no threading headers, the sender address decides which prospect it belongs to. A forged `From` equal to a prospect's address can stop that prospect's sequence, and a forged bare "stop" can suppress them. Header-matched replies are safe (Message-IDs are unguessable).
- **Billing after a Stripe cancellation**: if Stripe cancels the inbox subscription for non-payment while mailboxes remain, new mailboxes are refused (402 BILLING_CANCELED) until staff restart billing; there is no self-service restart yet.

## Owner answers (2026-10-12)

1. **Price**: $5 per inbox per month. Domains go through WeldHost at WeldHost's prices; this replaces the earlier "Mailpool price + 10%", which no longer applies now that Mailpool doesn't register the domains.
2. **Limits**: 10 mailboxes, 3 domains, 300 sends/day by default, editable per workspace in the admin console.
3. **Terms and countries**: as recommended in "Access and gating" (B2B only, terms ticked one by one, no countries refused outright, lawyer review before the first approval).
4. **Existing domains**: allowed. They come into WeldHost (transfer or nameservers) and are then connected like any WeldHost domain.
5. **Access-request notification**: `gert@weldsuite.org`, set in the app-api var `ACCESS_REQUEST_NOTIFY_EMAIL`.
6. **Currency**: the inbox price is charged in USD ($5.00).

## Rollout checklist (ops, per environment)

Code can't do these; run them before the first approval.

1. **Migrations**: master `0055` (workspace_app_access, reach_routes, app_catalog.requires_approval) and tenant `0209` (reach_* tables) go out with the normal deploy.
2. **Secrets** (`scripts/secrets/manifest.ts` → `reach-api`): `MAILPOOL_API_KEY`, `MAILPOOL_WEBHOOK_SECRET`, `AI_GATEWAY_API_TOKEN`, `CLOUDFLARE_API_TOKEN` plus the base API-worker secrets; then `pnpm secrets:sync <env> reach-api`.
3. **Queues**: `wrangler queues create reach-send-<env>` and `reach-send-dlq-<env>` (dev, test, production).
4. **Inbound replies** (weldreach.com zone): add the subdomain `reply-test.weldreach.com` / `reply.weldreach.com` under Email Routing → Settings → Subdomains, turn on Subaddressing, then a literal rule `reply@<subdomain>` → Worker `weldsuite-reach-api[-test]` (`wrangler email routing rules create weldreach.com --match-type literal --match-field to --match-value reply@<subdomain> --action-type worker --action-value weldsuite-reach-api[-test]`).
5. **Mailpool**: webhook URL `https://reach-api[-test].weldsuite.org/public/reach/webhooks/mailpool` with the same secret as `MAILPOOL_WEBHOOK_SECRET`; confirm the public Cloudflare connect endpoint is live and matches `src/lib/mailpool` (Phase 0 list).
6. **Cloudflare token for Mailpool**: limit it to Zone Read + DNS Edit; set up an alert on DNS changes by that token to zones not connected to WeldReach (accepted risk, see Risks).
7. **Flagship**: create the boolean flag `weldreach-sending` (default on) in test and production.
8. **Stripe**: nothing to create up front; billing-worker creates the $5.00/month inbox price on first use (or set `STRIPE_PRICE_WELDREACH_INBOX`).
9. **App catalog**: in the admin console → App Catalog, create `weldreach` (name WeldReach, path `/weldreach`), published, with **Requires approval** on.
10. **app-api**: deploy after reach-api so the `REACH_API` service binding resolves; `ACCESS_REQUEST_NOTIFY_EMAIL` is gert@weldsuite.org.
11. **Help docs**: take screenshots for `apps/web/docs/src/app/weldreach` once the screens are live (`pnpm --filter docs capture-screenshots:all`).
12. **Legal**: lawyer review of the request-form terms (`reach.access.terms.*`, version `weldreach-2026-10b`, which includes the warmup network term) before approving the first workspace.
13. **Warmup network** (docs/plans/weldreach-warmup.md):
    - generate one `WELDREACH_WARMUP_KEY` (64 hex characters) per environment and store it in Doppler; the same value goes to reach-api and reach-warmup-worker (`pnpm secrets:sync <env> reach-api reach-warmup-worker`). Losing it makes the pool logins unreadable (mailboxes then have to be re-registered).
    - queues `reach-warmup-send-<env>`, `reach-warmup-engage-<env>` and their `-dlq-<env>`;
    - Flagship flag `weldreach-warmup` (boolean, on);
    - make sure Mailpool does not put new mailboxes into its own warmup (Phase W0).

## Follow-ups (not in this plan)

- Outlook inboxes via a Microsoft OAuth (Graph) app.
- `private` inboxes on a dedicated-IP server, with their own pricing.
- A separate Cloudflare account for outreach domains, with Mailpool's token limited to it.
- IMAP sync, so mail sent directly from the mailbox shows up in the unified inbox.
- Link-based one-click unsubscribe and click tracking on a separate, isolated domain (or per-customer tracking subdomains).
- Paid email verification provider; inbox placement tests before launch (Mailpool API).
- A/B variants and spintax.
- Per-workspace own Mailpool API key option.
- WeldConnect triggers and actions for WeldReach (enroll from workflow, on interested reply).
- Found during the build:
  - Sidebar unread badge for the reply inbox (`useReachUnreadCount` exists; the module sidebar config has no per-item badge field yet).
  - A `mailpool_warmup_id` column on `reach_mailboxes` (the warmup sweep now looks the warmup inbox up by email once per run).
  - host-api: `markWorkspaceDue(…, 'reach_warmup', …)` when a connected WeldHost domain is suspended, cancelled or expires (today the hourly sweep notices it on its next visit or at the expiry date).
  - Entity events `reach_reply:replied` / `handled` for answers sent from the inbox and read/handled changes.
  - Unwrap replies Mailpool forwards as `message/rfc822` attachments, if Phase 0 shows it does that.
  - Self-service restart of billing after a Stripe cancellation.
  - Approvals reach the workspace within the 60 s KV TTL; the admin console cannot clear the cache key itself.
