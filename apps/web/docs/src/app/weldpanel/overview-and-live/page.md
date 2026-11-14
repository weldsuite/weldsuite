---
title: Traffic overview and live view
nextjs:
  metadata:
    title: Traffic overview and live view
    description: Read your site's traffic on the WeldPanel Overview, filter it, and see who is on your site right now.
screenshots_todo:
  - file: weldpanel-overview-filters.png
    shows: The Overview with a country filter applied, the date range picker and the Compare with previous period switch
  - file: weldpanel-live.png
    shows: The Live page with Visitors right now, the Pages, Countries and Devices lists and the Active sessions table
---

The **Overview** shows your site's traffic: who came, from where, and what they looked at. **Live** shows who is there right now. {% .lead %}

---

## The numbers

| Number | Meaning |
| --- | --- |
| **Visitors** | Different people in the period |
| **Visits** | Separate visits. A visit ends after 30 minutes without activity. |
| **Pageviews** | Pages viewed |
| **Bounce rate** | The share of visits that saw one page and did nothing else |
| **Visit duration** | How long a visit lasted, on average |

Each tile also shows the change **vs. previous period**. Turn off **Compare with previous period** to hide it.

Below the tiles:

- **Visitors and pageviews**: a chart over the period.
- **Pages**: **Top pages**, **Entry pages** (where visits start) and **Exit pages** (where they end).
- **Sources**: **Referrers** and the **UTM source**, **UTM medium** and **UTM campaign** of your links. Visits without a referrer are under **Direct / none**.
- **Countries**.
- **Devices**: **Devices**, **Browsers** and **Operating systems**.

Visitors who have not consented are counted with an id that changes daily, so they count as new visitors each day. See [Consent and cookieless counting](/weldpanel/consent).

---

## Filter and change the period

- **Click a row** in any list to filter the whole page on it, for example on one country or one page. Click it again to remove the filter.
- Use **Add filter** for anything else. Filter on a **Visit or page** field (page path, referrer, UTM, country, device, browser and so on), an **Event property**, a **User property** or a **Cohort**.
- Pick the period in **Date range**: **Today**, **Last 7 days**, **Last 30 days**, **Last 90 days**, **Last 12 months** or a **Custom range**.

---

## How fresh the data is

A badge shows **Data as of** and the time. New events show up one to two minutes after they happen, and results are kept for two minutes. Click **Refresh** for the latest numbers.

When you pick a period longer than your plan keeps events, the badge says **Shortened to what your plan keeps**. See [Usage and billing](/weldpanel/usage-and-billing#how-long-data-is-kept).

---

## Live view

The Overview shows how many people are online now. Click it, or open **Live** under **Behaviour**, to see:

- **Visitors right now**: visitors active in the last five minutes.
- **Pages**, **Countries** and **Devices** of those visitors.
- **Active sessions**: each visitor, the page they are on, their country, how long they have been on the site (**On site for**) and how many pages they saw (**Pages seen**).

The view updates by itself every few seconds.

With permission to see user profiles, each visitor is shown by their id: your user id after `identify()`, otherwise an anonymous id. Without that permission, every visitor shows as **Anonymous visitor**.
