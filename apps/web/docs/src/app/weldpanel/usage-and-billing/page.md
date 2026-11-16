---
title: Usage and billing
nextjs:
  metadata:
    title: Usage and billing
    description: How many events and recordings your plan includes each month, what happens above that, and how long WeldPanel keeps your data.
screenshots_todo:
  - file: weldpanel-usage.png
    shows: WeldPanel Settings on the Usage tab with events and recordings against the allowance, the collection status and usage by project
  - file: weldpanel-usage-banner.png
    shows: The usage banner at the top of a WeldPanel page at 80% of the events allowance
---

Every plan includes a number of events and recordings each month. Above that, usage is paid from your workspace's credit wallet, so tracking keeps running. {% .lead %}

---

## What your plan includes

| Plan | Events per month | Recordings per month |
| --- | --- | --- |
| **Free** | 50,000 | 500 |
| **Business** | 1,000,000 | 5,000 |
| **Scale** | 5,000,000 | 25,000 |
| **Enterprise** | 20,000,000 | 100,000 |

- Usage is counted for the whole workspace, across all projects.
- A month runs from the first to the last day of the calendar month in UTC.
- **Events** are all events WeldPanel accepts: pageviews, clicks, your own events, frustration signals, and events sent from your server or imported. Events from visitors who did not consent count too.
- **Recordings** are recorded visits: one per visit, however long it is.

---

## Above the allowance

Usage beyond the allowance is charged from your credit wallet in blocks:

- events in blocks of **10,000**;
- recordings in blocks of **100**.

A block is charged once, when usage first goes into it. The **Usage** page shows how many blocks were charged this month and how many credits they cost.

### When the wallet runs out

If the wallet cannot pay for the next block:

1. **Recording stops at once.** No new recordings are made. Events are still collected.
2. **Events continue up to 10% over the allowance**, then new events are dropped as well.

This lasts until the next month starts, you add credits, or you upgrade your plan. Dropped events cannot be recovered.

After adding credits, open the **Usage** page and click **Check again** to resume collection.

---

## Warnings

WeldPanel warns you before data is lost:

| When | Banner in WeldPanel | Email |
| --- | --- | --- |
| 80% of the events or recordings allowance is used | Yes | Yes |
| 100% is used, and blocks are being charged | Yes | Yes |
| Recording is paused because the wallet is empty | Yes | Yes |
| Events are being dropped | Yes | Yes |

The emails go to the workspace's owners (or, when no owner has an email address, its admins), once per step per month.

The banner shows at the top of WeldPanel to people who can manage WeldPanel projects, with **View usage**, **Add credits** and **Upgrade**. You can dismiss the 80% and 100% warnings for the rest of your session; the banner about paused recording or dropped events stays until it is solved.

---

## See your usage

Open **Settings** under **Setup** in WeldPanel. The **Usage** tab shows, for the current month:

- your **Plan**;
- **Events** and **Recordings** used, against the allowance;
- what was **Charged beyond the allowance**;
- the **Collection status**: **Collecting**, **Recording paused** or **Dropping events**;
- how long your data is kept;
- usage **By project**.

**Add credits** opens **Settings** > **Billing**. **Upgrade plan** opens your plans.

The Usage page needs the manage permission for WeldPanel projects, which owners and admins have by default.

---

## How long data is kept

| Plan | Events | Recordings | Favourite recordings |
| --- | --- | --- | --- |
| **Free** | 12 months | 30 days | 13 months |
| **Business** | 25 months | 30 days | 13 months |
| **Scale** | 25 months | 90 days | 13 months |
| **Enterprise** | 25 months | 90 days | 13 months |

Reports cannot look further back than your plan keeps events. When you pick a longer period, it is shortened and the report says so.

---

## AI summaries

AI summaries of recordings are not part of the allowance. They use AI credits from the same wallet, see [Session recordings](/weldpanel/recordings#ai-summaries).
