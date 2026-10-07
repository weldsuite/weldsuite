---
title: Triggers
nextjs:
  metadata:
    title: Triggers
    description: Start WeldConnect workflows from record events, recurring or one-time schedules, webhooks, or when another workflow finishes.
screenshots_todo:
  - file: weldconnect-trigger-entity-event.png
    shows: Trigger panel for an Entity Event trigger with Entity Type (e.g. Lead) and Event (e.g. created) selected
  - file: weldconnect-trigger-schedule.png
    shows: Trigger panel for a Schedule trigger, Recurring, preset "Every weekday at 9:00 AM", Timezone and the "Next run" line
  - file: weldconnect-trigger-one-time.png
    shows: Trigger panel for a Schedule trigger set to One-time with Execute At and Timezone
  - file: weldconnect-trigger-webhook.png
    shows: Trigger panel for a saved Webhook trigger showing the Webhook URL, copy button and the Require signature toggle
  - file: weldconnect-trigger-after-workflow.png
    shows: Trigger panel for "After another workflow" with Source Workflow, Trigger On and Pass output data
---

The trigger decides when a workflow runs. Every workflow has exactly one. {% .lead %}

Select the trigger at the top of the canvas to change it. WeldConnect offers four triggers: **Entity Event**, **Schedule**, **Webhook** and **After another workflow**.

---

## Record events

Use **Entity Event** to react to changes in WeldSuite: a new lead, an updated deal, a deleted ticket.

1. Choose the **Entity Type**, for example **Lead**, **Contact**, **Opportunity**, **Ticket**, **Order** or **Task**.
2. Choose the **Event**: **created**, **updated** or **deleted**, plus record-specific events such as a deal's stage change, won or lost.

An **updated** trigger runs on every change to a record of that type, whichever field changed. Use a [Condition](/weldconnect/logic-steps#conditions) as the first step to act only on the changes you care about.

Variables you can use in the steps:

| Variable | Contains |
| --- | --- |
| `{{trigger.record.<field>}}` | A field of the record, for example `{{trigger.record.email}}` |
| `{{trigger.recordId}}` | The record's ID |
| `{{trigger.previousRecord}}` / `{{trigger.changes}}` | The record before the change, and the changed fields (updates only) |

{% callout title="Workflows that trigger each other" %}
A workflow can change records that start other workflows (or itself). To prevent endless loops, a chain of record-event workflows stops after three levels.
{% /callout %}

---

## Schedules

Use **Schedule** to run a workflow at set times. Choose the **Schedule Type**.

### Recurring

1. Pick a **Schedule** preset (**Every 5 minutes**, **Every hour**, **Every day at 9:00 AM**, **Every weekday at 9:00 AM**, **Every Monday at 9:00 AM**, **First of every month**) or **Custom cron expression**.
2. For a custom schedule, enter a **Cron Expression** with five fields: minute, hour, day, month, weekday. For example `0 9 * * 1-5` is 9:00 on weekdays.
3. Choose the **Timezone**. The schedule follows that timezone, including daylight saving changes.

The panel shows the **Next run** so you can check the schedule before publishing.

### One-time

1. Switch **Schedule Type** to **One-time**.
2. Pick the date and time under **Execute At**.
3. Choose the **Timezone** the date and time are in.

The workflow runs once at that moment and never again, even if you pause and publish it later. The date must be in the future when you publish; a past date blocks publishing.

Variables: `{{trigger.scheduledTime}}` (UTC) and `{{trigger.scheduledTimeLocal}}` (in the schedule's timezone).

---

## Webhook

Use **Webhook** to start a workflow from another system: a form tool, a payment provider, your own app.

1. Choose **Webhook** and click **Save**. A unique **Webhook URL** appears in the trigger panel.
2. Copy the URL and configure the other system to send a **POST** request to it with a JSON body.
3. **Publish** the workflow. Calls to the URL only start runs while the workflow is active.

Try it from a terminal:

```shell
curl -X POST "<your webhook URL>" \
  -H "Content-Type: application/json" \
  -d '{"orderId": "1042", "customer": {"email": "jane@example.com"}}'
```

The response contains the ID of the run that started: `{"success": true, "executionId": "…"}`. Requests larger than 1 MB are refused.

### Use the request data

| Variable | Contains |
| --- | --- |
| `{{trigger.body.<field>}}` | A field of the JSON body, for example `{{trigger.body.customer.email}}` |
| `{{trigger.headers.<name>}}` | A request header (lowercase name), for example `{{trigger.headers.user-agent}}` |
| `{{trigger.query.<name>}}` | A query string parameter of the URL |

### Require a signature (optional)

By default, the URL itself is the credential: it is long and unguessable, so keep it private. For extra protection, turn on **Require signature** in the trigger panel.

1. Turn on **Require signature**. WeldConnect shows the **Webhook Secret** once. Copy it and store it in the sending system.
2. The sender must compute an HMAC-SHA256 of the raw request body, keyed with the secret, and send it as a hex string in the `X-Webhook-Signature` header (a `sha256=` prefix is also accepted).
3. Requests without a valid signature are refused.

Turn the toggle off and on again to get a new secret; the old one stops working immediately.

### The Webhooks page

**WeldConnect** → **Webhooks** lists every webhook URL with its linked workflow, number of calls and last call. Open one to see its recent events and the run each call started. A URL that belongs to a workflow's Webhook trigger can't be deleted there: remove the trigger in the editor instead.

---

## After another workflow

Use **After another workflow** to chain workflows: run a follow-up when another workflow finishes. On an empty canvas this trigger is the **Workflow Complete** tile.

1. Choose the **Source Workflow**. A workflow can't run after itself.
2. Choose **Trigger On**: **Success only**, **Failure only** or **Both**.
3. Turn on **Pass output data** if the steps need the results of the run that finished.

Variables: `{{trigger.sourceWorkflowName}}`, `{{trigger.sourceWorkflowId}}`, `{{trigger.sourceExecutionId}}` and `{{trigger.status}}`. With **Pass output data** on, the variable picker also lists each step's output of the source workflow under **Trigger Data**.

Test runs and cancelled runs of the source workflow don't start the follow-up. If you delete the source workflow, the follow-up can't be published again until you choose another source.

---

## Next steps

- [Logic steps](/weldconnect/logic-steps)
- [WeldSuite steps](/weldconnect/weldsuite-steps)
- [Create a workflow](/weldconnect/create-workflow)
