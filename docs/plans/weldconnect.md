# WeldConnect: from MVP to a working automation app

Status: phase 1 in review (October 2026). Phase 2 is parked until phase 1 is
merged and tried on the test environment.

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

## Phase 1: in review

| PR | Branch | Base | What |
|---|---|---|---|
| #859 | `feat/weldconnect-reliability` | `develop` | Cancel terminates the run; replay-safe step rows; error logs; unknown step types fail |
| #860 | `feat/weldconnect-logic` | #859 | Real branching (if/else, value branches), loops ("for each item"), delays; "add step after" in the editor |
| #861 | `feat/weldconnect-actions` | #860 | Runs act as the owner with run-time permission checks; `create_contact`, `update_contact`, `send_notification` |
| #862 | `feat/weldconnect-webhook-http` | `develop` | Webhook trigger (master registry, raw-body HMAC, provisioning on save) and hardened `http_request`; master migration `0048` |
| 3b | `feat/weldconnect-crm-actions` | #861 | `create_lead`, `create_deal`, `move_deal_stage`, `log_activity` (logic extracted to `@weldsuite/crm-domain`) |
| 3c | `feat/weldconnect-task-action` | #861 | `create_task` (logic extracted to `@weldsuite/flow-domain`) |
| 3d | `feat/weldconnect-chat-action` | #861 | `post_chat_message` as the workflow (system author via `@weldsuite/chat-domain`) |

Finishing phase 1:

- Merge #859 → #860 → #861 → 3b / 3c / 3d, retargeting each stacked PR to
  `develop` once its parent merges.
- #862 is independent; whichever of #862 / #860 / #861 merges second gets small
  conflicts in the shared step-type lists (both activation allowlists, the
  editor catalog, canvas labels, i18n). 3b, 3c and 3d conflict with each other
  in the same lists.
- #862's migration also widens `user_apps.icon` to `text` (pending drift from
  the WeldApps work, safe).

## Phase 2: later

Roughly in the recommended order.

1. **Try phase 1 end to end on test** (`app-test.weldsuite.org`): every trigger
   and step in a real browser, including branches, loops, delays, a webhook
   call and the owner-permission refusals. Everything so far is verified by
   unit/integration tests and type-checks only.
2. **In review (`feat/weldconnect-flow-p2`).** **"After another workflow" trigger** (`workflow_complete`). The engine
   implements it (`workflow-worker/src/engine/workflow-complete.ts`); unlock it
   in the gate and give the editor a workflow picker.
3. **Server-backed templates.** The gallery
   (`app/weldconnect/templates/components/templates-client.tsx`) shows
   hardcoded client templates from `components/workflow-template-dialog.tsx`;
   list `workflow_templates` from the API instead, ship a starter set built only
   from steps that work, and unhide the section.
4. **AI steps** (`ai_generate`, `ai_classify`): unlock, meter against the
   workspace credit wallet (`@weldsuite/core-domain/ai-billing`), and enforce
   the per-run credit cap. `settings.maxCreditsPerRun` is stored but nothing
   reads it, and the settings page no longer shows it.
5. **In review (`feat/weldconnect-flow-p2`); actions/triggers libraries stay hidden.** **Unhide the finished sections**: variables, webhooks, analytics/errors
   (the errors view has data since #859). See
   `WELDCONNECT_OUT_OF_SCOPE_SECTIONS` in `app/weldconnect/mvp.ts`.
6. **In review (`feat/weldconnect-flow-p2`).** **Approval / waiting steps**: write a `waiting_for_input` run status (badge,
   filter, i18n) and unlock `manual_step`. Waiting is only allowed in the main
   flow, not inside branches or loops (engine refuses it there).
7. **Third-party providers, one PR each** (or a few grouped once the pattern is
   set): **Slack done** (`feat/weldconnect-slack` — connect/OAuth, test
   connection, channel picker, `slack.post_message` with thread replies and
   mapped errors, gate; see "Provider pattern" above), then Google Sheets,
   Gmail, Google Calendar, Teams, Notion, Airtable, GitHub, Asana, Twilio.
   Adapters exist in `workflow-worker/src/engine/actions/providers/`; each
   needs a working connect/OAuth flow, a connection test, a resource picker
   where the action needs one, an editor form, gate entries and a test
   against the real service.
8. **Help docs**: guides and screenshots on help.weldsuite.org for the new
   triggers and steps (`.agents/skills/help-docs`).
9. **Extras**: one-time scheduled runs (needs a tenant migration; the sweep only
   knows cron), workflow version history beyond the `version` column, and a
   per-workflow concurrency limit.
10. **Backfill legacy webhooks** into `workflow_webhook_registry`, only if any
    pre-#862 webhook workflows are still live (they register again on their
    next save).

Known limits that phase 1 sets on purpose: 100 items per loop and 250 loop
iterations per run (`workflow-worker/src/engine/execute-steps.ts`,
`actions/control.ts`); delays up to 365 days.

## Provider pattern (established by Slack, PR `feat/weldconnect-slack`)

Slack is the first third-party provider unlocked end to end. Google (Sheets,
Gmail, Calendar) and GitHub should follow the exact same shape — most of the
scaffolding (catalog entry, engine handler stub, OAuth routes) already existed
for all ten providers in `@weldsuite/workflow-integrations` before this PR;
what Slack adds is everything that makes a provider actually usable from the
editor, not just callable from the engine.

**Files to touch per provider:**

1. `packages/core/workflow-integrations/src/providers/<provider>.ts` — the
   `IntegrationDef` already exists for all ten; add any input fields the
   action needs beyond what's already listed (e.g. Slack's `integrationId`
   and `threadTs`). This file is metadata only — JSON-serialisable, no
   behaviour — and ships to the builder UI as-is.
2. **Engine handler** —
   `apps/workers/workflow-worker/src/engine/actions/providers/<provider>.ts`.
   Resolve the token via `getValidIntegrationToken` (OAuth) or
   `getIntegrationCredentials` (API key) from `./token.ts` — both already run
   the owner-membership check (see "Runs as the owner?" below), so a new
   provider gets it for free. Classify every provider error as retryable
   (plain `Error`, or `NonRetryableStepError` for anything retrying the exact
   same request won't fix — bad config, dead auth, not-found). Map the
   provider's own error codes to clear messages the way Slack's
   `NON_RETRYABLE_SLACK_ERRORS` does; attach the raw payload as `.details` so
   it survives into the step row (`errorDetails()` in `engine/errors.ts`).
   Return a small, stable output shape (`{ ok, ... }`) so the variable picker
   has something to offer the next step.
3. **Connect / test / picker routes** — all live under
   `/api/workflow-integrations/*`
   (`apps/workers/connect-api/src/routes/workflow-integrations/`):
   - `oauth.ts` already handles `:provider/authorize` and `:provider/callback`
     generically from the catalog's `auth` config — nothing to add for a new
     OAuth2 provider unless it needs extra fields stashed on `settings`
     (Slack's `storeOnSettings: ['team', 'bot_user_id']`).
   - `index.ts`'s `/:id/test` already has a branch per provider family
     (`slack`, `google*`); add the new provider's cheap reachability check
     there, implemented in its own
     `services/workflow-integrations/<provider>.ts` file (`testSlackAuth` is
     the example) so the route stays a thin dispatcher.
   - A **picker** (channel list, spreadsheet list, repo list, …) is its own
     route, `GET /:id/<provider>/<resource>`
     (`GET /:id/slack/channels` → `conversations.list`), backed by the same
     per-provider service file (`listSlackChannels`). Keep provider API calls
     out of the route handler itself.
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

**Legacy actions**: if a provider already had a pre-catalog action (Slack had
`slack_message` in `actions/communication.ts`, predating
`@weldsuite/workflow-integrations`), leave it registered for the workflows
that already use it, keep it out of `WELDCONNECT_ACTION_TYPES` so the editor
and activation gate never offer it again, and point a comment at the new
namespaced action instead of extending the old one.
