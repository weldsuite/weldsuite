---
title: WeldPanel
nextjs:
  metadata:
    title: WeldPanel
    description: Product analytics and session recordings for your website or web app.
screenshots_todo:
  - file: weldpanel-overview.png
    shows: The Overview page of a project with the KPI tiles, the Visitors and pageviews chart, and the Pages and Sources lists
---

WeldPanel shows how people use your website or web app. Add one script tag, and WeldPanel counts your traffic, builds funnels and retention, and records visits you can watch back. {% .lead %}

---

## What you can do

- **Count traffic**: visitors, visits, pageviews, bounce rate, sources, countries and devices on the **Overview**.
- **See who is on your site now** in the **Live** view.
- **Analyse events** with **Insights**, **Funnels**, **Retention** and **Flows**, and keep the results as reports and dashboards.
- **Recognise the users** of your app with `identify()`, and see each person's profile, activity and recordings under **Users**.
- **Watch recordings** of visits, with rage clicks and errors marked on the timeline, and let AI summarise what happened.
- **See heatmaps** of where people click and how far they scroll.
- **Find frustration**: rage clicks, dead clicks, quick backs, excessive scrolling and JavaScript errors.
- **Send events from your server**, or import older ones, with a server key.

Charts lead to the recordings behind them. A funnel step with a big drop-off links to the visits of the people who dropped off there.

---

## Where things are

| Sidebar group | Pages |
| --- | --- |
| **General** | **Overview** |
| **Analyse** | **Insights**, **Funnels**, **Retention**, **Flows** |
| **Behaviour** | **Live**, **Users**, **Recordings**, **Heatmaps**, **Frustration** |
| **Saved** | **Reports**, **Dashboards**, **Cohorts** |
| **Setup** | **Projects**, **Lexicon**, **Settings** |

A **project** is one website or app you track. Analytics pages show one project at a time: pick it in the **Project** menu at the top of the page.

You only see the pages your role allows. Recordings and user profiles have their own permissions, see below.

---

## Editions

Analytics, recordings, heatmaps and the other pages are available on Global (WeldSuite Cloud) only. On the EU and self-hosted editions, WeldPanel has only **Projects**, with the install instructions, for now.

---

## Permissions

{% callout title="Who can do what" %}
Workspace admins can change these per role, see [Team and permissions](/settings/team-and-permissions). By default:

- **Owners and admins** can do everything, including creating projects and server keys, seeing usage and erasing people.
- **Members** can read projects, build and save reports, dashboards and cohorts, watch recordings and see user profiles.
- **Viewers** can read projects and the reports and dashboards shared with the workspace. They cannot watch recordings or see profiles.

Watching recordings (**Watch session recordings**) and seeing profiles (**View tracked user profiles**) are separate permissions, because a recording shows what a visitor saw and did, and a profile can hold an email address.
{% /callout %}

---

## Guides

| Guide | What it covers |
| --- | --- |
| [Set up a project](/weldpanel/get-started) | Create a project, add the snippet or npm package, check that events arrive |
| [Consent and cookieless counting](/weldpanel/consent) | What is collected before consent, Global Privacy Control, consent mode |
| [Track events and identify users](/weldpanel/track-events) | `track`, `identify`, `reset`, `people.*` and the lexicon |
| [Traffic overview and live view](/weldpanel/overview-and-live) | Traffic numbers, filters, data freshness, who is online now |
| [Insights, funnels, retention and flows](/weldpanel/analyse) | Building analyses from your events |
| [Reports, dashboards and cohorts](/weldpanel/reports-and-dashboards) | Saving, sharing and grouping |
| [Users and profiles](/weldpanel/users) | Profiles, the WeldCRM card, erasing a person |
| [Session recordings](/weldpanel/recordings) | Sampling, masking, the player, favourites, AI summaries |
| [Heatmaps](/weldpanel/heatmaps) | Clicks, areas and scroll depth on a page |
| [Frustration signals](/weldpanel/frustration-signals) | What each signal means and where to find them |
| [Server-side tracking and import](/weldpanel/server-side) | Server keys, the server client, the HTTP API |
| [Usage and billing](/weldpanel/usage-and-billing) | Plan allowances, the credit wallet, warnings |
| [Privacy and data storage](/weldpanel/privacy) | Where data is stored, what is never stored, how long it is kept |
