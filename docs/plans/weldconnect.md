# WeldConnect: from MVP to a working automation app

Status (7 October 2026): phase 1 and most of phase 2 are merged on `develop`
(#859 to #906). Next: run the browser QA script
(`docs/plans/weldconnect-qa-checklist.md`) on `app-test.weldsuite.org`, finish
the server-backed templates (`feat/weldconnect-templates`, in progress), then
the parked items listed under "Still open" below. User guides live on
help.weldsuite.org (`apps/web/docs/src/app/weldconnect/`).

WeldConnect is the workspace workflow automation module (editor in
`apps/web/platform/app/weldconnect`, API in `apps/workers/connect-api`, engine
in `apps/workers/workflow-worker`). It shipped as a narrow MVP: entity-event and
schedule triggers, `send_email` and `create_customer`, everything else behind an
activation gate (`connect-api/src/services/weldconnect-mvp.ts`, mirrored in
`apps/web/platform/app/weldconnect/mvp.ts`).

Decisions taken with the product owner:

- **Positioning**: both internal automation and a Zapier-style integration hub,
  phased: WeldSuite-internal automation first, third-party providers one by one
  after.
- **WeldSuite actions are typed**, never raw table writes. The generic
  `create_record` / `update_record` / `delete_record` actions stay hidden: they
  skip validation and entity events and can write any table.
- **A run acts as the workflow's owner** (`workflows.created_by`), checked
  against the owner's workspace permissions at run time
  (`connect-api/src/services/workflow-owner.ts`).
- **Migrations are allowed** for this work, generated with drizzle-kit and
  flagged in the PR.
- **Delivery**: phased PRs against `develop`.

## Phase 1: merged

| PR | Branch | What |
|---|---|---|
| #859 | `feat/weldconnect-reliability` | Cancel terminates the run; replay-safe step rows; error logs; unknown step types fail |
| #860 | `feat/weldconnect-logic` | Real branching (if/else, value branches), loops ("for each item"), delays; "add step after" in the editor |
| #861 | `feat/weldconnect-actions` | Runs act as the owner with run-time permission checks; `create_contact`, `update_contact`, `send_notification` |
| #862 | `feat/weldconnect-webhook-http` | Webhook trigger (master registry, raw-body HMAC, provisioning on save) and hardened `http_request`; master migration `0048` |
| #864 | `feat/weldconnect-task-action` | `create_task` (logic extracted to `@weldsuite/flow-domain`) |
| #869 | `feat/weldconnect-chat-action` | `post_chat_message` as the workflow (system author via `@weldsuite/chat-domain`) |
| #870 | `feat/weldconnect-crm-actions` | `create_lead`, `create_deal`, `move_deal_stage`, `log_activity` (logic extracted to `@weldsuite/crm-domain`) |

#860, #861 and #864 merged into their stacked parents and reached `develop`
through #867; #869 and #870 through #872. #862's master migration also widened
`user_apps.icon` to `text` (pending drift from the WeldApps work).

## Phase 2

Done (all merged on `develop`):

| # | Item | PR | What |
|---|---|---|---|
| 2 | "After another workflow" trigger | #891 | `workflow_complete` unlocked with a workflow picker; matcher reads the flat editor shape; idempotent chained starts; Test runs don't chain; `{{trigger.*}}` incl. source step outputs |
| 4 | AI steps | #892 | `ai_generate` / `ai_classify` unlocked, metered against the credit wallet, `settings.maxCreditsPerRun` enforced (ledger sum + worst-case estimate); settings field restored; workflow-worker secrets manifest fixed |
| 5 | Unhide finished sections | #891 | Variables, Webhooks (managed rows can't be deleted), Analytics with error log + acknowledge. Actions / Triggers libraries stay hidden (`WELDCONNECT_OUT_OF_SCOPE_SECTIONS`); Templates and Integrations were added to the sidebar in #927 |
| 3 | Server-backed templates | #927 | Gallery lists `GET /api/workflow-templates`: the workspace's own templates ("Save as template" on a workflow's Settings page) plus nine built-in starter templates kept in code (`@weldsuite/app-api-client/schemas/weldconnect-templates`, texts in `@weldsuite/i18n/locales/<locale>/weldconnect-templates`), each tested against the activation gate; "Use template" always creates a draft; Templates and Integrations added to the sidebar |
| 6 | Approvals + waiting status | #891 | `manual_step` as "Approval" (approvers, notifications, approve/reject + comment, 7-day expiry), `waiting_for_input` status, badge, filter; refused inside branches/loops (`nested_waiting_step`) |
| 7 | Providers: Slack | #894 | OAuth connect, test, channel picker, `slack.post_message` (thread replies, mapped errors); provider owner-membership check in `providers/token.ts`; `PUBLIC_APP_URL` fixed for test/production |
| 7 | Providers: Google | #904 | `google_sheets.append_row` / `update_row`, `gmail.send_email`, `google_calendar.create_event`; least-privilege scopes, paste-a-link spreadsheet picker, token refresh on workflow-worker |
| 7 | Providers: GitHub | #905 | `app_installation` auth reusing WeldFlow's GitHub App installation, repo picker, `github.create_issue` / `github.create_comment` |
| 8 | Help docs | #926 | Guides on help.weldsuite.org (`apps/web/docs/src/app/weldconnect/`); screenshots still to capture (TODO list in each page's `screenshots_todo` frontmatter) |
| 9 | Extras | #906 | One-time schedules (`scheduleType: 'one_time'`, `executeAt`, fires once then disables itself), version history (`workflow_versions`, restore through `updateWorkflow`), `settings.maxConcurrentRuns` with a `skipped` run status; tenant migration `0199_far_tomas`, D1 `0003_schedule_index_one_time.sql` |

Next:

- **(1) Browser QA on test**: `docs/plans/weldconnect-qa-checklist.md`, the
  consolidated script from the QA sections of #859 to #906. Everything above is
  verified by unit/integration tests and type-checks; only a few paths were
  tried in a browser. Needs the workflow-worker secrets and the Slack/Google
  OAuth configuration listed there.
- **(10) Backfill legacy webhooks** into `workflow_webhook_registry`, only if
  any pre-#862 webhook workflows are still live (they register again on their
  next save).

### Still open / parked

- **More providers**: Microsoft Teams, Notion, Airtable, Asana, Twilio. Parked
  until their apps/keys exist. Adapters exist in
  `workflow-worker/src/engine/actions/providers/`; each needs a working
  connect/OAuth flow (or an app-installation link, see "Provider pattern"
  below), a connection test, a resource picker where the action needs one, an
  editor form, gate entries and a test against the real service. Their cards
  already show on `/weldconnect/integrations` (the page lists the whole
  catalog), which the help docs call out.
- **Poll / integration triggers**: `integration_event` and the catalogued poll
  triggers (`google_sheets.new_row`, `gmail.new_email` (needs the restricted
  `gmail.readonly` scope and re-verification), `google_calendar.new_event`,
  Slack/GitHub events) are not unlocked; there is no poll-trigger runtime for
  this catalog yet.
- **Concurrency gating** for the `integration_event` matcher and the
  `workflow_complete` dispatch (same `@weldsuite/db/lib/workflow-concurrency`
  helper, same pattern as `startRun` / the entity-event matcher / the schedule
  sweep).
- **Version diff view**: History is a list + restore dialog on the Settings
  page, no diff yet.
- **Run → version link**: the execution page doesn't show which
  `workflow_versions` row produced a run.
- **Integrations entry point**: `/weldconnect/integrations` has no sidebar or
  Settings link; users reach it through the URL or links in the editor. Worth a
  sidebar entry now that providers work.

Known limits set on purpose: 100 items per loop and 250 loop iterations per run
(`workflow-worker/src/engine/execute-steps.ts`, `actions/control.ts`); delays up
to 365 days; approvals expire after 7 days and only sit in the main flow;
webhook bodies up to 1 MB; `http_request` 30 s default timeout (120 s cap), 1 MB
response; record-event chains stop at depth 3, workflow chains at depth 10.

## Provider pattern (established by Slack `feat/weldconnect-slack`, extended by Google `feat/weldconnect-google` and GitHub `feat/weldconnect-github`)

Slack is the first third-party provider unlocked end to end. Google (Sheets,
Gmail, Calendar) and GitHub followed the exact same shape — most
of the scaffolding (catalog entry, engine handler stub, OAuth routes) already
existed for all ten providers in `@weldsuite/workflow-integrations` before
Slack's PR; what a provider's PR adds is everything that makes it actually
usable from the editor, not just callable from the engine.

**Multiple products behind one OAuth app (Google's shape)**: Sheets, Gmail and
Calendar are three separate `IntegrationDef`s (`google_sheets`, `gmail`,
`google_calendar`, each its own `workflow_integrations` row, connected
separately) but share one Google Cloud OAuth client
(`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, already on connect-api from before
either Slack or Google shipped) — `oauth.ts`'s generic flow needs nothing
provider-specific for this, since the client id/secret is looked up once per
`IntegrationDef.auth`, not once per vendor. Each product's `googleAuth(...)`
(`providers/google.ts`) requests only the scopes its own actions need —
**least privilege, deliberately**: Gmail asks for `gmail.send` only, not
`gmail.readonly` (that one is a Google *restricted* scope — CASA security
assessment, not just standard verification — and nothing this phase reads
mail; add it back only when the `gmail.new_email` poll trigger ships, and
re-verify then). Prefer narrow, per-product scope sets over one broad
connection even when it means a few more OAuth prompts.

**A picker doesn't always mean a new scope.** Browsing "all my Drive files" to
pick a spreadsheet would need Drive's own scopes (their least-sensitive tier
is still a step up from Sheets' own). Google Sheets' picker instead resolves a
**pasted** spreadsheet link/id through the Sheets API itself
(`spreadsheets.get`, already covered by the `spreadsheets` scope) and returns
its title + tabs in one call — validation and the sheet-tab dropdown from a
single request, no Drive scope at all. Worth checking for every future
provider with a "browse resources" picker: does the action's own API let you
resolve-by-id instead of list-everything?

**A provider whose tokens expire needs its OAuth client secret on the ENGINE
worker too, not just on connect-api.** Slack bot tokens never expire, so
`providers/token.ts`'s refresh path was never exercised end to end before
Google. Google access tokens last about an hour; every `google_sheets`/
`gmail`/`google_calendar` action refreshes in-process
(`getValidIntegrationToken` → `refreshOAuthToken`) before calling its API —
which means `workflow-worker`'s own `wrangler.toml`/manifest needs
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` too (it previously carried none of
the OAuth provider secrets, only connect-api did). A future provider with
expiring tokens needs the same check: does the ENGINE worker, not just
connect-api, have the client secret to refresh with?

GitHub follows the same shape but with a different **auth kind**:
`app_installation` (`AppInstallationConfig` in `@weldsuite/workflow-
integrations`), not `oauth2` or `api_key`. WeldSuite already runs a GitHub
App installed per workspace for WeldFlow's issue/PR sync
(`github_connections`, one row per workspace, `services/github/connections.ts`
in connect-api); rather than ask the user to authorize a second OAuth app or
paste a PAT with overlapping repo access, WeldConnect's `github` integration
just points a `workflow_integrations` row at that existing installation
(`POST /api/workflow-integrations/github/link`,
`services/workflow-integrations/github.ts`) and mints a fresh ~1h
installation token on every call instead of storing a long-lived secret. The
JWT-signing + token-exchange logic is shared with workflow-worker's engine
action via `@weldsuite/connect-domain/github/app-auth` (workers never import
each other's `src/`, so this is the one place it lives — connect-api's
pre-existing `services/github/auth.ts`, used by the WeldFlow install/sync
flow, keeps its own copy for now rather than risk touching that unrelated
feature). A future `app_installation` provider follows the same shape: a
shared token-minting helper in `packages/domains/connect` (or its own module's
domain package), a `link` route that points at wherever that platform-level
installation already lives, and no OAuth redirect.

**Files to touch per provider:**

1. `packages/core/workflow-integrations/src/providers/<provider>.ts` — the
   `IntegrationDef` already exists for all ten; add any input fields the
   action needs beyond what's already listed (e.g. Slack's `integrationId`
   and `threadTs`). This file is metadata only — JSON-serialisable, no
   behaviour — and ships to the builder UI as-is.
2. **Engine handler** —
   `apps/workers/workflow-worker/src/engine/actions/providers/<provider>.ts`.
   Resolve the token via `getValidIntegrationToken` from `./token.ts` — it
   already dispatches on the catalog's `auth.kind` (OAuth refresh, API-key
   decrypt, or — for `app_installation` — minting a fresh token from
   `settings.installationId` + the app's private key) and already runs the
   owner-membership check (see "Runs as the owner?" below), so a new provider
   gets all of it for free; `getIntegrationCredentials` is the API-key-only
   path when a handler needs the raw credential bag instead of a bearer
   token. Classify every provider error as retryable (plain `Error`, or
   `NonRetryableStepError` for anything retrying the exact same request won't
   fix — bad config, dead auth, not-found). Map the provider's own error codes
   to clear messages the way Slack's `NON_RETRYABLE_SLACK_ERRORS` does; attach
   the raw payload as `.details` so it survives into the step row
   (`errorDetails()` in `engine/errors.ts`). Return a small, stable output
   shape (`{ ok, ... }`) so the variable picker has something to offer the
   next step.
3. **Connect / test / picker routes** — all live under
   `/api/workflow-integrations/*`
   (`apps/workers/connect-api/src/routes/workflow-integrations/`):
   - `oauth.ts` already handles `:provider/authorize` and `:provider/callback`
     generically from the catalog's `auth` config — nothing to add for a new
     OAuth2 provider unless it needs extra fields stashed on `settings`
     (Slack's `storeOnSettings: ['team', 'bot_user_id']`). `app_installation`
     providers skip these entirely: `oauth.ts`'s `POST /:provider/link` points
     the `workflow_integrations` row at whatever platform-level installation
     already exists (GitHub's `linkGithubAppInstallation` is the example) and
     returns `needs_install` when there isn't one yet, instead of redirecting
     anywhere.
   - `index.ts`'s `/:id/test` already has a branch per provider family
     (`slack`, `google*`, `github`); add the new provider's cheap reachability
     check there, implemented in its own
     `services/workflow-integrations/<provider>.ts` file (`testSlackAuth` /
     `testGithubAuth` are the examples) so the route stays a thin dispatcher.
     An `app_installation` provider has nothing in `oauthTokens` to check —
     branch on `integration.type` before that check, not after.
   - A **picker** (channel list, spreadsheet list, repo list, …) is its own
     route, `GET /:id/<provider>/<resource>`
     (`GET /:id/slack/channels` → `conversations.list`, `GET
     /:id/github/repos` → `installation/repositories`), backed by the same
     per-provider service file (`listSlackChannels` / `listGithubRepos`). Keep
     provider API calls out of the route handler itself.
4. **Connection + resource picker in the step form** —
   `apps/web/platform/components/workflow-editor/components/action-config-form.tsx`.
   One form component per action
   (`SlackPostMessageForm` next to `PostChatMessageForm`): a connection
   `Select` (only shown when `useWorkflowIntegrations({ type, status:
   'connected' })` returns more than one row — most workspaces have exactly
   one), a resource picker backed by the new picker route/hook
   (`useSlackChannels`, `apps/web/platform/hooks/queries/use-workflow-integration-queries.ts`),
   and `VariableInput` fields for everything else. Wire the new case into
   `ActionConfigForm`'s switch.
5. **Editor catalog** —
   `apps/web/platform/components/workflow-editor/workflow-editor-client.tsx`:
   add the step to `TASK_ACTION_TYPES` (category `'integration'`), an icon in
   `ACTION_META`, and a one-line `summarize<Provider><Action>` in
   `CONFIG_SUMMARIZERS`. Optionally a `flowEditor.actionLabels` i18n entry for
   the canvas fallback label (steps added through the picker already get a
   `name`, so this is only a safety net).
6. **Gate** — add the namespaced id (`<provider>.<action>`) to
   `WELDCONNECT_ACTION_TYPES` in **both**
   `apps/workers/connect-api/src/services/weldconnect-mvp.ts` and
   `apps/web/platform/app/weldconnect/mvp.ts`, plus a
   `REQUIRED_ACTION_FIELDS` entry in the connect-api copy (the fields a step
   can't activate without, same idea as every other action). If the action
   can be pointed at the wrong connection (most can, via an optional
   `integrationId`), extend `validateWeldConnectIntegrations` — it already
   walks every `<provider>.<action>` step generically by splitting the type on
   `.`, so a new provider needs no new code there, only the new entry in
   `WELDCONNECT_ACTION_TYPES` to reach it.
7. **i18n** — `addNodePanel.actions['<provider>.<action>']` and an
   `actionConfigForm.<provider><Action>` block, in **both** `en/weldconnect.ts`
   and `nl/weldconnect.ts`.
8. **Tests** — mock `fetch` for the provider's REST calls (no real network in
   unit tests); cover the engine handler's success/error-mapping/rate-limit
   paths, the OAuth callback + token storage (reuses the generic
   `workflow-integrations/oauth.ts`, so usually nothing new to test there
   unless `storeOnSettings` fields are provider-specific), the picker route,
   and the activation gate (missing/disconnected connection).

**Runs as the owner?** Third-party provider actions act on the **workspace's**
integration connection (gated by `integrations:create`/`update` at connect
time), not on data scoped to the workflow's owner — unlike `create_contact` or
`create_task`, there's no per-object WeldSuite permission to check. They still
refuse once the owner is gone: `getValidIntegrationToken` /
`getIntegrationCredentials` (`providers/token.ts`) check that
`ctx.tenant.ownerUserId` is still an active workspace member before resolving
any token, consistently for every provider, present and future. Runs from
before owners were carried (`ownerUserId` absent) are let through unchanged.

**Checking "is this a Google/provider-family type" by string prefix is
fragile**: `gmail` doesn't start with `"google"`, so the pre-existing
`/:id/test` dispatcher's `type.startsWith('google')` branch silently never
ran for Gmail (falling through to the generic "token present" success,
meaning a broken Gmail connection always reported as healthy) until it was
replaced with an explicit `Set(['google_sheets', 'gmail', 'google_calendar'])`
membership check. Prefer an explicit list over a prefix/substring check for
"which provider family is this" tests, even when most of the family happens
to share a name prefix.

**Google API error shape**: every Discovery-based Google API (Sheets v4,
Calendar v3, Gmail v1) returns the same JSON error envelope
(`{ error: { code, message, status, errors: [{ reason }] } }`), so one
classifier (`workflow-worker/src/engine/actions/providers/google-errors.ts`)
covers all three. Two things don't match the plain-HTTP-status intuition:
`invalid_grant` on a *token refresh* call (not the API call itself) means the
refresh token was revoked — map it to a reconnect message in
`providers/token.ts`, not in the per-API classifier; and Google reports
several per-minute quota/rate-limit errors as **403** (reason
`rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded`), not 429 — a
403 classifier needs to check the reason before deciding "non-retryable
permission problem" vs. "retry me".

**Legacy actions**: if a provider already had a pre-catalog action (Slack had
`slack_message` in `actions/communication.ts`, predating
`@weldsuite/workflow-integrations`), leave it registered for the workflows
that already use it, keep it out of `WELDCONNECT_ACTION_TYPES` so the editor
and activation gate never offer it again, and point a comment at the new
namespaced action instead of extending the old one.
