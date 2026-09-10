---
title: Connect an AI assistant (MCP)
nextjs:
  metadata:
    title: Connect an AI assistant (MCP)
    description: Connect Claude, ChatGPT, or another AI assistant to your WeldSuite workspace so it can look things up and make changes for you.
---

Connect an AI assistant to your workspace so it can search your contacts, tickets, projects, and more — and make changes when you ask it to. {% .lead %}

WeldSuite ships an **MCP server**. MCP (Model Context Protocol) is the standard that AI assistants use to talk to outside systems. Point a supported assistant at the WeldSuite MCP server, sign in once, and it can work with your workspace data the same way you do in the browser.

{% callout title="Before you start" %}
You need a WeldSuite account that belongs to a workspace, and an AI assistant that supports custom MCP connectors. The assistant gets exactly the access your own role has — nothing more.
{% /callout %}

---

## The server address

Use this address in your AI assistant:

**`https://mcp.weldsuite.org/mcp`**

There is no API key to create and nothing to paste into a config file besides the address. Signing in happens in your browser the first time you connect.

---

## Connect your assistant

Every assistant words this slightly differently, but the flow is the same:

1. Open your assistant's **Connectors**, **Integrations**, or **MCP servers** settings.
2. Choose to add a **custom connector** (sometimes called "remote MCP server").
3. Paste `https://mcp.weldsuite.org/mcp` as the server address. Give it a name such as **WeldSuite**.
4. Save. The assistant sends you to a WeldSuite sign-in page in your browser.
5. Sign in with your normal WeldSuite account.
6. **Pick the workspace** you want the assistant to work in, then approve the request.

When the browser tab closes, the assistant lists the WeldSuite tools it can use. Ask it something simple — "how many open tickets do we have?" — to confirm it works.

{% callout title="Pick the right workspace" %}
The connection is tied to the workspace you choose while signing in. If you belong to more than one workspace and choose the wrong one, disconnect the connector in your assistant and add it again to pick another.
{% /callout %}

---

## What the assistant can do

The server exposes over 240 tools covering most of the platform:

| Area | Examples of what you can ask for |
| --- | --- |
| **WeldCRM** | Contacts, customers, leads, opportunities, pipelines, activities, quotes |
| **WeldDesk** | Tickets, replies, ticket status, conversations, help articles |
| **WeldFlow** | Projects, tasks, comments, tags, sprints, milestones, goals, whiteboards, project files and messages |
| **WeldChat** | Channels, messages, members, drafts, bookmarks |
| **WeldCalendar** | Calendars and events |
| **WeldDrive** | Files and folders |
| **WeldCommerce** | Products, orders |
| **WeldHost** | Domains |
| **WeldKnow** | Knowledge spaces and pages |
| **WeldSocial** | Social accounts, posts, campaigns, scheduling, analytics |
| **Workspace** | Members, settings, webhooks, workflows, time entries |

Two extras appear automatically when your workspace uses them:

- **WeldObjects** — your custom objects show up as their own tools (list, get, create, update, delete), using the names you gave them.
- **WeldApps** — apps built for your workspace can publish their own tools, which appear alongside the built-in ones.

---

## Example things to ask

- "Which leads haven't been contacted in the last 30 days?"
- "Summarise the open tickets for Acme Industries."
- "Create a task in the Website Redesign project to review the new pricing page, due Friday."
- "Add a note to the Acme opportunity that they asked for a revised quote."
- "What's on the team calendar next week?"

---

## Permissions and safety

- **Your role decides everything.** The assistant is offered only the tools your workspace role can use, and every call is checked again when it runs. If you cannot delete leads in WeldSuite, neither can your assistant.
- **Deleting needs an explicit delete permission.** Being able to create or edit records does not let the assistant remove them.
- **Changes are recorded** exactly like changes you make in the browser — they show up in the audit trail and trigger the same automations and notifications.
- **Ask for confirmation.** The assistant is instructed to confirm before creating, changing, or deleting anything you did not explicitly ask for. Read what it proposes before you agree.
- **Disconnect any time** from your assistant's connector settings. Removing the connector revokes its access.

See [Team and permissions](/settings/team-and-permissions) for how roles are assigned.

---

## Usage limits

Requests are limited per workspace, per minute, so one busy assistant cannot slow down the rest of your team. If you hit the limit, the assistant reports a rate-limit message and how long to wait — usually less than a minute. Higher plans get more headroom.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Sign-in loop, or "missing bearer token" | The connector never finished authorising. Remove it and add it again, completing the browser sign-in. |
| "Token is not scoped to an organization" | You skipped the workspace step during sign-in, or the assistant did not ask for workspace access. Reconnect and make sure you select a workspace and approve the request. |
| "No WeldSuite workspace is linked to the selected organization" | You picked an organization that has no WeldSuite workspace. Reconnect and choose the right one. |
| "You are not a member of this workspace" | Your account was removed from that workspace. Ask an admin to invite you, or reconnect to a workspace you belong to. |
| "Your workspace role grants no permissions" | Your role has no access assigned. An owner or admin can fix this under Team and permissions. |
| "Rate limit exceeded" | Wait the number of seconds shown, then continue. |
| The assistant can't find a tool it used before | Tools follow your permissions. If your role changed, reconnect so the assistant sees the current list. |

---

## Not the same thing

Under **Settings → Integrations → MCP servers** you can connect *other* companies' MCP servers *into* WeldSuite, so the built-in assistant can use them. That is the opposite direction from this guide, which is about letting an outside assistant reach your WeldSuite data.

---

## Next steps

- [Team and permissions](/settings/team-and-permissions)
- [Settings overview](/settings)
