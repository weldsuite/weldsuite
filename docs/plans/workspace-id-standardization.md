# One workspace identifier: `workspaces.id` everywhere

Status: phase 1 in review. Phases 2–5 not started. Decision record:
[SEC-011](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/SEC-011-workspaces-id-is-the-workspace-identifier.md)
(Proposed), which replaces the identifier rule of SEC-001 ("the request
context carries the Clerk org id"). SEC-001's main decision stands: Clerk is
the identity provider, and one Clerk organization is one workspace.

Decided (2026-10-26):
- **`workspaces.id` is the workspace identifier.** Request context, events,
  queue messages, Workflow params, registries, D1 indexes, KV and R2 keys and
  API payloads carry it.
- **The Clerk org id stays at the Clerk edge.** It is read from the session
  token once and resolved to `workspaces.id`; it is used again only to call
  Clerk (memberships, invitations, seat caps, SSO) and in Clerk webhooks.
- **Rolled out in phases, compatibility first.** Readers learn both ids before
  any writer changes, so a deploy never strands a message, a sleeping Workflow
  or a stored row.

## Why

A workspace has two ids: ours, `workspaces.id` (`ws_…`), and Clerk's,
`workspaces.clerk_org_id` (`org_…`). `workspaceDbMiddleware` puts the **org
id** in `c.get('workspaceId')`, so most code, and everything it writes, is keyed
by Clerk's id. That ties stored data to the identity provider: moving off Clerk,
or re-linking a workspace to another org, would mean rewriting ids across
master, every tenant, D1, KV, R2, Durable Objects and third parties.

The two ids are also already mixed, and that loses data today:

- `c.get('workspaceId')` is the org id on the Clerk paths, external-api, MCP and
  the widget, but `workspaces.id` on the help center, the commerce portal and
  books' internal entrypoint. Entity events take that value. The search index,
  audit log, workflow and agent consumers resolved only org ids: the search
  index dropped `ws_` events silently, the others retried them into the DLQ,
  and realtime published them to a hub nobody listens on.
- desk-api wrote the org id into `widget_registry.workspace_id` and
  `mail_account_registry.workspace_id`, and books-api into the latter. Both
  columns reference `workspaces.id`: the writes failed (the widget one silently,
  inside a `try/catch`).
- Some early workspaces have `id` = their Clerk org id (the old auto-provision
  in `packages/core/db/src/lib/tenant.ts`), so a prefix check (`startsWith('org_')`)
  cannot tell the two apart.

## Rules for new code

- Name the id you mean: `workspaceId` for `workspaces.id`, `clerkOrgId` for
  Clerk's. Until phase 2, `c.get('workspaceId')` is still the org id on the
  Clerk paths; use `c.get('internalWorkspaceId')` for `workspaces.id` and
  `c.get('clerkOrgId')` for the org id.
- Store and send `workspaces.id`. A new table, registry, D1 index, KV key, R2
  prefix, event field or Workflow param takes `workspaces.id`.
- Look a workspace up with `matchWorkspaceRef(ref)`
  (`@weldsuite/db/lib/workspace-ref`) whenever the value may be either id: it
  matches `id` or `clerk_org_id`, which also covers the early rows. Look up by
  `clerk_org_id` alone only at the Clerk edge (session token, Clerk webhooks).
- Never infer which id a value is from its prefix.

## Phases

Each phase is one PR and is deployed everywhere before the next starts.
Workers deploy independently, queues redeliver, and Workflows sleep with their
params (TrashCleanup up to 30 days; CRM sequences, scheduled mail and
deferred notifications until their send time), so every reader must accept
both ids for as long as any of those can still carry the old one.

### Phase 1: readers accept both ids (this PR)

No writer changes what it stores, except where it was wrong.

- `matchWorkspaceRef` in `@weldsuite/db`. Every tenant resolver accepts either
  id: worker-kit (`getTenantDbForWorkspace`, `getWorkspaceContextForOrg`,
  `getWorkspaceForOrg`), the copies in audit-log, helpdesk-widget-api,
  helpdesk-workflow, realtime, workflow, workspace, integration-webhook and
  mail-inbound workers, `@weldsuite/db`'s `tenant.ts`, admin and discord-bot.
  So do `resolveInternalWorkspaceId` (credits), app-api's credit, billing,
  api-key, app-access, partner and seat lookups, mail-api's account and domain
  lookups, and the other lookups fed by context, events or params.
- The worker-kit cache entry is stored under the id it was asked by
  (`wsx:<org>` or `wsx:<ws>`) and carries both ids.
  `invalidateWorkspaceContexts` and `forgetWorkspaceContext` delete both.
- `workspaceDbMiddleware` also sets `internalWorkspaceId` (`workspaces.id`) and
  `clerkOrgId`; the test harness sets both.
- Realtime maps a `workspaces.id` to its org id before naming the hub
  (`workspaceHubKey`), for entity events and `/publish/workspace`.
- Analytics queries read rows under both ids (`workspace_id IN (…)`).
- Fixes: widget and helpdesk-email registry rows and the accounting inbox are
  keyed by `workspaces.id`; the commerce staff portal routes use
  `workspaces.id` like the public portal (slug, one-time codes, rate limits);
  bill and invoice attachments accept keys under either id (accounting-inbox
  mail is stored under `workspaces/<ws>/`); `provisionWorkspace` no longer
  creates rows with `id` = org id.

### Phase 2: the request context and writers switch

- `workspaceDbMiddleware` sets `workspaceId` to `workspaces.id`;
  `internalWorkspaceId` goes away. external-api, mcp-server, helpdesk-widget-api,
  the HR portal and the internal entrypoints set it the same way. The test
  harness defaults to a `ws_` id.
- Audit every `c.get('workspaceId')` read (≈265) and `c.get('orgId')` read
  (≈235). Clerk calls move to `c.get('clerkOrgId')`. Code that keys
  persisted state must keep finding the old keys:
  - **R2**: new objects go under `workspaces/<ws>/…`. Stored keys are kept in
    rows, so old objects stay readable; every prefix check uses
    `isWorkspaceObjectKey(key, workspaceId, clerkOrgId)` (mail send and
    scheduled send, HR receipts and payslips). The private-files cookie and
    its path scope must cover both prefixes.
  - **KV**: short-TTL keys (rate limits, caches, OTPs) just switch. Long-lived
    or TTL-less entries keyed or valued by the org id read both, or are
    rewritten: `webhook:<id>`, `gh-install:<id>`, `rtr:process:<id>`, BR
    fiscal hooks, W-9 tokens, the HR portal host map, `discord_guild:<id>`,
    `rtk-meeting:<id>`, the social post map, `books:active:<org>`.
  - **Durable Objects**: `WorkspaceHub`, `SupportRoom`, `hrportal:<org>`,
    `DocRoom` and `SheetRoom` (`<org>:<id>`), `desk:<org>` assignment router and
    the agent sandbox are named by the org id and hold state. Decide per
    object: keep the org-derived name (clients reach the hub through their
    token, not the name), or rename with a hand-over (a doc room must
    checkpoint before its name changes, or live edits split across two rooms).
  - **D1** `schedule_index`, `weldagent_routine_index`, `workspace_due_index`:
    a writer switching ids would leave a second row for the same workspace;
    backfill (phase 3) ships together with this switch.
- Entity events, queue messages and Workflow params carry `workspaces.id`.
  Every consumer already accepts both (phase 1).
- Feature-flag targeting: the Flagship `workspaceId` attribute becomes
  `workspaces.id`, after rewriting any rule that targets an org id.

### Phase 3: stored data moves to `workspaces.id`

Needs approved migrations (master) and one-off scripts (D1, tenants).

- Master registries keyed by `clerk_org_id`: add `workspace_id`, backfill from
  `workspaces`, switch readers, then drop `clerk_org_id`:
  `telnyx_porting_order_index`, `phone_number_registry`, `postpeer_post_index`,
  `bank_feed_connection_index`; and drop the duplicate `clerk_org_id` from
  `ad_sync_index`, `reach_routes`, `reach_warmup_mailboxes`,
  `sign_link_registry`, `workspace_sso` once their readers use `workspace_id`.
- `workflow_webhook_registry.workspace_id` holds org ids: rewrite to
  `workspaces.id`, and its KV values with it.
- D1: rewrite `workspace_id` in the three schedule-index tables from master
  (the schedule index already has a rebuild from master); drop the
  `clerk_org_id` columns from the integration-sync indexes.
- Tenant `workspace_id` columns (`weldpass_projects`, `weldpass_vaults`,
  `chat_drafts`, `github_*`, `task_import_jobs`, `sign_settings`) hold the org
  id. A tenant database belongs to one workspace, so these columns are
  redundant: stop filtering on them, then drop them, rather than rewriting
  every tenant. (WeldPass encryption does not bind the workspace id: its AAD
  is project/vault, so nothing needs re-sealing.)
- Analytics: the Iceberg table is append-only; readers keep matching both ids.

### Phase 4: clients and contracts

- Mobile push payloads add `workspaceId` next to `clerkOrgId` (the apps need
  the org id for Clerk's `setActive`). weldmail's `notification-target.ts`
  rejects anything but `org_…`; teach it the new field first.
- Platform and mobile local storage keyed by the org id (persisted query cache,
  command palette recents, realtime cursors, offline outboxes) can stay: the
  active Clerk org is what selects the workspace on the client. Switch only
  where a key reaches the server.
- **Customer webhooks**: the payload field `workspaceId` is the Clerk org id
  today, while external-api v1 returns `workspaces.id`. Changing it is a
  breaking change for customers; announce it, and send both for a deprecation
  window.
- `/api/workspaces` returns `id` = org id and `workspaceId` = `workspaces.id`;
  meeting-portal URLs and booking links use the org id. New links use
  `workspaces.id` or the slug.

### Phase 5: remove the fallback

Readers stop accepting the org id where nothing can carry it any more. What
must resolve forever keeps an org → workspace lookup at its edge: links already
sent in emails (`/w/org_…`, meet `<portal>/<orgId>/<joinCode>`), Stripe
metadata (`clerkOrgId` next to `workspaceId`; call-api's checkout claim still
compares the org id), Plaid `client_user_id` and Stripe Financial Connections
customers (stored on their side, re-read through our rows), Anthropic managed
agent metadata (changing it re-versions every agent), Telnyx call state
(minutes long).

## Not changing

- Clerk stays the identity provider, and one org is one workspace (SEC-001).
- Early workspaces keep `id` = org id. Re-keying a primary key referenced by
  foreign keys, bound into the AAD of `workspaces.database_url` and used in
  Neon names is not worth it; `matchWorkspaceRef` handles them.
- Neon project, database and role names already derive from `workspaces.id`.
