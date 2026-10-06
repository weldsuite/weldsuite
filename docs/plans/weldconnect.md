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
2. **"After another workflow" trigger** (`workflow_complete`). The engine
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
5. **Unhide the finished sections**: variables, webhooks, analytics/errors
   (the errors view has data since #859). See
   `WELDCONNECT_OUT_OF_SCOPE_SECTIONS` in `app/weldconnect/mvp.ts`.
6. **Approval / waiting steps**: write a `waiting_for_input` run status (badge,
   filter, i18n) and unlock `manual_step`. Waiting is only allowed in the main
   flow, not inside branches or loops (engine refuses it there).
7. **Third-party providers, one PR each** (or a few grouped once the pattern is
   set): Slack first, then Google Sheets, Gmail, Google Calendar, Teams,
   Notion, Airtable, GitHub, Asana, Twilio. Adapters exist in
   `workflow-worker/src/engine/actions/providers/`; each needs a working
   connect/OAuth flow, a connection test (`routes/integrations/index.ts`
   answers "Test not implemented" for some), an editor form, gate entries and
   a test against the real service.
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
