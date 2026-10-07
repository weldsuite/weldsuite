---
title: WeldSuite steps
nextjs:
  metadata:
    title: WeldSuite steps
    description: Create and update CRM records, create tasks, post to WeldChat, notify teammates, send email and call APIs from a WeldConnect workflow.
screenshots_todo:
  - file: weldconnect-step-create-contact.png
    shows: Create Contact step settings with first name, last name and email mapped to trigger variables, and the owner-permission hint
  - file: weldconnect-step-create-deal.png
    shows: Create Deal step settings with the Pipeline and Stage pickers
  - file: weldconnect-step-create-task.png
    shows: Create Task step settings with Project, Assignees and the Due date quick picks
  - file: weldconnect-chat-workflow-message.png
    shows: A WeldChat channel showing a message posted by a workflow, with the Workflow badge
---

WeldSuite steps work with your own data: CRM records, WeldFlow tasks, WeldChat channels, notifications and email. {% .lead %}

{% callout title="Steps run as the workflow owner" %}
Every step on this page acts as the workflow's [owner](/weldconnect#a-workflow-acts-as-its-owner) and is checked against the owner's role when it runs. If the owner may not create leads, a **Create Lead** step fails with a message saying so, and the run shows the error. The step forms repeat this: "The workflow acts as its owner: it can only do what the owner's role allows."
{% /callout %}

Records a workflow creates or changes behave like records you create by hand: they appear in WeldCRM or WeldFlow, show up in timelines and can start other workflows.

---

## WeldCRM

### Create Company

Adds a company to WeldCRM. Fill in **Company name** (required) and optionally **Email**, **Phone**, **Website**, **Notes** and **Status** (**Active**, **Prospect**, **Inactive**). Turn on **Skip if a company with this email exists** to reuse an existing company instead of creating a duplicate.

The owner becomes the company owner. Output: `customerId`, `name`, `email`, `created`.

### Create Contact

Adds a person to WeldCRM. A contact needs a **First name**, a **Last name** or an **Email**. Optional: **Phone**, **Job title**, **Company** (a company ID, for example `{{steps.<step>.customerId}}` from a Create Company step), **Tags** (comma-separated) and **Notes**.

**Reuse a contact with the same email** returns the existing contact instead of creating a duplicate. Output: `contactId`, `name`, `email`, `created` (false when an existing contact was reused).

### Update Contact

Changes an existing person. Set **Contact to update** to the contact's ID, for example `{{trigger.record.id}}` or the ID from a Create Contact step. Only the fields you fill in change; empty fields keep their value.

The owner can only update contacts they own, unless their role lets them see all contacts.

### Create Lead

Adds a lead. **Email** is required. Optional: **First name**, **Last name**, **Company name**, **Job title**, **Phone**, **Mobile**, **Website**, **Source** and **Notes**. Output: `leadId`, `name`, `email`.

### Create Deal

Adds an opportunity. Fill in **Deal name** and **Company**, then choose the **Pipeline** and **Stage**. Optional: **Description**, **Value**, **Currency** and **Expected close date** (30 days from now when left blank). Output: `dealId`, `name`, `stage`, `status`.

### Move Deal Stage

Moves a deal to another stage. Set **Deal to move** to the deal's ID (for example `{{trigger.record.id}}` or `{{steps.<step>.dealId}}`), then choose the **Pipeline** and **Stage**. Moving a deal to a won or lost stage marks it won or lost, exactly like dragging the card on the board.

The owner can only move deals they own, unless their role lets them see all deals.

### Log Activity

Logs a CRM activity. Choose the **Type** (**Note**, **Call**, **Email**, **Meeting**, **Task**, **SMS**, **LinkedIn**, **Demo**, **Presentation**), enter a **Subject**, and link it to a **Company**, **Contact**, **Person** or **Deal** with their IDs. Optional: **Description** and **Due date**.

---

## WeldFlow

### Create Task

Creates a task in a WeldFlow project.

1. Choose the **Project**.
2. Enter a **Title**, for example `Follow up with {{trigger.record.name}}`, and optionally a **Description**.
3. Pick **Assignees**, a **Priority** (**Critical**, **High**, **Medium**, **Low**, **None**), **Labels** (comma-separated) and an optional **Stage**.
4. Set the **Due date**: an ISO date, a variable, or a relative value. Use the quick picks **Today**, **Tomorrow**, **In 3 days** or **In 1 week**, or type something like `in 2 weeks`.

A relative due date is worked out when the step runs, so a scheduled workflow always sets it relative to that run. Assignees get the usual assignment notification.

The owner needs permission to create tasks and write access to the project. Output: `taskId`, `number`, `key`, `projectId`, `title`, `url`.

---

## WeldChat

### Post Chat Message

Posts a message in a WeldChat channel.

1. Choose the **Channel**.
2. Write the **Message**. Variables work here, for example `New order {{trigger.record.number}} from {{trigger.record.customerName}}`.
3. Optionally list **Mentions**: member IDs to notify.

The message is posted **as the workflow**, never as the owner. In the channel it shows a workflow icon and a **Workflow** badge. The owner must be able to post in the channel: a private channel the owner is not a member of is refused.

---

## Notifications and email

### Send Notification

Sends an in-app notification (the bell). Fill in the **Title** and **Body**, choose the **Recipient** (**Specific users**), and optionally a **Category**, **Severity** and **Action URL** (a link opened when the notification is clicked). Without recipients, the workflow owner is notified. Recipients who are not workspace members are skipped; if none are left, the step fails.

### Send Email

Sends an email from a WeldMail account of your workspace.

1. Choose the **From Account**, or keep **Use default account**.
2. Fill in **To**, optionally **CC** and **BCC** (separate addresses with commas), the **Subject** and the **Body**.

Every address is checked before sending, after variables are filled in. An invalid or empty address fails the step at once instead of sending to the rest. Your workspace needs at least one connected WeldMail account; see [Connect an email account](/weldmail/connect-account).

---

## HTTP Request

Calls any web API, for example to push data to a system WeldConnect has no app for.

1. Enter the **URL** and choose the **Method** (GET by default).
2. Add **Headers**, for example an `Authorization` header with `Bearer {{variables.api_key}}`.
3. If the API expects data, add the **Request Body** and choose its **Content Type**.

The output has `status`, `ok`, `headers` and `body` (parsed when the response is JSON), so a following Condition can check `{{steps.<step>.status}}`.

Good to know:

- Only `http` and `https` addresses work. Addresses in private networks (like `localhost` or `192.168.x.x`) are refused.
- A request times out after 30 seconds. Responses larger than 1 MB are cut off.
- An error response (4xx or 5xx) or a network error fails the step, with the status in the run's error.

{% callout title="Keep keys out of the workflow" %}
Store API keys as **Secret** variables under **WeldConnect** → **Variables** and use them as `{{variables.<name>}}`, so the key itself never appears in the workflow's steps.
{% /callout %}

---

## Next steps

- [AI steps](/weldconnect/ai-steps)
- [Connect Slack, Google and GitHub](/weldconnect/connect-apps)
- [Runs and history](/weldconnect/runs-and-history)
