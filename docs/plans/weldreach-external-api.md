# WeldReach on the external API

WeldReach (cold email outreach, [weldreach.md](weldreach.md)) gets a public API on `external-api` (`api.weldsuite.org`, `wsk_` keys) and the same actions as tools in `mcp-server`. Precedent and checklist: [weldmail-external-api.md](weldmail-external-api.md).

## Decisions (owner, 2026-10-13)

- **What the API does:**
  - Prospects and campaigns, read and write. This covers creating, launching, pausing and resuming campaigns and adding prospects to them.
  - Reading the reply inbox.
  - Sending replies.
  - Reading mailboxes and domains. Creating or deleting a mailbox or domain stays in the app, because each inbox is billed at $5 a month.
- **MCP:** the same actions as tools, except reply sending. The mcp-server guard test refuses any send or reply route or tool, on purpose.
- **Paths** live under `/v1/reach/…`. `findModuleForExternalPath` maps them to the `reach` module, so the partner licence gate applies with no extra entry in `EXTERNAL_OBJECT_MODULES`.
- **Scopes** are the permission-catalog objects, so mcp-server needs no alias:

  | Scope | Covers |
  |---|---|
  | `reach_campaigns:read` / `:write` | campaigns, steps, campaign mailboxes, enrolments, launch/pause/resume, stats, overview |
  | `reach_prospects:read` / `:write` | prospects, import, lists, list members |
  | `reach_settings:read` / `:write` | suppressions (same permission object reach-api uses for them) |
  | `reach_inbox:read` | threads, a thread, the unread count |
  | `reach_inbox:reply` | send a reply. **Named only:** `*` and `reach_inbox:*` do not grant it, like `mail_messages:send` |
  | `reach_mailboxes:read` | mailboxes and domains |

- **Approval gate.** Only staff-approved workspaces get through, the same as reach-api's `appAccessGate`. Any other status returns 403 `APP_ACCESS_REQUIRED` with `{ appCode, status }`. The gate's result also carries the workspace limits (daily sends, consumer recipients) and the billing status that the launch and reply checks use.
- **Same behaviour as the app.** Every API write runs the same domain function as the matching reach-api route and publishes the same entity event. That means:
  - suppression and validation rules, daily caps, sending windows and the `weldreach-sending` kill switch apply unchanged;
  - webhooks a customer configured in WeldConnect (`external_webhooks`) fire for API writes too.

## Endpoints

All of these are under `/v1/reach`.

**Overview** (`reach_campaigns:read`)
- `GET /overview`: the overview numbers.
- `GET /access`: status, limits and today's usage.

**Campaigns** (`reach_campaigns:read`; writes need `:write`)
- `GET|POST /campaigns`
- `GET|PATCH|DELETE /campaigns/:id`
- `PUT /campaigns/:id/steps`
- `PUT /campaigns/:id/mailboxes`
- `POST /campaigns/:id/prospects`: enrol prospect ids or a list.
- `GET /campaigns/:id/enrollments`
- `DELETE /campaigns/:id/enrollments/:enrollmentId`
- `POST /campaigns/:id/launch|pause|resume`
- `GET /campaigns/:id/stats`

**Prospects** (`reach_prospects:read`; writes need `:write`)
- `GET|POST /prospects`
- `POST /prospects/import`: a JSON array, up to `REACH_IMPORT_MAX_ROWS`.
- `GET|PATCH|DELETE /prospects/:id`
- `GET|POST /lists`
- `GET|PATCH|DELETE /lists/:id`
- `POST /lists/:id/members`
- `POST /lists/:id/members/remove`

**Suppressions** (`reach_settings:read`; writes need `:write`)
- `GET|POST /suppressions`
- `DELETE /suppressions/:id`

**Inbox** (`reach_inbox:read`)
- `GET /threads`: filter by label or unread; `unreadCount` is in the response meta.
- `GET /threads/:threadKey`
- `POST /threads/:threadKey/reply`: needs `reach_inbox:reply`.

**Mailboxes** (`reach_mailboxes:read`)
- `GET /mailboxes`
- `GET /mailboxes/:id`
- `GET /domains`
- `GET /domains/:id`

All request and response bodies use the existing Zod schemas in `@weldsuite/app-api-client/schemas/reach`. Responses use the standard envelopes. Lists use cursor pagination with reach's own limits (default 25, max 100).

## Phase 0: shared foundation (`@weldsuite/reach-domain`)

Business logic moves out of reach-api so external-api and mcp-server can run it without importing another worker's folder. reach-api's routes become thin wrappers, and its existing tests must stay green.

- **Move these services** into `packages/domains/reach/src/`, each as its own subpath export: `campaigns`, `enrollments`, `prospects` (with `validation`), `lists`, `suppressions`, `render`, `list-query`, `overview`, `send-window`.
- **Inbox:**
  - Move the read side (`listThreads`, `countUnreadThreads`, `loadThread`, `getThread`) with the MIME and text helpers. `getThread` takes an R2 bucket argument instead of `Env`.
  - Move reply sending (`replyToThread`, `outbound`, `reply-effects`, the credential opener) behind a narrow deps object: db, R2, encryption key, inbound domain and a `maySend` result. No `Env` or Hono `Context` crosses into the package.
- **Mailboxes:** split the read path (`listMailboxes`, `getMailboxDto`, `toMailboxDto`, the warmup blocker) away from the Mailpool and billing write path. Only the reads move.
- **Inline route logic:** turn the campaign and prospect logic that lives in the route handlers into domain functions (create, patch, delete, steps, mailboxes, enrol, launch, pause, resume, prospect create and import).
- **Scheduling:** waking the send sweep is a port the caller passes in (`onDue(kind)`), because only the callers hold `SCHEDULE_INDEX`.
- **Errors:** domain functions throw a typed `ReachDomainError(code, status, details?)`. Each worker maps it to its own response, so codes and statuses stay identical across workers.
- **Access:** `readAppAccess` in worker-kit accepts a master-DB handle, so external-api can use `HYPERDRIVE_MASTER` and reuse the same `WORKSPACE_CACHE` key (`appaccess:<clerkOrgId>:weldreach`, 60 s).

## Phase 1: external-api routes

- **Routing and gate:**
  - Add `routes/v1/reach/`: one router mounted at `/reach`, with a file per object.
  - Add a `reachAccess` middleware for the gate. It reads by `session.clerkOrgId`, falling back to `resolveClerkOrgId`.
  - Add the endpoints to the `GET /v1` list.
- **Bindings** (all three envs, in `wrangler.toml`):
  - `SCHEDULE_INDEX`, the D1 schedule index, so launch, resume and enrol wake the send sweep for the Clerk org id.
  - `REACH_INBOUND_DOMAIN`.
  - `FLAGSHIP`, for the `weldreach-sending` kill switch, if external-api doesn't already have it.
  - `DATABASE_ENCRYPTION_KEY` and `STORAGE` are already there.
- **Tests:** pglite with the harness `createExternalTestApp` and a `WORKSPACE_CACHE` stub. Cover:
  - each scope returning 403 without it;
  - the gate returning 403 when access isn't approved;
  - the CRUD round-trips;
  - launch waking the index;
  - `reach_inbox:reply` not being granted by `*`.

## Phase 2: reply sending

- `POST /v1/reach/threads/:threadKey/reply`, behind `reach_inbox:reply`. The check order is the same as the app route:
  1. the kill switch;
  2. the billing status (`maySend`);
  3. the mailbox state;
  4. the SMTP send;
  5. stop-on-reply effects.
- Responses: 201 with the sent message. Errors use the domain codes (`MAILBOX_NOT_SENDABLE`, `SENDING_DISABLED`, …).

## Phase 3: mcp-server parity

- Copy every route except reply into `mcp-server/src/api/routes/v1/reach/`, keeping the files byte-identical where possible.
- Add the bindings mcp-server lacks: `SCHEDULE_INDEX` and `WORKSPACE_CACHE`, or a direct master read without the cache.
- Add `tools/reach/index.ts` to `allTools`.
- The send/reply guard test must stay green.

## Phase 4: client surfaces and docs

- **API key UI** (`api-keys-section.tsx`): a WeldReach group with every scope above. `reach_inbox:reply` goes in `NAMED_ONLY_SCOPES` and is marked sensitive.
- **WeldApps consent labels** in `weldapps.ts`, en and nl.
- **api-docs:**
  - one page per object, with Navigation group entries;
  - the scopes in `authentication/page.mdx`;
  - `APP_ACCESS_REQUIRED` in `errors/page.mdx`;
  - a changelog entry.
- **App SDK:** typed wrappers in `packages/sdk/app-sdk/src/core/api.ts`.

## Order

One branch (`claude/weldreach-external-api`) with a commit per phase, and one PR to develop. There are no migrations.
