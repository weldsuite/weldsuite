---
title: Create a workflow
nextjs:
  metadata:
    title: Create a workflow
    description: Build a WeldConnect workflow in the visual editor, use variables, test it and publish it.
screenshots_todo:
  - file: weldconnect-create-workflow-dialog.png
    shows: Workflows page with the Create Workflow dialog open (Workflow Name filled in)
  - file: weldconnect-choose-trigger.png
    shows: Empty editor canvas showing the "Choose a trigger" tiles (Entity Event, Schedule, Workflow Complete, Webhook)
  - file: weldconnect-add-step.png
    shows: The Add Step popover open on the canvas, with the Communication / Data / Logic & Flow / Integration / AI categories
  - file: weldconnect-variable-picker.png
    shows: A step's settings panel with the Variables picker open on Trigger Data
  - file: weldconnect-test-dialog.png
    shows: The "Test this workflow" dialog with a sample record and the Run test button
---

Build a workflow in the visual editor: pick a trigger, add steps, try it with a test run and publish it. {% .lead %}

---

## Before you start

- You need a role that can create and edit workflows in WeldConnect.
- Remember that a workflow [acts as its owner](/weldconnect#a-workflow-acts-as-its-owner): its steps can only do what your role allows.

---

## Create the workflow

1. Open **WeldConnect** → **Workflows**.
2. Click **New Workflow**.
3. Enter a **Workflow Name** (for example "Welcome new leads") and create it.

The editor opens. It has three tabs: **Editor** (the canvas), **Executions** (this workflow's runs) and **Settings**.

---

## Choose a trigger

An empty canvas shows **Choose a trigger**. Pick one:

| Trigger | Starts a run when |
| --- | --- |
| **Entity Event** | A record is created, updated or deleted (a contact, lead, deal, ticket, order, task, …) |
| **Schedule** | A recurring schedule fires, or once at a date and time |
| **Workflow Complete** | Another workflow finishes (shown as **After another workflow** in the trigger panel) |
| **Webhook** | An external system sends an HTTP request to the workflow's URL |

Fill in the trigger's settings in the side panel. [Triggers](/weldconnect/triggers) explains each one.

---

## Add steps

1. Click **+** under the trigger (or under any step) and choose **Add Step**.
2. Search or browse the categories: **Communication**, **Data**, **Logic & Flow**, **Integration** and **AI**.
3. Pick a step. Its settings open in the side panel.
4. Fill in the required fields. A step that still misses something shows **Setup required** on the canvas, and the toolbar shows how many steps are left **to set up**.

Steps run top to bottom. A **Condition** splits the flow into **If true** and **If false** branches, and a **Loop** has a **For each item** branch; see [Logic steps](/weldconnect/logic-steps). To continue after a condition or loop, select it and click **Add step after this condition** (or **Add step after this loop**).

To remove a step, select it and click **Delete Step**.

---

## Use data from earlier steps

Most fields accept **variables**: placeholders in double curly braces that are filled in when the step runs. Click **Variables** next to a field to pick one instead of typing it.

| Variable | What it contains |
| --- | --- |
| `{{trigger.record.email}}` | A field of the record that started an Entity Event workflow |
| `{{trigger.body.orderId}}` | A field of the JSON a webhook received |
| `{{steps.<step>.contactId}}` | The output of an earlier step (each step lists its outputs in the picker) |
| `{{loop.item}}` / `{{loop.index}}` | The current item and its position (starting at 0) inside a loop |
| `{{variables.api_base_url}}` | A workflow variable or secret (see below) |

The panel warns you when a field uses a variable that does not exist for this workflow; it would be left empty when the step runs.

### Variables and secrets

Use **WeldConnect** → **Variables** for values you reuse, like an API base URL or an API key.

1. Click **Create Variable**.
2. Enter a **Variable Name** in snake_case (for example `api_key`).
3. Choose the **Scope**: **Global** (available to all workflows) or **Workflow** (only the workflow you select).
4. Turn on **Secret** for API keys and passwords. A secret's value is never shown again after saving.
5. Enter the **Value** and save.

Use it in any field as `{{variables.api_key}}`.

---

## Test the workflow

1. Click **Save**.
2. Click **Test**. The **Test this workflow** dialog opens.
3. For an Entity Event trigger, edit the sample record the steps receive (as JSON).
4. Click **Run test**.

{% callout type="warning" title="A test is a real run" %}
A test run really executes the steps: emails are sent, records are created and messages are posted. Test with your own address and test data. A test always runs the last **saved** version.
{% /callout %}

Test runs show a **Test** badge in the run list. They don't count in Analytics, don't start workflows that run [after this one](/weldconnect/triggers#after-another-workflow), and are not limited by the concurrency setting.

---

## Publish

Click **Publish**. WeldConnect checks the workflow first: a missing trigger, a step without its required fields, a schedule in the past or an approval inside a branch all block publishing, with a message that tells you what to fix.

Once published, the workflow is **Active** and runs on its trigger.

- **Change a live workflow**: edit it and click **Publish changes**. Changes apply from the next run.
- **Pause**: click **Pause** to stop it from running. Click **Resume** to start it again.
- **Activate or pause from the list**: use the row menu on **Workflows**.

---

## Workflow settings

The **Settings** tab holds:

- **General**: name and description.
- **Quotas**: **Maximum credits used per run** for AI steps. See [AI steps](/weldconnect/ai-steps).
- **Concurrency**: **Maximum concurrent runs**. See [Runs and history](/weldconnect/runs-and-history#limit-concurrent-runs).
- **Notifications**: get notified when this workflow fails or completes.
- **History**: earlier versions of the workflow, with **Restore**. See [Version history](/weldconnect/runs-and-history#version-history).

Click **Save** after changing settings.

---

## Next steps

- [Triggers](/weldconnect/triggers)
- [WeldSuite steps](/weldconnect/weldsuite-steps)
- [Runs and history](/weldconnect/runs-and-history)
