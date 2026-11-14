---
title: Integrations
nextjs:
  metadata:
    title: Integrations
    description: Send form responses to WeldCRM, WeldDesk, WeldFlow, WeldSheets, WeldConnect and webhooks.
---

Set up what happens to each completed response on the **Integrations** tab. {% .lead %}

Each integration runs as a separate step after a response is submitted. A step that fails is retried on its own without repeating the others, and the response shows it with a **Retry** button. Steps act as the member who set them up; if that member loses the permission, the step is skipped and the reason is shown on the integration. Use the **test run** to check the field mapping before you publish.

---

{% figure src="/images/help/weldforms-integrations.png" alt="The Integrations tab with WeldCRM and WeldDesk cards" caption="Each integration runs on every completed response." /%}

## WeldCRM

Match or create a **person** by email, optionally with their **company**, or create a **lead** instead. Map form fields to standard and custom CRM fields, each set to always overwrite or only fill empty fields. You can also add the person to a CRM list and log an activity, "Submitted *form*", linked to the response. Each person's page shows a **Forms** tab with their responses.

## WeldDesk

Open a ticket in a chosen inbox. Subject and body come from recall templates; the respondent becomes the requester, priority and tags can be mapped from answers, and uploaded files are attached.

## WeldFlow

Create a task in a project, or a personal task, with title and description templates, an assignee, a due date taken from an answer, labels and the uploaded files.

## WeldSheets

Responses are available as a connected table, `form_responses`, with every field of every version plus metadata. **Open in WeldSheets** on the Results tab creates a workbook with the table connected.

## WeldConnect and webhooks

Form events (a response was submitted, updated or deleted) can start a WeldConnect workflow filtered by form, or be sent to a workspace webhook. A starter template posts every submission to a WeldChat channel.

{% callout title="What events carry" %}
Events carry the answers by ref with display values. They never carry file contents or signatures, nor any answer to a field marked **sensitive**.
{% /callout %}
