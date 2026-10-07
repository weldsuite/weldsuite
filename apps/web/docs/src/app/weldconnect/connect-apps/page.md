---
title: Connect Slack, Google and GitHub
nextjs:
  metadata:
    title: Connect Slack, Google and GitHub
    description: Connect Slack, Google Sheets, Gmail, Google Calendar and GitHub to WeldConnect and use their steps in workflows.
screenshots_todo:
  - file: weldconnect-integrations-page.png
    shows: WeldConnect Integrations page with Slack, Google Sheets, Gmail, Google Calendar and GitHub cards, at least one showing Connected
  - file: weldconnect-step-slack.png
    shows: 'Slack: Post Message step settings with the Channel picker open'
  - file: weldconnect-step-google-sheets.png
    shows: 'Google Sheets: Append Row step settings with a pasted spreadsheet link, the Sheet picker and two column values'
  - file: weldconnect-step-github-issue.png
    shows: 'GitHub: Create Issue step settings with Repository, Title, Body, Labels and Assignees'
---

App steps let a workflow work outside WeldSuite: post to Slack, add rows to Google Sheets, send from Gmail, create Google Calendar events and open GitHub issues. {% .lead %}

---

## How connections work

- A connection belongs to the **workspace**, not to one person. Once Slack is connected, every workflow in the workspace can post with it.
- App steps act with that connection. They still follow the workflow [owner](/weldconnect#a-workflow-acts-as-its-owner) rule in one way: once the owner has left the workspace, the steps stop working.
- A workflow with an app step can only be published while that app is connected. If you disconnect an app, workflows that use it fail at that step.

To connect, disconnect or test an app you need permission to manage integrations (**Connect integrations**, **Disconnect integrations**). Ask a workspace admin if you don't see the buttons; see [Team and permissions](/settings/team-and-permissions).

---

## Open the Integrations page

Go to **WeldConnect** → **Integrations** (`/weldconnect/integrations` in the app). Each app has a card with **Connect**, and once connected, **Test** and **Disconnect**.

The page also lists apps whose steps are not available in the editor yet, such as Microsoft Teams, Notion, Airtable, Asana and Twilio. Connecting them has no effect in workflows for now.

---

## Slack

### Connect

1. On the **Slack** card, click **Connect**.
2. Slack asks which Slack workspace to connect and what WeldSuite may do. Click **Allow**.
3. You return to **Integrations** and the card shows **Connected**.

Click **Test** to check the connection; it shows the name of the connected Slack workspace.

### Slack: Post Message

1. Add the step **Slack: Post Message** (category **Integration**).
2. Choose the **Channel**. If the workspace has more than one Slack connection, choose the **Slack connection** first.
3. Write the **Message**. Variables and Slack formatting work: `*bold*`, `_italic_`, `<https://example.com|link text>`.
4. Optional: **Reply to thread**. Put the `ts` of an earlier message here, for example `{{steps.<step>.ts}}` from an earlier Slack step, to reply in its thread.

Output: `ok`, `channel`, `ts` and `permalink`.

{% callout title="Invite the app to the channel" %}
Invite WeldSuite's Slack app to the channel before the workflow posts there: type `/invite @WeldSuite` in the channel. Private channels always need this. Without the invite, the step fails with "WeldSuite's Slack app hasn't been invited to this channel yet".
{% /callout %}

If the Slack connection is revoked or no longer valid, the step fails with a message asking you to reconnect from **WeldConnect** → **Integrations**.

---

## Google Sheets, Gmail and Google Calendar

Google Sheets, Gmail and Google Calendar are three separate cards, each connected on its own. Each one asks Google only for what its steps need:

| App | Google asks permission to |
| --- | --- |
| **Google Sheets** | See, edit, create and delete your spreadsheets |
| **Gmail** | Send email on your behalf (WeldSuite can't read your mail) |
| **Google Calendar** | Create and edit events, and see the list of your calendars |

### Connect

1. On the card (for example **Google Sheets**), click **Connect**.
2. Sign in with the Google account the workflows should use and allow the requested access.
3. You return to **Integrations** and the card shows **Connected**. Click **Test** to check it.

If someone removes WeldSuite's access in their Google account, runs fail with a message asking you to reconnect. Click **Connect** on the card again.

### Google Sheets: Append Row

1. Add **Google Sheets: Append Row**.
2. Paste the **Spreadsheet** link (or its ID). WeldConnect looks it up and fills the **Sheet** list with its tabs. The connected Google account must have access to the spreadsheet.
3. Choose the **Sheet**.
4. Under **Column values**, add a row per column: the **Column** letter (`A`, `B`, …) and its value, for example `{{trigger.record.email}}`. Click **Add column** for more.

### Google Sheets: Update Row

Set up the spreadsheet, sheet and column values as above, then choose how to **Find the row**:

- **By row number**: the exact **Row number**, counting the header row.
- **By looking up a value**: the **Lookup column** letter and the **Lookup value** to search for. The first matching row is updated.

Only the columns you list change; the rest of the row stays as it is.

### Gmail: Send Email

Sends an email from the connected Gmail account. Fill in **To** (comma-separated), optionally **Cc** and **Bcc**, the **Subject** and the **Body**. Turn off **Body is HTML** to send plain text. Every address is checked before sending; an invalid address fails the step without sending anything.

### Google Calendar: Create Event

1. Choose the **Calendar** (the account's primary calendar by default).
2. Enter the **Title**, **Start** and **End** as ISO 8601 date-times, for example `2026-07-01T09:00:00`.
3. Set the **Time zone**, for example `Europe/Amsterdam`. It's required unless the start and end end in `Z` (UTC).
4. Optional: **Description** and **Attendees** (comma-separated email addresses).

---

## GitHub

WeldConnect uses the same GitHub App that WeldFlow uses for issue and pull request sync. There is no separate sign-in.

### Before you start

The GitHub App must be installed for your workspace, with access to the repositories you want to use:

1. Open **Settings** → **Integrations** → **GitHub**. This needs the **Manage GitHub integration** permission.
2. Install the WeldSuite GitHub App on your GitHub organisation or account and give it access to the repositories.

### Connect

1. On the **GitHub** card in **WeldConnect** → **Integrations**, click **Connect**. There is no redirect; the card shows **Connected** straight away.
2. Click **Test**; it shows the GitHub account the app is installed on.

If the app is not installed yet, you see "No GitHub App installation found for this workspace". Install it first as described above.

### GitHub: Create Issue

Choose the **Repository**, then fill in the **Title** and optionally the **Body** (GitHub Markdown), **Labels** (comma-separated, for example `bug, needs-triage`) and **Assignees** (comma-separated GitHub usernames). Output: `ok`, `number` and `url`.

### GitHub: Create Comment

Choose the **Repository**, set the **Issue / PR number** (for example `{{steps.<step>.number}}` from a Create Issue step) and write the **Comment**. Output: `ok`, `id` and `url`.

If GitHub refuses the request (an unknown assignee or label, a repository with issues turned off, a repository the app can't access), the step fails with GitHub's own explanation.

---

## Next steps

- [WeldSuite steps](/weldconnect/weldsuite-steps)
- [Runs and history](/weldconnect/runs-and-history)
