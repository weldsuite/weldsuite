# WeldMail storage: faster cold opens, then mailboxes in Durable Objects

Status (2026-10-28): phase 0 is built (its baseline runs are not done yet);
phases 1–6 are built behind the `weldmail-mailbox-store` flag, default
`postgres` (see "As built: phases 1–6"). The owner committed to the
mailbox Durable Object (see "Owner answers"), recorded as ADR
[MAIL-009](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/MAIL-009-mailbox-contents-in-a-durable-object-per-mailbox.md)
(Proposed). Surveyed on `develop` at `520e1fd48`. It builds on ADR
[DATA-015](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/DATA-015-stay-on-neon-durable-objects-later.md)
(Proposed), which already evaluated D1 and Durable Objects for tenant data and
named "one object per mailbox" as the target layout for mail. This plan works
out that target for WeldMail and puts the cheaper fixes in front of it.

## Owner answers (2026-10-28)

1. **Always-on or longer-suspend compute for paying workspaces now: no.** Tenant
   computes keep suspending after five idle minutes. Phase 2 no longer touches
   compute; the mailbox object is what takes mail off the wake-up.
2. **No latency target.** Phase 0 still measures, to compare before and after
   each phase, not to pass a bar.
3. **The phase 2 tenant migration is approved** (`thread_key`, its indexes,
   `body_key`, `search_text`). Generate it with `db:generate` when phase 2 is
   built.
4. **Commit to the mailbox Durable Object now.** There is no decision gate
   between phase 2 and phase 3; ADR MAIL-009 records the decision.
5. **Consumer WeldMail (personal-api, personal DB) is out of scope for now.**

The question: move mailbox storage off the per-workspace Neon databases into
Cloudflare D1 or Durable Objects, to take load off Postgres and make opening
WeldMail fast after a quiet period.

## Short answer

- **D1: no.** A Worker reaches D1 only through a binding declared in
  `wrangler.toml`, so there is no D1 database per workspace or per mailbox
  created at runtime. One shared D1 for all mail would put every workspace's
  mail in one 10 GB database that runs one query at a time, and give up the
  per-workspace isolation of
  [DATA-001](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/DATA-001-database-per-workspace.md).
  DATA-015 rejected D1 for workspace data for these reasons; nothing has
  changed since 18 October.
- **Durable Objects: yes, as the destination.** One SQLite-backed object per
  mailbox, addressed by name at runtime, in the EU jurisdiction. Mail is the
  largest and fastest-growing tenant data, it is rarely joined with other
  modules, and all of it arrives through two code paths (the inbound worker and
  `@weldsuite/mail-domain`), which makes it the easiest module to move first.
- **Moving storage alone will not make the cold open fast.** Before the mail
  list renders, the platform waits on app-api calls that read the tenant DB
  (permissions, installed apps, user preferences), and mail-api itself reads
  `workspace_members` to resolve permissions on every request. While those stay
  on Neon, the first open still waits for the compute to wake. The largest costs
  found below also have nothing to do with the database engine: the thread list
  sends every message body of every thread on the page, list queries group over
  the whole mailbox, and the persisted query cache deletes itself when mail
  makes it too big.
- **Order:** measure (phase 0), fix the open path on the current stack
  (phases 1 and 2), then build the mailbox Durable Object (phases 3 to 6).
  Phases 1 and 2 are DATA-015's "no-regret steps" for mail; they help while the
  object is built and carry over to it.

## What happens today when someone opens WeldMail

### In the browser

On a cold load (no persisted cache), about five stages run one after another
before the thread-list request leaves the browser:

1. clerk-js loads and gets a token. The app shell renders nothing until then
   (`apps/web/platform/components/app-shell-client.tsx:239`), and the persisted
   query cache is restored only after Clerk knows the org
   (`providers/query-provider.tsx:82-108`).
2. The mail layout shows a page loader until `useAppAccess('weldmail')`
   resolves (`app/weldmail/layout.tsx:13`). That is `/dashboard/installed-apps`
   plus user apps and custom objects, and the last two wait for
   `/me/permissions` (`hooks/use-installed-apps.ts:72-184`). All app-api, all
   tenant DB.
3. `/weldmail` shows a loader until both `/mail-accounts` (mail-api) and
   `/user-preferences` (app-api) return (`app/weldmail/page.tsx:9`), then
   redirects in a `useEffect` (`components/mail-redirect.tsx:8`).
4. The redirect downloads the `$accountId` / `$labelSlug` route chunks; hover
   only preloads `/weldmail`.
5. Threads, labels, per-account stats and sending usage fire together
   (`[accountId]/[labelSlug]/layout.tsx:86`, `hooks/use-mail-sidebar-items.tsx`).

The sidebar also fetches the accounts a second time as a plain promise, outside
React Query and the persisted cache (`use-mail-sidebar-items.tsx:306-321`).

Mail requests go straight to `mail-api.weldsuite.org`, a second origin, so they
need their own TLS connection and a CORS preflight per URL (the `Authorization`
and `X-Weld-App` headers force one).

### In mail-api

Every request: networkless Clerk JWT check, a KV read for the tenant URL
(`wsx:<org>`, 300 s TTL; on a miss one master DB query), then per-route
`requirePermission`, which runs 1 to 3 tenant queries
(`packages/core/permissions/src/server/resolver.ts:48-105`). Tenant queries go
over the Neon HTTP driver, one HTTPS round trip each, with no batching.

| Endpoint | Sequential tenant round trips | Notes |
|---|---|---|
| `GET /api/mail-labels/threads` | about 9 (owner) to 11 | Permissions; account row; `isAdminOrOwner` repeats the member lookup; an `UPDATE` that wakes snoozed mail on every list read; `COUNT(DISTINCT …)`; a `GROUP BY` over every live message of the account (no index covers `COALESCE(thread_id, id)`); `SELECT *` of every message in the page's threads; a second `UPDATE` for expired scheduled mail; contact enrichment. `packages/domains/mail/src/threads.ts:327-433` |
| `GET /api/mail-messages/stats` | 4 to 6 | 11 `count(*) FILTER` aggregates over all of the account's messages. `messages.ts:438-478` |
| `GET /api/mail-accounts` | 3 to 5 | |
| `GET /api/mail-sending/usage` | KV + Durable Object | |

The thread list returns `ThreadSummary.messages`: full `mail_messages` rows
including `text_body`, `html_body`, `headers` and `custom_fields`
(`threads.ts:243`). At 25 threads per page that is often hundreds of kilobytes
to megabytes for a list view. The web client then persists it to localStorage.

### In Neon

- Workspaces live on shared shards (0.25 to 2 CU) or dedicated projects (0.25
  to 0.5 CU) in `aws-eu-central-1`
  (`packages/core/neon-provisioning/src/provisioning.ts`).
- No suspend timeout is set, so computes suspend after Neon's default of five
  minutes idle. Nothing keeps them warm, on purpose
  ([DATA-008](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/DATA-008-never-wake-tenant-databases.md)).
- The KV entry for the tenant URL also expires after 300 s, so a user who comes
  back after ten minutes pays for a suspended compute **and** a master lookup.

## Where the time goes, ranked

These are estimates from reading the code. Phase 0 replaces them with numbers.

1. **Neon compute wake-up.** Hundreds of milliseconds to seconds on the first
   query after five idle minutes, then the heavy mailbox aggregates run against
   a cold buffer cache.
2. **Sequential round trips.** About 10 per thread-list request, each an HTTPS
   call from the user's Cloudflare colo to Frankfurt, plus permission lookups
   repeated on every request.
3. **The client waterfall.** Five gated stages before the list is requested.
4. **Thread-list payload.** Every body of every message in 25 threads, read
   from Postgres, serialised twice and downloaded.
5. **The persisted cache deletes itself.** When the workspace's cache entry no
   longer fits in localStorage, `workspaceCacheStorage` removes the whole entry
   for that workspace (`lib/persisted-query-cache.ts:136-152`). Mail bodies are
   the likely cause, and every reload after that is a full cold start for the
   whole platform, not just mail.
6. **KV miss = master query**, with no coalescing across the parallel requests
   of one page load.
7. Route chunk download after the redirect; non-English locale chunk before the
   first render.

A Durable Object fixes 1 and most of 2 for the mail requests themselves. It
does nothing for 3, 4, 5 or 7, or for the shell's own tenant DB calls.

## Why a Durable Object per mailbox, and not D1

| | D1 | SQLite Durable Object |
|---|---|---|
| One store per workspace or mailbox | No: bindings are static, the REST API is slow and rate limited | Yes: `idFromName()` at runtime, unlimited objects |
| Cold start | None (always on) | Milliseconds |
| Query latency | Network hop to the database | In-process, synchronous SQL |
| Size | 10 GB per database | 10 GB per object |
| Concurrency | One query at a time per database | One request at a time per object |
| Transactions | Batches only | `transactionSync` |
| Full-text search | FTS5 | FTS5 |
| Data residency | Location hint | `jurisdiction('eu')` |
| Backups | Time Travel | Point-in-time recovery, 30 days |
| Price | $0.75 per GB-month | $0.20 per GB-month; 25 billion rows read and 50 million rows written per month included, then $0.001 per million reads and $1.00 per million writes |

Per mailbox (rather than per workspace) because:

- one busy shared inbox does not queue behind the rest of the workspace;
- the 10 GB cap applies per mailbox, not per workspace;
- mailbox access is already decided per mailbox
  ([MAIL-003](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/MAIL-003-mailbox-access-by-assignment.md)),
  so an object never holds mail the caller can only partly see.

The price is fan-out for views that span mailboxes (the unified inbox, the CRM
Emails tab). See "Reads that span mailboxes".

## Plan

### Phase 0: measure (2 to 3 days)

1. **Server timing in worker-kit.** Time each phase (KV, master lookup,
   permissions, each tenant query, total) and send it as a `Server-Timing`
   header and in one structured log line per request. Workers Logs already keep
   the total duration (`head_sampling_rate = 1` on mail-api); this adds the
   breakdown. Flag requests whose first tenant query takes over 300 ms as a
   probable compute wake-up.
2. **Client marks.** `performance.mark` at route start, accounts resolved,
   first thread-list paint. Send them with the existing Mixpanel page view.
3. **Test runs on the test environment.** Cold (more than five minutes idle,
   KV entry expired) and warm. Owner and member. One and five mailboxes. A
   seeded mailbox with 1,000 and one with 50,000 messages. Record the thread
   list's response size.
4. Read the live suspend timeout and CU limits per shard from the admin
   console (`apps/workers/workspace-worker/src/services/database-live.ts`).

Output: p50/p95 per phase for cold and warm opens, kept in this file as the
baseline that each later phase is compared against.

#### As built (2026-10-28)

Items 1 and 2 are code; items 3 and 4 are runs to do on the test environment
after it deploys.

- **Server timing** (`packages/core/worker-kit/src/timing.ts`). Every worker on
  `createModuleApi` (app-api and every module worker) sends `Server-Timing`:
  `kv` (with `hit`/`miss`), `master`, `perm`, `db` (sum and count of tenant
  queries; a `db.batch()` counts as one), `db-first` and `total`. First-party
  origins get `Timing-Allow-Origin`, so the platform can read the values back.
  A request that reached a workspace also logs one line,
  `message: "request timing"`, with `service`, `route` (the route pattern, no
  ids), `status`, `workspaceId`, the same numbers in ms, and
  `coldStart: true` when the first tenant query took 300 ms or more.
  Tenant queries are timed by wrapping the Neon client's `execute` on each
  request's fresh client; a test runs the real driver against a fake HTTP
  endpoint, so a driver upgrade that changes this fails CI.
- **Client timing** (`apps/web/platform/app/weldmail/lib/open-timing.ts`). The
  `/weldmail` route starts an open when the router enters it (from the page's
  time origin on a page load). Both inbox layouts report the thread list. One
  Mixpanel event, `Mail Open Timing`, per open: `kind` (`page-load` or
  `navigation`), `outcome`, `totalMs` (to the first list fetched from the
  server), `gateMs` (access check passed), `firstListMs`, `listFromCache`,
  `wasHidden`, and `requests`: every `/api/` call made during the open with
  host, path (ids replaced by `:id`), start, duration, bytes and its
  `Server-Timing` values. DevTools shows `weldmail: open`,
  `weldmail: access check` and `weldmail: first list` in the Performance panel.
  An open the user leaves, or that takes over a minute, sends nothing.
  This replaces the "accounts resolved" mark: the per-request list shows when
  `/mail-accounts` returned.
- **Bulk mailbox seed** (`POST /test-fixtures/seed/mail-messages-bulk` on
  app-api, test and development only, `X-Test-Token` and
  `X-Test-Workspace-Id` as for the other fixtures). Body: `count` (up to 5,000
  per call), optional `accountId` (an existing mailbox; without it a new test
  mailbox), `threadSize` (3), `bodyBytes` (4,000), `unreadRatio` (0.2),
  `spreadDays` (365), `labels` (`["INBOX"]`). Ten calls fill a 50,000-message
  mailbox. `POST /test-fixtures/reset` removes the rows again.

#### How to run the baseline (items 3 and 4)

1. Deploy to test (merge to `develop`).
2. In the QA workspace, seed one mailbox with 1,000 messages and another with
   50,000, and give a second (member) user access to both.
3. For each case (owner and member; the 1,000 and the 50,000 mailbox; one
   mailbox and the unified inbox of five):
   - **Cold:** no tab on the workspace for at least 10 minutes (compute
     suspended, KV entry expired), then reload the platform on `/weldmail`.
     Repeat five times.
   - **Warm:** reopen within a minute, both as a reload and by switching
     module from the rail. Repeat five times.
4. Read the results:
   - Mixpanel: `Mail Open Timing`, broken down by `kind` and `listFromCache`,
     p50/p95 of `totalMs`, `gateMs` and `firstListMs`; the `requests` list of
     a few single events for the waterfall.
   - Workers Logs, `message = "request timing"`, by `service` and `route`:
     p50/p95 of `totalMs`, `dbMs`, `dbFirstMs`, `dbQueries`, the share of
     `workspaceCache = "miss"` and of `coldStart = true`.
   - The thread list's `bytes` per mailbox size.
5. Item 4: in the admin console's database pages, note the live suspend timeout
   and CU limits of the QA workspace's shard.
6. Put the numbers in a table here, then run the same table again after each
   phase.

### Phase 1: fix the open path on the current stack (1 to 2 weeks, no migration)

Server (`packages/domains/mail`, `apps/workers/mail-api`, `packages/core/permissions`):

1. **Lean thread list.** Return per message only what the list uses: id,
   `from`, `to`, `preview`, `isRead`, `isImportant`, `snoozedUntil`,
   `sizeBytes`, labels. Drop `textBody`, `htmlBody`, `rawMessage`, `headers`
   and `customFields`, and select only those columns in `threads.ts:401`. The
   reading pane already loads the thread on its own (`useMailThread` in
   `app/weldmail/components/mail-message-view.tsx:116`). The list's client-side
   text filter searches `textBody` (`message-list.tsx:329-336`); move that part
   to the server search the endpoint already supports. External-api and MCP use
   `getThreadByKey`, not this function, so their responses do not change.
2. **No write on read.** Take `wakeDueSnoozedMessages` and
   `resolveExpiredScheduled` out of the list path. The snooze sweep already
   runs every five minutes from the D1 due index; if that is too coarse, run
   them in `waitUntil` after the response.
3. **Batch the queries.** Drizzle's Neon HTTP driver supports `db.batch([...])`,
   which sends several statements in one HTTPS round trip (and one
   transaction); worker-kit already wraps it in `atomically.ts`. Put the count,
   the page query and the account lookup in one batch, and the 11 stats
   aggregates in one statement.
4. **Cache permission resolution** (a DATA-015 no-regret step). Cache the
   resolved permission set per (workspace, user) in KV with a short TTL plus a
   per-workspace version key that member, role and team changes bump. Stop
   `isAdminOrOwner` from repeating `getMember` within a request. This helps
   every module worker, not only mail.
5. **Coalesce the tenant URL lookup.** Keep resolved workspace contexts in an
   isolate-level map for a few seconds, so the parallel requests of one page
   load share one KV read or master query.

Client (`apps/web/platform`):

6. **Don't persist bodies.** Mark thread and message detail queries
   `meta: { persist: false }`. With item 1 the list is small enough to persist,
   and the workspace cache stops deleting itself. Also make the cache-too-big
   path log once, so it can be seen in the field.
7. **Start mail requests in parallel with the gates.** In the `/weldmail`
   route's `beforeLoad`, resolve the last-opened account from the persisted
   cache and redirect there directly, instead of waiting for accounts and
   preferences and redirecting in an effect. Have the label route call
   `queryClient.prefetchQuery` for threads, labels and stats, without awaiting
   them, so they fly while `useAppAccess` resolves.
8. **Prefetch on hover.** The rail hover already warms `mailKeys.accounts()`
   (`hooks/use-app-prefetch.ts:69`); also warm the last account's first thread
   page and labels, and preload its route chunks.
9. **One accounts query.** Replace the sidebar's raw `mailAccounts.list()`
   promise with `useMailAccounts()`.

Expected effect: warm opens paint from the persisted cache immediately and stay
warm across reloads; cold opens lose most of the waterfall and payload. The
compute wake-up remains, and so do 3 to 5 round trips per request.

### Phase 2: indexes and bodies (tenant migration, approved 2026-10-28)

1. **Thread key column and indexes.** Add `thread_key` as a stored generated
   column, `COALESCE(thread_id, id)`, with indexes on
   `(account_id, thread_key)` and `(account_id, sent_date DESC)`. The thread
   page query can then use an index instead of grouping the whole mailbox.
   This is interim: it serves the Postgres reads until phase 5, and the column
   goes when the mail tables do.
2. **Bodies and raw MIME to R2** (a DATA-015 no-regret step).
   - Write `html` and `text` to R2 under
     `mail/<workspaceId>/<accountId>/<messageId>/` and keep a `body_key` column.
     `GET /mail-messages/:id` and the thread endpoint read from R2.
   - Store the raw MIME there too. Today `raw_message` is always NULL for
     Cloudflare-routed mail: the adapter keeps it only when it is a string
     (`apps/workers/mail-inbound-worker/src/lib/cf-email-adapter.ts:68`), and the
     receive provider always passes an `ArrayBuffer`. Forward-as-attachment
     rebuilds the message instead, and the subscriptions scan finds nothing.
   - Keep a capped `search_text` column (first 32 KB of text) so the current
     `ILIKE` search keeps working until full-text search replaces it.
   - A backfill moves existing bodies one workspace at a time, triggered by an
     admin action or on first open, never by a timer (DATA-008). After it, null
     the old columns; dropping them is a later migration.
   - Bodies are the bulk of `mail_messages`, so this is also the largest
     reduction in Postgres storage, I/O and database-move time
     ([DATA-016](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/DATA-016-placement-by-need-paid-shards.md)).
   - The R2 layout is the one the mailbox object uses, so phase 4 reuses these
     keys and does not move bodies again.

Compute stays as it is: the owner declined always-on or longer-suspend compute
for now (answer 1). With the persisted cache fixed in phase 1, a returning user
sees cached mail at once and only the background refresh waits for the
compute; the first open after the cache expires (24 h) still waits until
phase 5.

### Decision record

ADR **MAIL-009** (Proposed, 2026-10-28): mailbox contents live in one SQLite
Durable Object per mailbox, bodies in R2. It refines DATA-015 by pulling mail
ahead of the other modules, and it is an explicit exception to
[DATA-005](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/DATA-005-one-shared-schema-package.md)
("every module shares the one tenant database", Accepted). It flips to
Accepted when phase 5 is on for every workspace.

### Phase 3: one storage interface for mail (no behaviour change)

1. Add a `MailboxStore` interface in `@weldsuite/mail-domain`: list threads,
   get thread, get message, ingest inbound, store a sent copy, set flags and
   labels, search, stats, drafts, attachments metadata. The first
   implementation wraps today's Postgres code. This is DATA-015's
   `tenantStore.forWorkspace(id)` idea, scoped to mail.
2. Route every mail read and write through it: mail-api, mail-inbound-worker,
   external-api, mcp-server, the scheduled-send Workflow, the delivery-events
   consumer.
3. Replace direct mail-table access in other workers with mail-domain calls:
   - crm-api `GET /api/people/recent-correspondents` (`packages/domains/crm/src/people.ts:1416`);
   - app-api sidebar badge (`routes/dashboard/index.ts:147`) and the Drive
     attachment aggregation (`services/drive-aggregation.ts:341-578`);
   - the generic workflow entity CRUD for `mail_message` and `mail_folder` in
     workflow-worker and crm-api (`entity-tables.ts`): drop those entities, or
     map them to store calls;
   - `apps/tools/outbound-audit`.

After this phase nothing outside mail-domain knows where mail is stored.

### Phase 4: the mailbox Durable Object in shadow (dual write)

**Class and addressing**

- `MailboxStore` Durable Object, hosted in mail-api next to `OutboundLedger`,
  with a `new_sqlite_classes` migration.
- Always through `env.MAILBOX_STORE.jurisdiction('eu')`, so data stays in the
  EU from the first object. Changing this later means copying every object.
- Name `mbx:<workspaces.id>:<accountId>`, keyed by `ws_…` from the start
  ([SEC-011](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/SEC-011-workspaces-id-is-the-workspace-identifier.md)).
  The `mbx:<owner>:` prefix leaves room for consumer WeldMail
  (`mbx:personal:<personalAccountId>:<accountId>`) if it ever moves.
- Bound by `script_name` in mail-inbound-worker, external-api, mcp-server,
  app-api and crm-api, the same pattern as `OutboundLedger`.

**SQLite schema inside the object** (Drizzle `sqlite-core` with
`drizzle-orm/durable-sqlite`, already available in the installed
`drizzle-orm@0.45.2`; a schema version table, migrations applied in the
constructor under `blockConcurrencyWhile`, so deploys never fan out to
objects):

| Table | Purpose |
|---|---|
| `messages` | Metadata, `preview`, flags, `thread_key`, dates, `source`, delivery status, `body_key` (R2), attachment count. No bodies. |
| `message_labels` | `(label, message_id)`. Replaces the JSONB `labels` array and its GIN index. |
| `threads` | One row per thread, kept on write: latest date, subject, snippet, participants, message count, unread count, starred, has attachments. |
| `thread_labels` | `(label, latest_at DESC, thread_key)`. An inbox page is one indexed range scan. |
| `label_counts` | `(label, total, unread)`, updated in the same `transactionSync` as the message. Stats and sidebar counts become a read of a few rows. |
| `attachments` | Metadata; bytes stay in R2. |
| `messages_fts` | FTS5, contentless (body text indexed, not stored twice): subject, from, to, preview, first 32 KB of body. |
| `subscriptions` | `List-Unsubscribe` senders, today upserted into Postgres on every inbound message. |
| `outbox` | Entity events written in the same transaction, published after commit and retried from an alarm (the [EVT-013](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/EVT-013-transactional-outbox.md) pattern). |
| `meta` | Schema version, backfill watermark, `databaseSize` checks. |

**Writes**

- The inbound worker and mail-domain keep writing Postgres as today and also
  call the object (`ingest`, `storeSent`, `applyLabels`, `setFlags`).
  Idempotent on message id, so retries and the backfill can overlap.
- Backfill per mailbox: page through Postgres oldest to newest, store a
  watermark, resume after eviction. It is triggered when a mailbox is first
  opened with the flag on, or by an admin action. Never by a timer.

**Parity checking**

- With the flag at `shadow`, mail-api answers from Postgres and, for a sample
  of requests, also asks the object in `waitUntil` and logs differences in
  counts and first-page thread ids.

**Tests**

- No test fake supports `ctx.storage.sql` today. Either write a `node:sqlite`
  adapter alongside the in-memory D1 in
  `packages/core/worker-kit/src/testing/d1.ts`, or run this package on
  `@cloudflare/vitest-pool-workers`, which supports SQLite objects and eviction
  (`evictDurableObject`). The adapter keeps the existing vitest setup and is
  enough for the SQL logic; use the pool for a few eviction and alarm tests.

### Phase 5: read from the object (per-workspace flag)

- Flagship flag `weldmail-mailbox-store`: `postgres` (default), `shadow`,
  `object`. Turn it on for the WeldSuite workspace first, then QA, then
  everyone.
- List, thread, stats, labels counts and search read from the object; bodies
  from R2.
- **No Neon on the mail open path.** Together with the phase 1 permission
  cache, add a cached mailbox directory per workspace in KV (accounts and
  `assignedUserIds`, invalidated on account changes), so mailbox access is
  decided without a tenant query. A cold open with a warm KV then touches no
  Postgres for mail. The platform shell's own app-api calls (permissions,
  installed apps, preferences) still read the tenant DB and still wait for the
  compute. The mail page should not wait on them: render the mail shell and
  its data as soon as the persisted `useAppAccess` result or the mail requests
  allow, and let the licence check correct the page if access was revoked.
  Moving those shell reads off Neon is DATA-015's per-workspace object, not
  this plan.

### Phase 6: the object becomes the system of record

- Stop writing `mail_messages` and `mail_attachments` in Postgres. Keep the
  tables read-only for a grace period, then drop them (migration, approval).
- **Snooze** moves to a Durable Object alarm per mailbox; the `mail_snooze` kind
  leaves the D1 due index.
- **Scheduled send** keeps its Workflow; the Workflow reads and writes through
  the store.
- **`mail_correspondents`** moves into the per-workspace `OutboundLedger`
  object, which every send already calls. Inbound ingest records the sender
  there, and the Postgres trigger from tenant migration 0214 goes away.
- **Workspace deletion and data export** go through the store: list the
  workspace's mailboxes (from `mail_accounts` and the master registry), call
  `destroy()` on each (`deleteAll()` plus the R2 prefix), and export through the
  same interface. Dropping the tenant database no longer deletes mail by itself,
  so this has to be in place before phase 6 starts.
- The database move tool (DATA-016) no longer copies mail.

## As built: phases 1–6 (2026-10-28)

Everything below ships in one PR with the Flagship flag `weldmail-mailbox-store`
at `postgres` for every workspace, so merging changes no behaviour until a
workspace is switched. The implementation design, with the binding decisions
on top, is [weldmail-mailbox-store-design.md](weldmail-mailbox-store-design.md).

### Where things live

| Piece | Code |
|---|---|
| Phase 1 server (lean thread list, batching, stats) | `packages/domains/mail/src/{threads,messages,db-batch}.ts` |
| Permission cache, workspace lookup sharing | `packages/core/worker-kit/src/{permission-cache,db}.ts`, `packages/core/db/src/lib/permissions-cache.ts` |
| Phase 1 client | `apps/web/platform/app/weldmail/lib/{landing-redirect,label-route-prefetch,mail-gate}.ts`, `hooks/use-app-prefetch.ts`, `lib/persisted-query-cache.ts` |
| Indexes (tenant migration 0233) | `packages/core/db/src/schema/mail-messages.ts` |
| Store contracts and shared rules | `packages/domains/mail/src/store/{types,model,cursor,merge,fts-query,thread-summary,thread-match,bodies}.ts` |
| Postgres store | `packages/domains/mail/src/store/postgres/` |
| Mailbox object (SQLite, EU) | `packages/domains/mail/src/mailbox-object/` (schema, writes, reads, alarm, outbox, destroy, backfill, parity, reverse sync); hosted by mail-api as `MailboxStoreObject` |
| Mail index object (EU) | `packages/domains/mail/src/mail-index/` (`MailIndex`: correspondents, address index) |
| Client, fan-out, router, access, directory | `packages/domains/mail/src/store/{object/*,router,access,directory,parity,mode,index}.ts` (`getWorkspaceMail`) |
| Cross-store contract suite | `packages/domains/mail/src/store/contract.test.ts` |
| Staff routes | mail-api `/internal/mail-store/*` (`OUTBOUND_ADMIN_SECRET`) |

### Where it differs from the phases above

- **Phase 2 shrank.** Bodies and raw MIME live at fixed R2 keys
  (`mail/<workspaceId>/<accountId>/<messageId>/{body.html,body.txt,raw.eml}`),
  so the `body_key` and `search_text` columns were not needed. The approved
  tenant migration is two indexes on `mail_messages`.
- **A new EU bucket** (owner, 2026-10-28): bodies and raw MIME go to
  `weldsuite-mail` / `weldsuite-mail-test` (`jurisdiction = "eu"`, binding
  `MAIL_STORAGE`), not to `weldsuite-storage`, which is not EU-pinned.
  Attachments stay in `weldsuite-storage` for now.
- **The mail index is its own EU object** (`MailIndex`, `mbxidx:<ws>`), not
  tables in the OutboundLedger, which is not in the EU jurisdiction.
- **Search** in the object: trigram FTS over subject and addresses (substring
  matches like today) and token-prefix FTS over the first 8 KB of body text.
- **Raw MIME** was never stored for Cloudflare-routed mail; it is now written
  to the EU bucket for every inbound message, in every mode.

### Rollout runbook

Before the PR deploys (ops, once per environment):

1. Create the EU buckets: `wrangler r2 bucket create weldsuite-mail-test
   --jurisdiction eu` and `weldsuite-mail` for production. Every mail worker
   binds `MAIL_STORAGE` to them; the deploy fails if they don't exist.
2. Create the Flagship flag `weldmail-mailbox-store` (string, default
   `postgres`) in the test and production Flagship apps.
3. Deploy mail-api before the workers that bind its Durable Objects by
   `script_name` (migration tag `mailbox-v1` adds `MailboxStoreObject` and
   `MailIndex`).

Per workspace (start with WeldSuite's own, then QA, then customers):

1. **`shadow`.** Writes go to both stores; reads stay on Postgres. The first
   use of each mailbox starts its backfill (or start it with
   `POST /internal/mail-store/backfill`). Watch
   `GET /internal/mail-store/status/all?workspaceId=` until every mailbox is
   `ready`, and the parity sampler's log lines.
2. **Full parity.** `POST /internal/mail-store/parity` per mailbox (with
   `repair: true` to fix Postgres-side differences). Expect only the
   normalised differences (see the design's Decisions block).
3. **`object`.** Reads come from the objects, writes still go to both.
   Measure with the phase 0 timing; compare with the baseline.
4. **`object-only`**, only once every mailbox is ready. Postgres stops
   receiving mail for that workspace.

Rolling back from `object` or `object-only`: switch the flag to `shadow`
first, then run `POST /internal/mail-store/reverse-sync` per mailbox with
`since` = when the workspace left `shadow`, until it reports `done`. Only then
switch to `postgres`. The steps are also in
`packages/domains/mail/src/mailbox-object/reverse-sync.ts`.

### Known limits in this PR

- **Unified views and partial failures.** If one mailbox object fails, a
  cross-mailbox list (unified inbox, badge) returns the other mailboxes and
  logs the failure; the response does not tell the user a mailbox is missing.
- **Drive** lists at most 2,000 recent mail attachments in object modes
  (postgres mode is unchanged).
- **Test fixtures.** In `object-only`, `/test-fixtures/reset` cannot pick out
  seeded messages inside a reused (non-fixture) mailbox.
- **Moving an attachment** between two different mailboxes is not supported
  in object modes.
- **Search** in object modes matches substrings in subject and addresses but
  whole-word prefixes in body text ("voice" no longer finds "invoice" in a
  body).
- **Workflows.** Generic record actions on `mail_message` are refused in
  `object` and `object-only`; mail workflows must use the mail actions. Before
  switching a workspace, check whether any of its workflows use them.

### Later (not in this PR)

- The migration that drops the old mail tables and the 0214 correspondents
  trigger, once every workspace runs `object-only` (needs owner approval).
- Draining the object's `pg_drift` list back to Postgres automatically; today
  reverse sync and parity cover it.
- Consumer WeldMail (personal-api).

## Out of scope

- **Consumer WeldMail** (`apps/web/weldmail`, personal-api, the personal DB's
  `personal_mail_*` tables) stays on Postgres (owner answer 5). The store
  interface is written so it could move later, but no phase touches it.
- **Compute settings** for tenant databases (owner answer 1).
- Moving the platform shell's reads off Neon (DATA-015's per-workspace object).

## Reads that span mailboxes

| Reader | After the move |
|---|---|
| Unified inbox, unified stats | Parallel RPC to each mailbox the caller can read, merge the top pages by `latest_at`; the cursor holds one position per mailbox. Typical users have a handful of mailboxes. |
| Sidebar unread badge (app-api) | Sum of `label_counts` across the caller's mailboxes, or a per-user counter the objects push to on change. |
| CRM "Emails" tab, recent correspondents | A per-workspace address index (address → mailbox ids, last seen) kept in the `OutboundLedger` object next to the correspondents, so the tab asks only the mailboxes that have mail with that address, each with an indexed lookup. |
| Drive attachment list | Fan out to the caller's mailboxes, or keep a slim attachment registry in Postgres if Drive needs cross-source sorting and counts. Decide in phase 3. |
| External API and MCP lists without `accountId` | Same fan-out as the unified inbox, through mail-domain. |
| `/api/mailboxes` (across workspaces) | Unchanged: it lists accounts, not messages. |
| Workflow entity CRUD on mail entities | Removed or mapped to store calls (phase 3). |

## What stays in Postgres

Mailbox configuration that is small, rarely written and joined with members or
other modules: `mail_accounts`, `mail_domains`, label definitions, rules,
signatures, templates, campaigns, `mail_suppressions`; and in the master DB the
address registry and the outbound guard tables. Contacts created from mail stay
in `people` (CRM), written in batches from the entity-events queue rather than
inline in the inbound handler.

## Sizing and limits

- **10 GB per object.** Without bodies, a message's metadata and index rows
  should be a few kilobytes; the FTS index is likely the largest part. Measure
  on the largest real mailbox in phase 0. Report `ctx.storage.sql.databaseSize`
  on every write batch: warn at 6 GB, act at 8 GB (DATA-015), for example by
  dropping old messages from the FTS index or splitting by year.
- **One request at a time per object.** Queries take milliseconds in-process,
  so a shared inbox read by dozens of agents is fine. Inbound bursts to one
  mailbox are serialised, which is also what keeps the thread and count tables
  consistent.
- **Cost.** An inbound message writes roughly 15 to 30 rows (message, labels,
  thread, thread labels, counts, FTS, outbox). 100,000 messages a month in a
  workspace is about 3 million rows written, inside the 50 million included per
  month for the whole account until mail volume is far higher than today.
  Storage at $0.20 per GB-month is below Neon's $0.35.

## Risks

- **Two sources of truth during shadow.** Mitigated by idempotent writes, the
  parity checker, and the option to rebuild any object from Postgres until
  phase 6.
- **Fan-out for workspaces with many shared mailboxes.** The address index
  keeps the CRM tab targeted; the unified inbox fans out only over the
  caller's mailboxes.
- **Less ad-hoc SQL for support.** Cloudflare's Data Studio can open one
  object's SQLite in the dashboard; cross-workspace queries like the outbound
  audit need a tool that goes through the store.
- **EU residency of R2.** Check which jurisdiction the `weldsuite-storage`
  bucket was created in before bodies move there.
- **A new ADR against an Accepted one.** DATA-005 says every module shares one
  tenant database. MAIL-009 must say why mail is the exception.

## Bugs found while researching (independent of this plan)

- Raw MIME is never stored for Cloudflare-routed mail (see phase 2 item 2).
- The thread list returns full message bodies (phase 1 item 1).
- The persisted query cache deletes the whole workspace entry when it no longer
  fits (phase 1 item 6).
- The mail sidebar fetches accounts twice, once outside React Query (phase 1
  item 9).
- A thread-list read runs two `UPDATE`s (phase 1 item 2).

Found and fixed while building phases 1–6:

- **Scheduled mail could silently never be sent.** A thread-list read marked a
  scheduled message `sent` once its time had passed; the scheduled-send
  Workflow (which wakes at or after that time, and can defer up to 24 h on a
  sending limit) then skipped it as already handled.
- `GET /api/mail-accounts` returned stored credentials (tokens, API keys,
  password hashes, provider config); workflow generic CRUD on `mail_account`
  could read and write them. `mail_accounts` is now in `SENSITIVE_COLUMNS`,
  which also strips those key names from every entity event payload.
- `GET /api/mail-labels` and `/api/mail-snooze/snoozed` without `accountId`
  showed private mailboxes' labels, counts and snoozed mail.
- crm-api recent-correspondents read any mailbox without an access check.
- Drive listed mail attachments with their public storage URL.
- Workflow generic CRUD on mail entities ignored mailbox access; it is now
  limited to shared mailboxes.
- Deleting a label left differently-cased copies on messages.

## Docs to update

In `weldsuite-documentation`:

- Now: ADR MAIL-009 (Proposed), the WeldMail design doc's decisions table and a
  "Planned changes" section, and the data architecture doc's planned changes.
- As phases land: the WeldMail design doc's data model and flows (bodies in R2
  after phase 2; the mailbox object after phase 5), and MAIL-009 to Accepted.

## Key files

- `packages/domains/mail/src/threads.ts`, `messages.ts`, `labels.ts`, `send.ts`, `access.ts`
- `apps/workers/mail-inbound-worker/src/lib/email-storage.ts`, `cf-email-adapter.ts`
- `apps/workers/mail-api/src/index.ts`, `wrangler.toml`
- `packages/core/worker-kit/src/db.ts`, `middleware/workspace-db.ts`, `testing/d1.ts`
- `packages/core/permissions/src/server/resolver.ts`
- `packages/core/db/src/schema/mail-messages.ts`
- `packages/core/neon-provisioning/src/provisioning.ts`
- `apps/web/platform/app/weldmail/`, `hooks/queries/use-mail-queries.ts`, `lib/persisted-query-cache.ts`, `providers/query-provider.tsx`
