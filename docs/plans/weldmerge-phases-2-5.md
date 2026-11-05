# WeldMerge phases 2–5

Status: built in TypeScript and Rust on branch `claude/weldmerge-app-design-d2f5eb` (PR weldsuite/weldsuite#1477, with phase 1). The design doc `design/modules/weldmerge.md` and ADRs MERGE-004..006 describe what shipped; this plan records how it was split up.
Design doc: `design/modules/weldmerge.md` in weldsuite-documentation (ADRs MERGE-001..003).

All five phases ship in one PR. Phase 1 (teams, issues, GitHub pull request
mirror, links, automations, derived inbox) is done. This plan is the brief for
the rest: what each phase adds, the data and API it needs, and which build
area owns which files.

## Decisions (from the owner, 2026-11-05)

- **Both backends.** Every new `/api/merge` route is built in TypeScript
  (`apps/workers/merge-api`) and Rust (`rust/modules/merge`), and its tests join
  the `merge` conformance suite. Code outside merge that is Rust-ported
  (connect, integrations, flow, core-files search, chat, know, mail) changes in
  both backends too.
- **Migrations approved**: tenant migrations for the tables below, and one
  master migration (the provider index).
- **WeldFlow and WeldConnect move off `github_connections`** onto
  `merge_connections`, and the GitHub App install flow moves into merge-api
  (MERGE-002). `github_connections` stays in the schema, unread, for a later
  drop.
- **GitLab.com, Bitbucket Cloud and Azure DevOps connect with OAuth apps.**
  Self-managed GitLab connects with an access token. Members link their own
  account with the same OAuth apps (self-managed GitLab: a personal token) to
  review and merge as themselves. GitHub members link through the GitHub App's
  user authorization (user-to-server OAuth).
- **No mobile app** in this PR.

## Rules every area follows

- Tenant scoping: tenant tables have no workspace column; the kit's
  `apiAuth()` resolves the tenant DB. New master rows store `workspaces.id`
  (`ws_…`, ADR SEC-011), never the Clerk org id.
- Every mutation route publishes an entity event (`publishEntityEvent`),
  except per-member UI state (inbox states, provider account links), which is
  listed as exempt in merge-api's event coverage test.
- Zod v3 only. Shared schemas in `@weldsuite/app-api-client/schemas/weldmerge*`.
- Every new user-visible string in en **and** nl.
- No secret or token ever leaves the backend: credentials columns are
  encrypted with the `DATABASE_ENCRYPTION_KEY` keyring (`encryptField` /
  `decryptField`, `keyringFromEnv`; Rust `weldsuite_db::{Keyring, encrypt_field,
  decrypt_field}`) and never returned. Entity events carry no credentials
  (EVT-005).
- Provider HTTP in tests is stubbed **by URL and method, never by call order**
  (see `apps/workers/merge-api/src/test/helpers.ts`), so the Rust backend can
  answer the same tests in conformance mode. Every outbound call is compared.
- No timers that open tenant DBs (DATA-008). Daily digests use
  `@weldsuite/worker-kit/due-index` (`markWorkspaceDue`, kind `merge_digest`).
- Generic UI comes from `@weldsuite/ui`; module folders keep only WeldMerge's
  own widgets.
- SonarJS new-code check (`node scripts/lint-sonar-new.mjs origin/develop`)
  must report 0 findings for the files you touch: no nested ternaries,
  functions under cognitive complexity 15, no nested template literals.

## Data model additions

All in `packages/core/db/src/schema/weldmerge.ts` unless noted.

| Change | Columns |
|---|---|
| `merge_connections` + | `webhook_secret` (text, encrypted; GitHub's per-installation fallback secret, carried over from `github_connections`), `app_slug`, `scopes` jsonb, `installed_at`, `revoked_at`, `oauth_user_login` (who authorized an OAuth connection). `credentials` (encrypted JSON `{accessToken, refreshToken?, expiresAt?, tokenType?}`) is now used for GitLab, Bitbucket and Azure DevOps. |
| `merge_repositories` + | `external_project` (Bitbucket workspace slug, Azure DevOps project name, GitLab namespace path), `webhook_id` (provider's hook/subscription id), `webhook_key` (varchar 64, random, unique among non-null: the routing key in the webhook URL), `webhook_secret` (text, encrypted). `issue_sync` now honours `two_way` and `import` for GitHub and GitLab. |
| `merge_provider_accounts` + | `host` (self-managed GitLab base URL, Azure DevOps org URL; null for cloud), `credentials` (encrypted member token JSON), `credentials_expire_at`, `verified_at` (set when linked through OAuth; null = typed login), `avatar_url`, `display_name`. Unique indexes become `(provider, coalesce(host,''), login)` and `(user_id, provider, coalesce(host,''))`. |
| `merge_comments` + | `external_id`, `external_author_login`, `external_author_avatar_url`, `source` (`weldmerge` default, `provider`). `author_user_id` becomes nullable (a provider comment from someone who isn't a member). |
| `merge_issues` + | `agent_id` (varchar 30, a WeldAgent agent the issue is assigned to). |
| `merge_issue_pull_requests` + | `dismissed_at` (a removed automatic link stays removed: sync skips dismissed pairs). |
| `merge_external_issues` (`mxi_`) new | `issue_id` (unique), `repository_id`, `provider`, `external_id`, `number`, `url`, `state` (`open`/`closed`), `checksum` (sha-256 of the synced fields), `last_writer` (`weldmerge`/`provider`), `provider_updated_at`, `synced_at`, timestamps. Unique `(repository_id, number)`. |
| `merge_inbox_states` (`mib_`) new | `user_id`, `item_key` (varchar 200, the inbox item's id), `read_at`, `snoozed_until`, `archived_at`, timestamps. Unique `(user_id, item_key)`. |
| `merge_releases` (`mrl_`) new | `team_id`, `repository_id`, `name`, `version`, `base_ref`, `head_ref`, `status` (`draft`/`shipped`), `notes` (Markdown), `notes_generated_at`, `knowledge_page_id`, `shipped_at`, `created_by_user_id`, timestamps, `deleted_at`. |
| `merge_release_pull_requests` (`mrr_`) new | `release_id`, `pull_request_id`, `created_at`. Unique pair. |
| `merge_record_links` (`mrk_`) new | `issue_id`, `record_type` (`desk_ticket`, `crm_company`, `chat_channel`), `record_id`, `title` (cached label), `created_by_user_id`, `created_at`. Unique `(issue_id, record_type, record_id)`; index `(record_type, record_id)`. |
| `merge_chat_subscriptions` (`mcs_`) new | `channel_id`, `team_id`, `repository_id`, `events` jsonb (`review_requested`, `checks_failed`, `pull_request_merged`, `issue_created`, `issue_done`, `release_shipped`, `daily_digest`), `digest_hour` (UTC, 0–23), `created_by_user_id`, timestamps, `deleted_at`. |
| `time_entries` + (`time-entries.ts`) | `merge_issue_id` (varchar 30, nullable, indexed; no FK). flow-api accepts and filters on it. |
| `github_repo_links.connection_id`, `github_project_links.connection_id` | FK now references `merge_connections.id`. |
| **master** `merge_provider_index` (`mpi_`) new | `provider`, `kind` (`installation` = GitHub installation id, `webhook` = a repository's `webhook_key`), `external_key`, `workspace_id` (`ws_…`), timestamps. Unique `(provider, kind, external_key)`. |

Migration order (each generated with drizzle-kit and journaled; the data step
with `drizzle-kit generate --custom`):

1. `0243_weldmerge_phases` — the tenant tables and columns above, without the
   FK change.
2. `0244_weldmerge_adopt_github` (custom) — copy every live `github_connections`
   row into `merge_connections` **keeping its id** (provider `github`,
   `external_account_id` = installation id as text, `account_login` =
   `owner_login`, `account_type` `organization`/`user`, status, webhook secret,
   app slug, scopes, installed/revoked at, `created_by_user_id` = `created_by`),
   unless a live `github` merge connection for that installation already exists
   (phase-1 adoption); then repoint `github_repo_links` and
   `github_project_links` rows of such an installation to that existing row.
3. `0245_weldmerge_github_fk` — the FK switch.
4. Master: `pnpm --filter @weldsuite/db db:generate:master` for
   `merge_provider_index`.

`apps/tools/migrate-databases/src/rotate-encryption-key.ts` re-encrypts every
new encrypted column: `merge_connections.credentials`,
`merge_connections.webhook_secret`, `merge_repositories.webhook_secret`,
`merge_provider_accounts.credentials`.

## Phase 2 — GitHub all the way

**Install flow in merge-api.**
- `GET /api/merge/connections/github/install-url?returnTo=` (`merge_connections:manage`) → `{ url }`:
  `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new?state=…`, the
  state an HS256 JWT signed with `CLERK_SECRET_KEY` (Rust: falls back to
  `INTERNAL_API_SECRET`), 600 s, `{workspaceId, userId, returnTo, nonce}`, as
  connect-api's `signInstallStateJwt`. `returnTo` must be a same-app relative
  path (`/…`), else ignored.
- Public `GET /public/merge/github/setup?installation_id&setup_action&state`
  (merge-api, before Clerk): verify the state, fetch the installation's
  metadata with the App JWT, upsert the `merge_connections` row and the master
  index row, publish `merge_connection` created/updated, redirect to
  `returnTo` (default `/weldmerge/settings?tab=providers&installed=1`).
- The recording logic lives in `@weldsuite/merge-domain/installations`
  (`recordGithubInstallation(tenantDb, masterDb, …)`), so connect-api's
  existing callback `GET /api/weldconnect/github/callback` calls the same
  function. The App's current Setup URL keeps working; pointing it at
  merge-api is optional cleanup.
- `POST /api/merge/connections/github` keeps its contract: `connected` when a
  live merge row exists, else `needs_install` with the install URL.

**WeldFlow and WeldConnect on `merge_connections`.** Every reader and writer of
`github_connections` switches to `merge_connections` (provider `github`), newest
active first: connect-api `services/github/connections.ts` (and its routes
`/api/github-connections`, `/api/workflow-github/*`,
`services/workflow-integrations/github.ts`), integration-webhook-worker
`github/connections.ts` and `github/webhook.ts`, and the Rust ports
(`rust/modules/connect/src/github.rs`, `workflow_integrations.rs`,
`rust/modules/integrations/src/github/{webhook,outbound,project_sync}.rs`,
`rust/modules/merge/src/connections.rs`). Connect's routes keep their paths and
response shapes.

**Master installation index.** `merge_provider_index` rows are written when an
installation is recorded or removed. integration-webhook-worker resolves
`installation.id → workspace` as: KV `gh-install:<id>` → master index → the old
tenant scan as a last resort, which also writes the index row (lazy backfill,
allowed by DATA-008 for a new index). Rust `resolve_workspace` the same.

**Installation events.** `installation` `deleted` → connection `revoked`;
`suspend`/`unsuspend` → `suspended`/`active`; publish `merge_connection` updated.

**Two-way GitHub issue sync** (repository `issue_sync`):
- `import`: GitHub issues become WeldMerge issues (in the repository's team);
  later changes on GitHub flow in; WeldMerge edits don't flow out.
- `two_way`: also pushes WeldMerge changes to GitHub.
- Synced fields: title, description ↔ body, open/closed ↔ status
  (closed → `done`, or `canceled` when `state_reason` is `not_planned`; reopen →
  `todo`; WeldMerge `done`/`canceled` → close with that reason, any other status
  → open), labels by name (labels that don't exist are created as team labels),
  assignee by linked provider account. Comments sync both ways (provider
  comments get `source = provider`). Pull requests on GitHub are not issues and
  are skipped.
- Loop guard: `merge_external_issues.checksum` over the synced fields; an
  inbound event whose checksum equals the stored one is ignored; an outbound
  push stores the new checksum before the webhook echo arrives.
- Webhooks forwarded to merge-api: `issues`, `issue_comment`, `installation`
  (in addition to phase 1's four). `MergeInternal.githubEvent` handles them.
- Routes: `POST /repositories/:id/import-issues` (open issues, up to 500,
  `merge_connections:manage`), `POST /issues/:id/external {repositoryId}` (create
  the issue on GitHub/GitLab and link it, `merge_issues:update`), `DELETE
  /issues/:id/external`. Issue detail DTO gains `external: {provider, number, url,
  state, repositoryFullName} | null`. Pushes run inside the request (so
  conformance sees the calls).

**Inbox state.**
- `PATCH /api/merge/inbox/items/:itemKey {read?, snoozedUntil?, archived?}`,
  `POST /api/merge/inbox/read-all` (`merge_pull_requests:read`, own rows only).
- `GET /inbox` items gain `read`, `snoozedUntil`; archived and still-snoozed
  items are left out unless `?include=archived` / `?include=snoozed`.

## Phase 3 — GitLab, Bitbucket, Azure DevOps

**Provider adapters.** `apps/workers/merge-api/src/services/providers/` holds one
folder per provider (`github/`, `gitlab/`, `bitbucket/`, `azure-devops/`) behind
the interfaces in `providers/types.ts`:

- `ConnectionAdapter`: `listAvailableRepositories`, `getRepository`,
  `listPullRequestsForBackfill` (open + closed/merged in 30 days, ≤ 300),
  `getPullRequest`, `reviewDecision`, `checksStatus`, `registerWebhook` /
  `deleteWebhook`, `verifyWebhook(headers, rawBody, secret)`,
  `parseWebhook(headers, body)` → normalized events (`pull_request`,
  `review`, `checks`, `issue`, `issue_comment`, `repository_removed`).
- `IssueSyncAdapter` (GitHub, GitLab): list/get/create/update issues, list/create
  comments.
- `ReviewAdapter` (phase 4): files, threads, submit review, comment, merge.
- `OAuthProvider` (GitLab.com, Bitbucket, Azure DevOps, GitHub user auth):
  `authorizeUrl`, `exchangeCode`, `refresh`, `currentUser`.

Mappers from provider payloads to `MirrorFields` live in
`@weldsuite/merge-domain/providers/{gitlab,bitbucket,azure-devops}` (pure,
unit-tested); GitHub's stays in `@weldsuite/merge-domain/github`.

**Connecting.**
- `GET /api/merge/connections/:provider/authorize-url?returnTo=` (gitlab,
  bitbucket, azure_devops; `merge_connections:manage`) → `{ url }`. State: a
  random id in KV `merge_oauth_state:<id>` (600 s) with
  `{workspaceId, userId, provider, purpose: 'connection'|'account', host?, returnTo}`.
- The provider redirects to the SPA page `/weldmerge/oauth/callback` (fixed,
  registered on each OAuth app), which POSTs `{code, state}` to
  `POST /api/merge/oauth/callback` (Clerk-authenticated; the state's user and
  workspace must match the caller). It exchanges the code, stores encrypted
  credentials, and creates the connection (`purpose = connection`) or the
  member account (`purpose = account`), then returns `{ purpose, returnTo }`.
- Self-managed GitLab: `POST /api/merge/connections/gitlab {host, token}`
  (validates with `GET {host}/api/v4/user`).
- Tokens refresh on use when `expiresAt` is within 5 minutes; a refresh
  failure marks the connection `needs_attention`.
- Azure DevOps uses Microsoft Entra ID OAuth (tenant `organizations`, scope
  `499b84ac-1321-427f-aa17-267ca6975798/.default offline_access`); the
  connection's `host` is the organisation URL `https://dev.azure.com/<org>`,
  chosen after sign-in from the user's organisations
  (`POST /api/merge/connections/azure_devops/organization {connectionId, organization}`
  when there is more than one).

**Repositories.** Adding a GitLab/Bitbucket/Azure repository registers a webhook
on it with URL `${WEBHOOK_BASE_URL}/webhooks/merge/<provider>/<webhook_key>` and
a fresh secret (GitLab `X-Gitlab-Token`, Bitbucket HMAC `X-Hub-Signature`,
Azure DevOps service-hook basic-auth password), stores both, and writes the
master index row (`kind = webhook`). Removing the repository deletes the hook
and the index row. Backfill and *Refresh* work as for GitHub.

**Webhook ingress.** integration-webhook-worker serves
`POST /webhooks/merge/:provider/:key`: master index lookup (KV-cached
`merge-hook:<provider>:<key>`) → workspace → forwards
`{workspaceId, provider, key, headers (allow-listed), body (raw text)}` to
`MergeInternal.providerEvent`. merge-api finds the repository by `webhook_key`,
verifies the signature with its stored secret (401-equivalent `ignored:
bad_signature` otherwise), parses and applies through the same PR sync,
automation and issue sync code as GitHub. Rust: `rust/modules/integrations`
in process.

**Member accounts.** `GET /api/merge/accounts/:provider/authorize-url` (all four
providers; GitHub uses the App's user authorization with
`GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET`), `POST
/api/merge/accounts/gitlab-token {host, token}` (self-managed),
`DELETE /api/merge/accounts/:provider?host=`. `GET /accounts/me` returns each
account with `verified`, `host`, `avatarUrl`, never the token. A typed login
(`PUT /accounts/me`, phase 1) keeps working for "needs your review".

## Phase 4 — Review in WeldMerge

Live from the provider, nothing stored except what sync already mirrors.

| Route | Permission | Token |
|---|---|---|
| `GET /pull-requests/:id/files` → `[{path, previousPath, status, additions, deletions, patch}]` | `merge_pull_requests:read` | connection |
| `GET /pull-requests/:id/threads` → review threads with comments (`path`, `line`, `side`, `body`, `author`, `createdAt`, `resolved`) and general comments | `merge_pull_requests:read` | connection |
| `POST /pull-requests/:id/reviews {event: approve\|request_changes\|comment, body?, comments?: [{path, line, side, body}]}` | `merge_pull_requests:review` | member |
| `POST /pull-requests/:id/comments {body, path?, line?, side?, inReplyToId?}` | `merge_pull_requests:review` | member |
| `POST /pull-requests/:id/merge {method: merge\|squash\|rebase, commitTitle?, commitMessage?}` | `merge_pull_requests:merge` | member |

A member without a linked, verified account for the provider gets 409
`account_not_linked`; a provider refusal is 502 `provider_error` with the
provider's message, or 409 `not_mergeable`. After a merge the mirror is
re-fetched and saved (automations run as for a webhook). Methods a provider
lacks (rebase on Azure DevOps is `rebase` = "rebase and fast-forward") map to
the nearest, and unsupported ones are 422.

## Phase 5 — Across WeldSuite

- **Releases** (`merge_releases:read|manage`): `GET/POST /releases`,
  `GET/PATCH/DELETE /releases/:id`, `POST /releases/:id/refresh` (merged PRs of
  the repository between `base_ref` and `head_ref` via the provider's compare
  API: commits → PRs by merge commit sha; fallback: PRs merged since the
  previous shipped release), `POST /releases/:id/generate-notes` (AI through
  `@weldsuite/ai`, charged with `chargeAiUsage`, model `billedModelId`),
  `POST /releases/:id/ship` (status `shipped`, event `merge_release.shipped`
  with the PR ids, issue ids and linked desk ticket ids), `POST
  /releases/:id/publish {knowledgeSpaceId?, email?: {mailAccountId, to[]}}`
  (WeldKnow page through `@weldsuite/know-domain/pages` `createKnowledgePage`,
  email through `@weldsuite/mail-domain/outbound` `guardedSend`, each publishing
  its own module's event as flow-api's project lessons do).
- **Record links** (`merge_issues:update` to change, `merge_issues:read` to
  read): `GET/POST /issues/:id/links`, `DELETE /issues/:id/links/:linkId`,
  `GET /record-links?recordType=&recordId=` (what a ticket or company shows).
  `POST /issues` accepts `links[]` so a desk agent escalates a ticket in one
  call (the ticket and its customer company). Events `merge_record_link`
  created/deleted.
- **WeldDesk**: a "WeldMerge" section in the ticket sidebar
  (`app/welddesk/tickets/[ticketId]/ticket-detail-client.tsx`, `TicketSidebar`):
  linked issues with status, the release that shipped them, *Escalate to
  issue* (team picker, prefilled title/description, links ticket + company).
- **WeldConnect**: trigger objects `merge_issue`, `merge_pull_request`,
  `merge_release` in `BASIC_TRIGGER_OBJECTS`; built-in actions
  `merge.create_issue`, `merge.update_issue`, `merge.comment_on_issue`
  (connect-api static catalogs + `WELDCONNECT_ACTION_TYPES` in connect-api and
  platform, a workflow-worker handler calling `MERGE_INTERNAL.workflowAction`,
  permission-checked as the workflow owner (CONN-004), Rust
  `rust/modules/connect/src/engine/actions.rs` calling the merge module in
  process). Template `weldmerge-release-shipped` (category `development`):
  on `merge_release.shipped`, reply to the linked tickets' customers.
- **WeldChat**: `merge_chat_subscriptions` (`GET/POST /chat-subscriptions`,
  `PATCH/DELETE /chat-subscriptions/:id`, `merge_teams:manage`). Posts go
  through `postSystemChatMessage` (`@weldsuite/chat-domain`, author
  `app:weldmerge`) with `metadata.weldmerge = {kind, pullRequestId?, issueId?,
  releaseId?, itemKey?}`, so the chat UI renders a card: review requests with
  *Approve* (calls the review route) and *Snooze* (inbox state), failed
  checks, merged PRs, created/done issues, shipped releases. Posting happens
  in the request or webhook that caused it. The daily digest uses the due
  index (kind `merge_digest`, re-armed for the next `digest_hour`).
  Slash commands in the chat composer: `/merge <query>` (share an issue or
  pull request card) and `/issue <title>` (create an issue). A reply in a card's
  thread can also be posted to the provider (toggle in the composer), through
  `POST /pull-requests/:id/comments`.
- **WeldAgent**: `packages/domains/agent/src/merge-tools.ts` (list/get/create/
  update issues, comment, list/get pull requests, `merge_open_draft_pull_request`
  which commits files to a new branch through the Git Data API and opens a
  draft PR, GitHub only) calling `MERGE_INTERNAL`. `PATCH /issues/:id
  {agentId}` assigns an issue to an agent and publishes
  `merge_issue.agent_assigned`; agent-api runs that agent with the issue as its
  task (entity-agents consumer). The assignee picker lists agents.
- **WeldFlow**: an issue's `flow_project_id` shows on both sides (phase 1);
  time is logged against an issue through flow-api `time_entries.merge_issue_id`
  (create + filter), shown on the issue.
- **WeldCRM**: the issue detail lists the companies linked directly or through
  its tickets.
- **⌘K**: `merge_issue` (and `merge_pull_request`) in `SEARCH_ENTITY_TYPES`, a
  search function + registry entry + `buildResultUrl` in app-api
  `services/search.ts`, a document loader for semantic search, palette icon
  and label; Rust `rust/modules/core-files/src/search.rs` and
  `rust/crates/subscribers/src/search`.
- **Home widget** `weldmerge-inbox` (`lib/home-widgets`): the member's top inbox
  items.

## Permissions and events

- `merge_pull_requests`: `read`, `review`, `merge` (MEMBER gets all three,
  VIEWER read). `merge_releases`: `read`, `manage` (MEMBER read, ADMIN manage).
- Entity events: `merge_release` (created, updated, deleted, shipped),
  `merge_record_link` (created, deleted), `merge_chat_subscription` (created,
  updated, deleted), `merge_issue` + `agent_assigned`.

## Ops (before it works in an environment)

- GitHub App: permissions Issues RW, Pull requests RW, Contents RW, Checks R,
  Metadata R; events Issues, Issue comment, Installation (plus phase 1's);
  user authorization callback URL `https://app(-test).weldsuite.org/weldmerge/oauth/callback`.
- merge-api secrets: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `GITHUB_APP_SLUG` (var), `CLERK_SECRET_KEY`, `DATABASE_ENCRYPTION_KEY`(+`_V2`),
  `DATABASE_URL_MASTER`, `GITLAB_OAUTH_CLIENT_ID`/`_SECRET`,
  `BITBUCKET_OAUTH_CLIENT_ID`/`_SECRET`, `AZURE_DEVOPS_CLIENT_ID`/`_SECRET`,
  `AI_GATEWAY_API_TOKEN`; vars `APP_URL`, `WEBHOOK_BASE_URL`, `CF_ACCOUNT_ID`.
- OAuth apps: GitLab.com application, Bitbucket OAuth consumer, Microsoft Entra
  app for Azure DevOps — redirect URI `https://app(-test).weldsuite.org/weldmerge/oauth/callback`.

## Build areas and file ownership

Agents work in the same checkout at the same time, so each owns its files.
Shared files are prepared by the foundation and then only appended to by the
area named.

| Area | Owns |
|---|---|
| **F. Foundation** | Schema + all migrations; `schemas/weldmerge.ts` additions and new `schemas/weldmerge-*.ts` files; `domains/weldmerge.ts` client methods for every route; permissions, entity events, api-modules prefixes (`/public/merge`), secrets manifest, merge-api `types.ts` / `wrangler.toml` / `package.json` deps; `services/providers/types.ts` + registry; route stub files mounted in `src/index.ts`; integration-webhook-worker route stub; i18n sub-file layout; `pnpm install` + lockfile. |
| **A. GitHub** | Install flow + public setup route; `@weldsuite/merge-domain/installations`; connect-api, workflow-worker, integration-webhook-worker GitHub changes; master index read/write; installation events; issue sync engine (`services/issue-sync/*`) + GitHub `IssueSyncAdapter`; inbox state; `services/providers/github/{client,connection,issues}.ts`. |
| **B. Providers** | `services/providers/{gitlab,bitbucket,azure-devops}/{client,connection,oauth,webhooks,issues}.ts` (GitLab issues adapter included); `services/oauth/*` and the `/oauth/callback`, `authorize-url`, gitlab token routes; GitHub user OAuth (`providers/github/oauth.ts`); `@weldsuite/merge-domain/providers/*`; `MergeInternal.providerEvent`; integration-webhook-worker `src/merge/provider-webhook.ts`. |
| **C. Review** | `services/providers/*/review.ts`, `services/review.ts`, routes `pull-requests/review.ts`. |
| **D. Across (releases, links, chat)** | Releases, record links, chat subscriptions + posting + digest; `services/{releases,record-links,chat}*.ts` and their routes. |
| **E. Across (connect, agent, flow, search)** | WeldConnect actions/triggers/template (connect-api, workflow-worker, platform `app/weldconnect/mvp.ts`), `MergeInternal.workflowAction`; `packages/domains/agent/src/merge-tools.ts` + agent-api assignment dispatch; flow-api time entries; app-api search + document loader. |
| **U1. UI providers/sync/inbox** | Settings providers/accounts/repository sync, OAuth callback page `src/routes/weldmerge/oauth/callback.tsx`, issue external sync UI, inbox state actions. |
| **U2. UI review** | Pull request detail: files/diff viewer, threads, review and merge. |
| **U3. UI across** | Releases pages, desk ticket section + escalate, issue links/customers/time/agent assignee, home widget, ⌘K result types, chat cards + slash commands, WeldConnect editor trigger objects/action forms. |
| **R1. Rust merge** | `rust/modules/merge/**` for every new route; conformance suite list. |
| **R2. Rust elsewhere** | connect, integrations, flow, core-files search, subscribers search, chat/know/mail calls; catalogs. |
