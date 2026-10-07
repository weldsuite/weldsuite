---
title: WeldConnect
nextjs:
  metadata:
    title: WeldConnect
    description: Automate work across WeldSuite and connected apps with workflows, triggers, steps and run history.
screenshots_todo:
  - file: weldconnect-workflows-list.png
    shows: WeldConnect → Workflows list with a few active, paused and draft workflows
  - file: weldconnect-editor-overview.png
    shows: Workflow editor canvas with a trigger, a condition with If true / If false branches, and the Editor / Executions / Settings tabs and Test / Publish buttons visible
---

WeldConnect automates work across WeldSuite and the apps you connect. A workflow starts from a **trigger** (a record changes, a schedule fires, a webhook is called, another workflow finishes) and then runs its **steps** one after the other. {% .lead %}

{% quick-links %}

{% quick-link title="Create a workflow" icon="installation" href="/weldconnect/create-workflow" description="Build, test and publish your first workflow." /%}

{% quick-link title="Triggers" icon="presets" href="/weldconnect/triggers" description="Record events, schedules, webhooks and chained workflows." /%}

{% quick-link title="Logic steps" icon="plugins" href="/weldconnect/logic-steps" description="Conditions, loops, delays and approvals." /%}

{% quick-link title="Runs and history" icon="theming" href="/weldconnect/runs-and-history" description="Follow runs, fix failures and restore older versions." /%}

{% /quick-links %}

---

## What you can do

- **Workflows**: build automations in a visual editor, test them, then publish.
- **Triggers**: start a run when a record is created or changed, on a schedule, from a webhook call, or after another workflow finishes. See [Triggers](/weldconnect/triggers).
- **WeldSuite steps**: create companies, contacts, leads, deals and tasks, move deals, log activities, post to WeldChat, notify teammates, send email and call any API. See [WeldSuite steps](/weldconnect/weldsuite-steps).
- **Logic**: branch with conditions, repeat steps for each item in a list, wait, and pause for an approval. See [Logic steps](/weldconnect/logic-steps).
- **AI**: generate text or classify it inside a run, with a credit limit per run. See [AI steps](/weldconnect/ai-steps).
- **Apps**: post to Slack, write to Google Sheets, send from Gmail, create Google Calendar events and open GitHub issues. See [Connect apps](/weldconnect/connect-apps).
- **Runs**: every run is recorded with its status, input, output and errors. See [Runs and history](/weldconnect/runs-and-history).

The WeldConnect sidebar has **Overview**, **Workflows** and **Executions**, then **Variables** and **Webhooks**, and **Analytics**.

---

## A workflow acts as its owner

The person who created a workflow is its **owner**. Every run acts on the owner's behalf: a step can only do what the owner's role allows, and that is checked each time the step runs, not only when you publish.

- If the owner loses a permission (for example they can no longer create leads), steps that need it start failing with a clear message in the run.
- If the owner leaves the workspace, the workflow's WeldSuite steps and app steps stop working. To take a workflow over, open the row menu on **Workflows** and choose **Duplicate**: you become the owner of the copy, which starts as a draft. Publish the copy and delete the original.
- Steps that post to Slack, Google or GitHub use the **workspace's** connection to that app, not the owner's personal account. They still stop once the owner has left the workspace.

{% callout title="Tip" %}
Build workflows that the whole team relies on from an account that stays in the workspace and has the permissions those steps need. Ask an admin to check the role under [Team and permissions](/settings/team-and-permissions).
{% /callout %}

---

## Templates

WeldConnect is getting a new set of ready-made workflow templates. Until they are available, start from a blank workflow as described in [Create a workflow](/weldconnect/create-workflow).

---

## Connectors

WeldConnect **Connectors** import live data from first-party apps (Shopify, WooCommerce, Moneybird). After the first import, the provider pushes changes over webhooks; a periodic catch-up fills gaps.

- **Shopify / WooCommerce**: products, orders, and customers.
- **Moneybird**: contacts, sales invoices, products, and purchase invoices/receipts into WeldBooks. Moneybird stays the book of record: imported invoices and bills do not post to the WeldSuite ledger.

Connect them from **Settings** → **Integrations**.

---

## Next steps

- [Create a workflow](/weldconnect/create-workflow)
- [Connect Slack, Google and GitHub](/weldconnect/connect-apps)
- [WeldCRM overview](/weldcrm), a common source of record events
