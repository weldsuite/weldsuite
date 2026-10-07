# WeldConnect: browser QA script

One ordered manual QA pass over everything WeldConnect gained in #859 to #906,
on **app-test.weldsuite.org**. Compiled from the QA sections of #891, #892,
#894, #904, #905 and #906, plus the phase 1 PRs (#859, #860, #861, #862, #864,
#867, #869, #870, #872), which had no QA section of their own and are covered
by the checks in sections B to F. Duplicates are merged and the order is chosen
so that data created early is reused later.

Each check lists **Steps**, **Expect** and **Verify** (where to look: run page,
CRM record, Slack channel, inbox, …). Tick the box when it passes; file a
failure as a `[QA]` task in the WeldConnect project (search first, add retests
as comments).

User guides for the same features: help.weldsuite.org/weldconnect
(`apps/web/docs/src/app/weldconnect/`). Plan and history:
`docs/plans/weldconnect.md`.

---

## 0. Prerequisites

### Workspace and people

- [ ] An isolated **QA workspace** on app-test.weldsuite.org (switch via user
      menu → Workspace). Never test in a customer or team workspace: test runs
      are real runs.
- [ ] **Two members**: **A** = you (Owner/Admin, the owner of most workflows
      below) and **B** = a second account (Member role) for approvals and
      permission refusals. The production QA workspace has a single member, so
      invite B on test first.
- [ ] A **custom role "QA restricted"** for B that keeps WeldConnect access
      (create/update workflows) but lacks **Create leads** and **Update
      opportunities** (used in E2).
- [ ] **Email**: send every test email to **weldhost@gmail.com** only, and use a
      unique subject per check (`[QA WC] <check id> <time>`) because other QA
      sessions share that inbox. Contacts/leads that receive nothing may use
      `@example.com` addresses.
- [ ] A **WeldMail account** connected in the workspace (Send Email uses it).
- [ ] A **WeldFlow project** "QA WeldConnect" and a **WeldChat** public channel
      `#qa-weldconnect` plus a private channel `#qa-private` that B is **not** a
      member of.
- [ ] A **CRM pipeline** with at least three stages including a won and a lost
      stage.
- [ ] A terminal with `curl` and `openssl` (for webhook calls and signatures).

### Deploy state (test)

- [ ] `develop` at or after the #906 merge is deployed to test
      (connect-api, workflow-worker, platform).
- [ ] Master migration `0048` (webhook registry), tenant migration
      `0199_far_tomas` (workflow versions, one-time schedules) and D1 migration
      `apps/workers/workflow-worker/migrations/d1/0003_schedule_index_one_time.sql`
      applied (CI does this on deploy; check the deploy log if one-time
      schedules or History fail).

### Secrets that must be set on `workflow-worker` (env `test`)

Check with `wrangler secret list --env test` in `apps/workers/workflow-worker`
(source of truth: `scripts/secrets/manifest.ts`; sync with `secrets:sync`).

| Secret | Needed for | Symptom when missing |
| --- | --- | --- |
| `DATABASE_URL_MASTER` | Tenant DB lookup for every action | Every WeldSuite step fails |
| `NEON_API_KEY` | Tenant DB lookup | Every WeldSuite step fails |
| `DATABASE_ENCRYPTION_KEY` | Decrypting stored tenant DB URLs and integration tokens | Every WeldSuite / app step fails |
| `AI_GATEWAY_API_TOKEN` (else `CLOUDFLARE_API_TOKEN`) | AI steps | AI steps fail; credit metering silently off (fail-open) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Refreshing Google tokens (they expire after ~1 h) | Google steps work for an hour after connecting, then fail |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | Minting GitHub installation tokens | GitHub steps fail |
| `INTERNAL_API_SECRET` | Worker → connect-api internal calls | WeldSuite steps fail with 401 |

On **connect-api** (test): `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_APP_ID` /
`GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_SLUG` (already set for WeldFlow's GitHub
sync). `PUBLIC_APP_URL` must resolve to `https://app-test.weldsuite.org`
(fixed in #894).

### Third-party configuration

- [ ] **Slack app** (behind `SLACK_CLIENT_ID`): redirect URL
      `https://app-test.weldsuite.org/weldconnect/integrations/callback`
      registered (and `https://app.weldsuite.org/weldconnect/integrations/callback`
      for production); bot scopes `chat:write`, `channels:read`, `commands`. A
      Slack workspace you can test in, with a public and a private channel.
- [ ] **Google Cloud OAuth client** (behind `GOOGLE_CLIENT_ID`): authorised
      redirect URI `https://app-test.weldsuite.org/weldconnect/integrations/callback`
      (plus production). Consent screen scopes: `.../auth/spreadsheets`,
      `.../auth/gmail.send` (**not** `gmail.readonly`),
      `.../auth/calendar.events`, `.../auth/calendar.calendarlist.readonly`,
      `openid`, `email`, `profile`. While the consent screen is in "Testing",
      add the Google account you test with as a test user. A scratch
      spreadsheet with a header row, and a scratch calendar.
- [ ] **GitHub App**: installed for the QA workspace via **Settings →
      Integrations → GitHub** with access to a scratch repository (issues
      enabled). Optionally a second repository with issues disabled (N4).

---

## A. Navigation and sections

- [ ] **A1. Sidebar**
  - Steps: open WeldConnect.
  - Expect: sidebar shows Overview, Workflows, Executions, then Variables,
    Webhooks, then Analytics. Actions, Triggers and Templates are **not** in the
    sidebar.
  - Verify: sidebar.
- [ ] **A2. Integrations page**
  - Steps: open `/weldconnect/integrations`.
  - Expect: cards for Slack, Google Sheets, Gmail, Google Calendar, GitHub (and
    the not-yet-usable Teams, Notion, Airtable, Asana, Twilio). No sidebar link
    exists (known, see plan "Still open").
  - Verify: page.

---

## B. Webhook trigger, HTTP request, notifications (#862, #861)

- [ ] **B1. QA Source: webhook URL appears on save**
  - Steps: Workflows → New Workflow "QA Source". Trigger **Webhook**. Add **Send
    Notification** to yourself, title `Webhook {{trigger.body.orderId}}`. Save.
  - Expect: the trigger panel shows a **Webhook URL** right after saving;
    **Require signature** is off.
  - Verify: trigger panel.
- [ ] **B2. Inactive workflow refuses calls**
  - Steps: before publishing, `curl -X POST "<URL>" -H "Content-Type: application/json" -d '{"orderId":"QA-0"}'`.
  - Expect: HTTP 404 (`Workflow not found or not active`, or `Webhook not
    found or disabled`); no run.
  - Verify: curl output, Executions.
- [ ] **B3. Webhook starts a run**
  - Steps: Publish. Repeat the curl with `{"orderId":"QA-1"}`.
  - Expect: `{"success":true,"executionId":"wex_…"}`; a Completed run with
    trigger Webhook; you get the bell notification "Webhook QA-1".
  - Verify: run page → Input Data shows `body`, `headers`, `query`; bell.
- [ ] **B4. Signature required**
  - Steps: turn on **Require signature**; copy the secret shown once (it is not
    shown again). Call without a signature, then with one:
    ```bash
    BODY='{"orderId":"QA-2"}'
    SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
    curl -X POST "$URL" -H "Content-Type: application/json" -H "X-Webhook-Signature: $SIG" -d "$BODY"
    ```
  - Expect: without → 401 `Missing signature`; wrong value → 401 `Invalid
    signature`; correct (also with a `sha256=` prefix) → success and a run.
    Turn signing off again: unsigned calls work.
  - Verify: curl output, Executions.
- [ ] **B5. Body size limit**
  - Steps: POST a body over 1 MB.
  - Expect: 413 `Payload too large`; no run.
  - Verify: curl output.
- [ ] **B6. Webhooks page** (#891 QA 11)
  - Steps: WeldConnect → Webhooks.
  - Expect: QA Source's webhook with its full absolute URL and call count;
    **Delete** is refused (managed by the trigger, "change or remove it from the
    trigger"); the detail page lists only runs this webhook started.
  - Verify: Webhooks list and detail.
- [ ] **B7. HTTP Request**
  - Steps: new workflow "QA HTTP" (Webhook trigger): **HTTP Request** GET
    `https://httpbin.org/json`, then **Send Notification** with
    `{{steps.<http>.status}}`. Publish, call. Then change the URL to
    `https://httpbin.org/status/404`, then to `http://localhost/x`.
  - Expect: 1st run Completed, output has `status: 200`, `ok: true`, parsed
    `body`. 404 → step Failed (no retry loop). localhost → step Failed with a
    private-network refusal.
  - Verify: run page → step output / error.
- [ ] **B8. Send Notification recipients**
  - Steps: in QA HTTP, set recipients to A and B; run. Then clear recipients
    and run.
  - Expect: both get the notification live (no reload); with no recipients the
    owner (A) gets it.
  - Verify: bell of A and B.

---

## C. WeldSuite steps as the owner (#861, #864, #869, #870)

Create **"QA CRM"** (owner A, Webhook trigger) with these steps in order, using
the webhook body `{"company":"QA Corp <time>","email":"qa+<time>@example.com","first":"Ada","last":"QA"}`:

1. Create Company: name `{{trigger.body.company}}`, email `{{trigger.body.email}}`, status Prospect, "Skip if a company with this email exists" on.
2. Create Contact: first/last/email from the body, Company `{{steps.<1>.customerId}}`, tags `qa`, "Reuse a contact with the same email" on.
3. Create Lead: email from the body, company name from the body, source `weldconnect-qa`.
4. Create Deal: name `QA deal {{trigger.body.company}}`, Company `{{steps.<1>.customerId}}`, value 1000, pipeline + first stage.
5. Move Deal Stage: deal `{{steps.<4>.dealId}}`, second stage.
6. Log Activity: type Call, subject `QA call`, Company + Contact + Deal from earlier steps.
7. Create Task: project "QA WeldConnect", title `Follow up {{trigger.body.company}}`, assignee B, due "In 3 days", priority High, label `qa`.
8. Post Chat Message: `#qa-weldconnect`, `New QA company {{trigger.body.company}}`.
9. Send Email: to weldhost@gmail.com, subject `[QA WC] C1 {{trigger.body.company}}`, body with `{{steps.<7>.url}}`.

- [ ] **C1. Full run**
  - Steps: publish, call the webhook once.
  - Expect: run Completed, 9/9 steps.
  - Verify: WeldCRM → company (owner A), contact linked to it, lead, deal in
    the second stage with the activity on its timeline; WeldFlow → task assigned
    to B, due in 3 days (B gets the assignment notification); WeldChat
    `#qa-weldconnect` shows the message with the workflow icon + **Workflow**
    badge, not as A, and it is not clickable; inbox weldhost@gmail.com has the
    email from the WeldMail account with a working task link.
- [ ] **C2. Reuse instead of duplicates**
  - Steps: call again with the same body.
  - Expect: Create Company output `created: false` (same `customerId`); Create
    Contact `created: false`; no duplicate company/contact in CRM. (Lead and
    deal are created again; that's by design.)
  - Verify: run page step outputs; CRM lists.
- [ ] **C3. Move to won/lost**
  - Steps: point Move Deal Stage at the won stage, run; then the lost stage.
  - Expect: deal marked won, then lost, same as dragging on the board.
  - Verify: deal record.
- [ ] **C4. Send Email address validation**
  - Steps: set To to `not-an-address`, run.
  - Expect: step fails at once with `Recipient address "not-an-address" is not
    valid`; no email sent; run Failed (this run feeds the error log in K4).
  - Verify: run page; inbox has nothing new.
- [ ] **C5. Record event + Update Contact** (entity_event, update_contact)
  - Steps: new workflow "QA Update contact": trigger **Entity Event** →
    Contact → created. Step **Update Contact**: contact `{{trigger.record.id}}`,
    Job title `QA updated`. Publish. Create a contact by hand in WeldCRM (or
    call QA CRM with a new email).
  - Expect: a run appears 10 to 45 s later and completes; only the job title
    changes, other fields keep their values.
  - Verify: Executions (poll before calling it broken); contact record.
- [ ] **C6. Test dialog on a record-event workflow**
  - Steps: in QA Update contact click **Test**, edit the sample record JSON
    (use the id of a real contact), **Run test**.
  - Expect: "Test run started"; run with the **Test** badge updates that
    contact.
  - Verify: Executions; contact.

---

## D. Logic: conditions, loops, delays (#860)

Create **"QA Logic"** (Webhook trigger).

- [ ] **D1. Condition branches**
  - Steps: Condition `{{trigger.body.amount}}` **Greater Than** `100`. Under
    **If true**: Send Notification "big"; under **If false**: Send Notification
    "small". **Add step after this condition**: Send Notification "after".
    Publish, call with `{"amount":150}`, then `{"amount":50}`.
  - Expect: 150 → "big" + "after", the If false step is **Skipped**; 50 →
    "small" + "after". Progress reaches 100%.
  - Verify: run page step statuses; bell.
- [ ] **D2. Operators**
  - Steps: switch to **Is Empty** on `{{trigger.body.missing}}`, then **Matches
    Regex** with an invalid pattern `(`.
  - Expect: Is Empty → If true; invalid regex → step Failed (never a silent
    pass).
  - Verify: run page.
- [ ] **D3. Loop**
  - Steps: replace with a Loop over `{{trigger.body.items}}`; under **For each
    item**: Send Notification `Item {{loop.index}}: {{loop.item.name}}`. Call
    with 3 items.
  - Expect: 3 notifications with index 0, 1, 2; the loop body step shows one
    row summarising the iterations; loop output `count: 3`.
  - Verify: bell; run page.
- [ ] **D4. Loop limits**
  - Steps: call with 101 items.
  - Expect: loop fails with "The list has 101 items; a loop can run over at most
    100". (250 iterations per run: a nested 20 × 20 loop fails with "This run
    reached the limit of 250 loop iterations".)
  - Verify: run page error.
- [ ] **D5. Publish gate for structure**
  - Steps: add a Loop with no steps under it and publish.
  - Expect: blocked: "A loop has no steps to repeat. Add steps under "For each
    item"."
  - Verify: editor checklist / toast.
- [ ] **D6. Delay**
  - Steps: QA Logic: Delay 1 minute before the last notification. Call.
  - Expect: run stays **Running** for ~1 min, then completes; one step row per
    step (no duplicates after the wait). A Delay of 400 days fails with "A delay
    can wait at most 365 days".
  - Verify: run page.

---

## E. Owner permissions at run time (#861, #869, #870)

- [ ] **E1. Owner hint**
  - Steps: open any WeldSuite step form.
  - Expect: "The workflow acts as its owner: it can only do what the owner's
    role allows."
  - Verify: step panel.
- [ ] **E2. Refused for a restricted owner**
  - Steps: as **B** (role "QA restricted"), create "QA B lead" (Webhook): Create
    Lead. Publish, call.
  - Expect: step Failed with a readable permission message (not retried, no
    lead created). Same for a Move Deal Stage on a deal B doesn't own.
  - Verify: run page; CRM.
- [ ] **E3. Permission removed later**
  - Steps: give B **Create leads**, run (passes); remove it again, run.
  - Expect: second run fails: the check happens at run time.
  - Verify: run page.
- [ ] **E4. Private channel**
  - Steps: as B, workflow with Post Chat Message to `#qa-private`.
  - Expect: step fails (B can't see the channel). Add B to the channel → passes.
  - Verify: run page; WeldChat.
- [ ] **E5. Update Contact scope**
  - Steps: as B (without "see all contacts"), Update Contact on a contact owned
    by A.
  - Expect: refused.
  - Verify: run page; contact unchanged.

---

## F. Schedules (#859, #906)

- [ ] **F1. Recurring**
  - Steps: "QA Schedule": Schedule → Recurring → Every 5 minutes, timezone
    Europe/Amsterdam; Send Notification with `{{trigger.scheduledTimeLocal}}`.
    Publish.
  - Expect: "Next run" shown in the panel; a run every 5 minutes; the time in
    the notification is Amsterdam time. Pause after two runs: no more runs.
  - Verify: Executions; bell.
- [ ] **F2. Invalid cron**
  - Steps: Custom cron expression `61 * * * *`.
  - Expect: inline error and publish blocked ("The schedule has an invalid cron
    expression…").
  - Verify: editor.
- [ ] **F3. One-time** (#906)
  - Steps: Schedule → **One-time**, Execute At = now + 3 min, timezone; any
    valid step. Publish.
  - Expect: exactly one run around that time, never again; pausing and
    publishing again does not re-fire it.
  - Verify: Executions (wait 10 more minutes).
- [ ] **F4. One-time in the past**
  - Steps: set Execute At in the past, publish.
  - Expect: refused: "The one-time schedule's date and time is in the past.
    Choose a time in the future."
  - Verify: editor.

---

## G. After another workflow (#891 QA 2 to 4)

- [ ] **G1. Setup**
  - Steps: "QA Follow-up": trigger **After another workflow** (tile **Workflow
    Complete**), source **QA Source**, **Success only**, **Pass output data**
    on. Add Send Notification; open the variable picker.
  - Expect: Trigger Data lists Previous workflow, Previous run ID, Completion
    Status and "Send notification: Sent / Notification IDs…". Publish succeeds.
  - Verify: variable picker.
- [ ] **G2. Chain runs**
  - Steps: call QA Source's webhook.
  - Expect: a QA Source run and right after it a QA Follow-up run with trigger
    "After another workflow"; Input Data has `sourceWorkflowName: "QA
    Source"`, `status: "success"` and `output`.
  - Verify: Executions; run page.
- [ ] **G3. Test runs don't chain**
  - Steps: click **Test** in QA Source.
  - Expect: no QA Follow-up run.
  - Verify: Executions.
- [ ] **G4. Gate**
  - Steps: clear the source and publish; choose QA Follow-up itself; then make
    a throwaway "QA Source 2", chain to it, delete it, re-publish.
  - Expect: "Choose the workflow this one runs after." / "A workflow cannot run
    after itself…" / "…no longer exists…".
  - Verify: editor.

---

## H. Approvals (#891 QA 5 to 9; needs B)

- [ ] **H1. Setup and nesting rule**
  - Steps: "QA Approval" (Webhook): **Approval** (title "Approve refund",
    instructions, approver B), then a Condition on "Approval: Approved" equals
    `true` with a Send Notification in each branch. Drag an Approval into a
    branch.
  - Expect: the nested approval shows "An approval step cannot sit inside a
    branch or a loop…" and Publish is blocked. Remove it, publish.
  - Verify: editor.
- [ ] **H2. Waiting**
  - Steps: call the webhook.
  - Expect: run status **Waiting for approval** (amber) in the list; the
    Status filter "Waiting for approval" finds it; run page shows the approval
    panel with "Approvers: B"; as A: "Only the approvers of this step can
    decide."; B gets a bell notification "Approve refund" that opens the run.
  - Verify: Executions, run page, B's bell.
- [ ] **H3. Decide**
  - Steps: as B, comment and **Reject**. Run again and **Approve**. Click again
    on a decided approval.
  - Expect: "Rejected…" toast; within ~15 s the run continues and completes;
    approval output `approved: false, decision: "rejected", comment,
    decidedBy`; the If false branch ran. Approve → If true branch. Second click
    → "Someone already decided on this approval".
  - Verify: run page step output; bell.
- [ ] **H4. No approvers**
  - Steps: clear the approvers, publish, run.
  - Expect: A (owner) is notified; a member with "update workflow runs"
    permission sees Approve/Reject, one without it doesn't.
  - Verify: run page as both.
- [ ] **H5. Cancel while waiting**
  - Steps: start a run, **Cancel** on the run page while it waits.
  - Expect: Cancelled, and it stays Cancelled (no later flip to
    completed/failed, no follow-up chained). Expiry after 7 days ("Approval
    expired: nobody approved or rejected this step within 7 days") is not
    testable quickly.
  - Verify: run page after a few minutes.

---

## I. AI steps and the credit cap (#892)

- [ ] **I1. Configure**
  - Steps: "QA AI" (Webhook): **AI Generate** with a prompt using
    `{{trigger.body.text}}`; **AI Classify** with 3 categories. Publish.
  - Expect: saves and publishes without an "unsupported" error.
  - Verify: editor.
- [ ] **I2. Run and meter**
  - Steps: call with some text. Note the credit balance before and after.
  - Expect: Generate output has `text` and `creditsUsed`; Classify has
    `category`, `confidence`, `reasoning`; balance drops slightly.
  - Verify: run page; Settings → Billing.
- [ ] **I3. Cap**
  - Steps: workflow Settings → Quotas → "Maximum credits used per run" = `1`,
    Save, run again.
  - Expect: the AI step fails with a message naming the cap; earlier non-AI
    steps still ran. Enter `0` or `abc`: "Enter a whole number between 1 and
    100,000, or leave it empty".
  - Verify: run page; settings form.
- [ ] **I4. No cap**
  - Steps: clear the field, Save, run.
  - Expect: AI steps succeed again.
  - Verify: run page.

---

## J. Concurrency and version history (#906)

- [ ] **J1. Concurrency limit**
  - Steps: QA Logic (has a 1-minute Delay): Settings → Concurrency → "Maximum
    concurrent runs" = 1, Save. Call the webhook twice quickly.
  - Expect: first run proceeds; second is recorded as **Skipped** (filterable)
    and the webhook response contains `"skipped": true`. A **Test** run while
    one is in flight is not skipped. Clear the field: both run.
  - Verify: Executions; curl output.
- [ ] **J2. Versions are recorded**
  - Steps: open QA CRM (active): Settings → **History**. Add a step and publish
    the change; rename the workflow.
  - Expect: first version reason **Activated**; a new **Saved** version for the
    step change and for the rename. Draft-only edits of a never-activated
    workflow create no versions.
  - Verify: Version history dialog.
- [ ] **J3. Restore**
  - Steps: restore the version before the added step; confirm.
  - Expect: "Restored version N"; the step is gone; a new version with reason
    **Restored** appears.
  - Verify: editor; History.
- [ ] **J4. Restore refused by the gate**
  - Steps: on an active workflow, restore a version that would fail activation
    now (for example one with a one-time schedule in the past, or an app step
    whose app was disconnected).
  - Expect: refused: "This version uses triggers or actions this workflow can
    no longer use while active." Nothing changes.
  - Verify: dialog; editor.
- [ ] **J5. Restore re-syncs the schedule**
  - Steps: on QA Schedule, change the trigger to a webhook, publish; restore
    the recurring-schedule version.
  - Expect: the schedule fires again without a manual save.
  - Verify: Executions.

---

## K. Runs, errors, variables, notifications (#859, #891)

- [ ] **K1. Cancel a running run**
  - Steps: call QA Logic (1-minute Delay) and **Cancel** on the run page
    within the minute.
  - Expect: "Execution cancelled successfully"; status Cancelled and it stays
    so after the delay would have ended; no "after" notification.
  - Verify: run page; bell.
- [ ] **K2. Cancel a finished run**
  - Steps: try Cancel on a Completed run (row menu).
  - Expect: refused, not a fake success.
  - Verify: toast / run status.
- [ ] **K3. Retry**
  - Steps: on the failed C4 run, fix the address and click **Retry**. Pause QA
    CRM and retry another failed run.
  - Expect: a new run linked with **Retry of**; while paused: "Activate the
    workflow first, then retry this execution."
  - Verify: run page.
- [ ] **K4. Error log** (#891 QA 12)
  - Steps: Analytics → Errors.
  - Expect: C4's failure listed under **Open** with severity Error and **View
    run**; **Acknowledge** moves it to **All**; **Acknowledge all** clears
    Open. Numbers exclude Test runs.
  - Verify: Analytics.
- [ ] **K5. Variables** (#891 QA 10)
  - Steps: Variables → Create Variable: global `qa_greeting`, then a workflow
    variable `qa_secret` (Secret on) for QA HTTP; try a duplicate name; edit
    and delete one. Use `{{variables.qa_greeting}}` in a notification.
  - Expect: duplicate refused with "A variable with this name already exists
    for these workflows"; a secret's value can't be revealed after saving; the
    variable resolves in a run.
  - Verify: Variables page; bell.
- [ ] **K6. Run notifications**
  - Steps: QA CRM → Settings → Notifications: keep "fails" on, turn
    "completes" on, Save; run once OK and once failing.
  - Expect: A (owner) gets an in-app notification for both. Turn "fails" off:
    no notification for a failure.
  - Verify: bell.
- [ ] **K7. Unknown step types fail**
  - Steps: only if an old workflow with a removed step type exists.
  - Expect: the step fails instead of passing silently.
  - Verify: run page.

---

## L. Slack (#894)

- [ ] **L1. Connect**
  - Steps: Integrations → Slack → **Connect**; allow in Slack.
  - Expect: back on `app-test.weldsuite.org/weldconnect/integrations` (not
    production), card **Connected**.
  - Verify: Integrations page.
- [ ] **L2. Test connection**
  - Steps: **Test**.
  - Expect: "Connection test passed" showing the Slack team name.
  - Verify: toast.
- [ ] **L3. Post to a channel**
  - Steps: "QA Slack" (Webhook): **Slack: Post Message**; channel dropdown
    loads real channels; message `QA {{trigger.body.orderId}} *bold*`. Invite
    the app to a public channel, publish, call.
  - Expect: message appears; output `ok`, `channel`, `ts`, `permalink`.
  - Verify: Slack channel; run page.
- [ ] **L4. Not invited**
  - Steps: post to a private channel without inviting the app (also try a
    public one without the invite and note what happens).
  - Expect: step fails with "WeldSuite's Slack app hasn't been invited to this
    channel yet…", not a generic failure.
  - Verify: run page.
- [ ] **L5. Thread reply**
  - Steps: second Slack step with **Reply to thread** `{{steps.<first>.ts}}`.
  - Expect: the second message is a reply in the first one's thread.
  - Verify: Slack.
- [ ] **L6. Gate on disconnect**
  - Steps: Disconnect Slack, then publish a workflow with a Slack step;
    reconnect and publish again.
  - Expect: refused while disconnected (`integration_not_connected`), accepted
    after reconnecting.
  - Verify: editor.

---

## M. Google Sheets, Gmail, Calendar (#904)

- [ ] **M1. Connect Google Sheets**
  - Steps: Integrations → Google Sheets → Connect.
  - Expect: consent asks only for spreadsheets (plus basic profile/email).
    Connected; Test passes.
  - Verify: Google consent screen; card.
- [ ] **M2. Append Row**
  - Steps: "QA Sheets": **Google Sheets: Append Row**, paste the spreadsheet
    link (title resolves, Sheet dropdown lists the tabs), columns A =
    `{{trigger.body.orderId}}`, C = `QA`. Call.
  - Expect: new row with A and C filled, B empty.
  - Verify: spreadsheet.
- [ ] **M3. Update Row**
  - Steps: **Update Row** by row number (row 2), then by lookup (column A =
    the orderId from M2), mapping only column C.
  - Expect: only column C changes in the target row; other cells untouched.
  - Verify: spreadsheet.
- [ ] **M4. Gmail**
  - Steps: connect Gmail: consent shows only "Send email on your behalf" (not
    "read, compose, send and permanently delete"). **Gmail: Send Email** to
    weldhost@gmail.com, subject `[QA WC] M4 html` with Body is HTML on, then
    off. Then To `bad@`.
  - Expect: two emails sent from the connected Gmail account, HTML rendered vs
    plain text; invalid address fails before any send.
  - Verify: inbox weldhost@gmail.com; run page.
- [ ] **M5. Calendar**
  - Steps: connect Google Calendar: consent shows calendar events + "See your
    calendars". **Google Calendar: Create Event** on the scratch calendar,
    start `2026-12-01T09:00:00`, end `2026-12-01T09:30:00`, time zone
    `America/New_York`, attendee weldhost@gmail.com.
  - Expect: event at 09:00 New York time (15:00 Amsterdam), not shifted;
    invitation reaches the inbox.
  - Verify: Google Calendar; inbox.
- [ ] **M6. Token refresh and revoke**
  - Steps: run a Google step more than an hour after connecting (or back-date
    the connection's `expiresAt`). Then remove WeldSuite's access in the Google
    account and run again.
  - Expect: refresh is silent; after revoking, a clear "reconnect" error, not a
    generic failure.
  - Verify: run page.
- [ ] **M7. Gate**
  - Steps: publish a workflow with a Gmail step before Gmail is connected.
  - Expect: refused with `integration_not_connected`.
  - Verify: editor.

---

## N. GitHub (#905)

- [ ] **N1. Connect without redirect**
  - Steps: Integrations → GitHub → **Connect**.
  - Expect: **Connected** with no browser redirect. Without an installation:
    "No GitHub App installation found for this workspace…".
  - Verify: card / toast.
- [ ] **N2. Test**
  - Steps: **Test**.
  - Expect: success, mentions the installed account's login.
  - Verify: toast.
- [ ] **N3. Create Issue and Comment**
  - Steps: "QA GitHub": **GitHub: Create Issue** (repo picker lists the
    scratch repo; title/body with variables, labels `qa`, assignee your login),
    then **GitHub: Create Comment** on `{{steps.<issue>.number}}`. Call.
  - Expect: issue with the right title, body, label and assignee; comment on
    it; outputs `{ ok, number, url }` and `{ ok, id, url }`.
  - Verify: GitHub repo; run page.
- [ ] **N4. Error paths**
  - Steps: unknown repo; unknown assignee login; repo with issues disabled.
  - Expect: 404 "not found" message; GitHub's own 422 validation message;
    "issues disabled" message. All fail without retry.
  - Verify: run page.
- [ ] **N5. Revoked installation**
  - Steps: suspend the installation on GitHub (or point the step at a bogus
    connection), run.
  - Expect: clear "reconnect" message.
  - Verify: run page.
- [ ] **N6. Gate**
  - Steps: disconnect GitHub in WeldConnect, publish a workflow with a GitHub
    step.
  - Expect: refused in the editor with a clear message.
  - Verify: editor.

---

## O. Owner leaves, translations

- [ ] **O1. Owner left the workspace** (optional, destructive)
  - Steps: B owns a published workflow with a WeldSuite step and a Slack step;
    remove B from the workspace; trigger it.
  - Expect: both steps refuse (owner no longer a member). **Duplicate** as A
    makes A the owner of a draft copy that works after publishing.
  - Verify: run page.
- [ ] **O2. Dutch**
  - Steps: switch the account language to Nederlands (the `locale` cookie is
    rewritten from the profile, so change it in the profile) and walk the
    editor, trigger panels, step forms, Executions statuses (Waiting for
    approval, Skipped), Settings (Quotas, Concurrency, History), Integrations.
  - Expect: no raw keys or English fallbacks.
  - Verify: screens.

---

## Known limits (expected behaviour, don't file)

- 100 items per loop, 250 loop iterations per run.
- Delays up to 365 days; while a delay waits the run shows Running.
- Approvals expire after 7 days and must sit in the main flow (not in a branch
  or loop).
- Webhook bodies up to 1 MB; `http_request` times out after 30 s (max 120 s),
  responses over 1 MB are truncated, private-network targets are refused.
- Record-event chains stop at depth 3; "After another workflow" chains at
  depth 10. Test and cancelled runs don't chain.
- The concurrency limit is best-effort and does not yet apply to runs started
  by "After another workflow" (or integration events).
- Steps have no automatic retry by default; a failed step fails the run. Use
  Retry on the run.
- Version history has no diff view, and a run doesn't link to the version that
  produced it.
- `/weldconnect/integrations` has no sidebar entry; Teams, Notion, Airtable,
  Asana and Twilio cards are shown but have no usable steps; integration-event
  and poll triggers are not available.
- Templates are hidden while `feat/weldconnect-templates` rebuilds them.
- Without `AI_GATEWAY_API_TOKEN` / metering secrets, AI steps run unmetered
  (fail-open) instead of failing.
