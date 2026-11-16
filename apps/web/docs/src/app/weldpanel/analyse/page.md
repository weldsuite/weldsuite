---
title: Insights, funnels, retention and flows
nextjs:
  metadata:
    title: Insights, funnels, retention and flows
    description: Count events over time, see where people drop off, measure who comes back, and follow the paths people take in WeldPanel.
screenshots_todo:
  - file: weldpanel-insights.png
    shows: Insights with two series, a breakdown by country and the line chart
  - file: weldpanel-funnel.png
    shows: A three-step funnel with conversion per step, drop-off and the Watch recordings menu open on a step
  - file: weldpanel-retention.png
    shows: The weekly retention grid with cohort rows, user counts and the Average row
  - file: weldpanel-flows.png
    shows: Flows after $pageview with the step columns and the Most common paths list
---

The pages under **Analyse** turn your events into answers. Each one builds an analysis you can change on the spot, then save as a report. {% .lead %}

---

## What they have in common

- **Events**: pick them from a list with **Built-in events** (such as `$pageview`) and **Your events** (from `track()`). Describe and hide names in the [lexicon](/weldpanel/track-events#describe-your-events-in-the-lexicon).
- **Filters**: narrow down on a **Visit or page** field, an **Event property**, a **User property** or a **Cohort**, with operators such as **is**, **contains**, **is greater than** and **is set**.
- **Break down by** (Insights and Funnels): split the result by a field or property, and choose how many values to show with **Show the top**.
- **Date range**: the same periods as the Overview.
- **Save as report** and **Add to dashboard**: see [Reports, dashboards and cohorts](/weldpanel/reports-and-dashboards).

People are counted across their devices once your site calls `identify()`: events sent before they logged in count for them too.

---

## Insights

Count events over time, compare them and break them down.

1. Under **Series**, choose an **Event** and a **Measure**:
   - **Total count**, **Unique users**, **Unique sessions** or **Average per user**;
   - or the **Sum**, **Average**, **Minimum** or **Maximum of a property**, such as an order amount.
2. Optionally add **Filters for this series**.
3. Click **Add series** to compare another event on the same chart. Series are named A, B, C.
4. Add **Filters for every series** and a breakdown if you need them.
5. Choose **Group by** (**Hour**, **Day**, **Week** or **Month**) and the **Chart**: **Line**, **Bar**, **Table** or **Number**.

Turn on **Compare with previous period** to see the period before next to it.

---

## Funnels

See how many people get through a series of steps, and where they drop off.

1. Under **Steps**, choose an event for each step. Click **Add step** for more, and move steps up or down. Each step can have its own filters.
2. Set the **Conversion window**: the time allowed from the first step to the last, in minutes, hours or days. It starts at 7 days.
3. Choose the **Step order**:
   - **Loose**: other events may happen between the steps.
   - **Strict**: each step must be the very next event.
4. Add **Filters for the whole funnel** or a breakdown if you need them.

The result shows the **Overall conversion**, and per step how many people reached it, the share of the previous step, how many **dropped off**, and how long the step takes on average.

### Watch the people behind a step

Click **Watch recordings** on a step and choose:

- **People who dropped off before this step**, or
- **People who completed this step**.

The **Recordings** page opens, filtered to those visits. You need permission to watch recordings. See [Session recordings](/weldpanel/recordings).

---

## Retention

Of the people who did something for the first time, how many came back?

1. Choose the **First event**. People join the cohort of the period they first did it.
2. Choose the **Return event**: what counts as coming back. **Any event** counts any activity.
3. Choose the **Period** (**Day**, **Week** or **Month**) and how many **Periods to show**.

Each row is a cohort, with its number of **Users**. Each column shows the share of them who came back in that period (**Week 1**, **Week 2** and so on). Hover over a cell for the exact count. The **Average** row sums up all cohorts.

---

## Flows

The most common paths people take before or after an event.

1. Choose the **Anchor event**. `$pageview` shows paths through your pages.
2. Under **Show paths**, choose **After the event** or **Before the event**.
3. Choose the number of **Steps**, what to **Include** (**All events**, **Pages only** or **Your events only**) and how many **Paths** to show.

The columns show where people go next (or where they come from), step by step. **Left the site** means the visit ended there. Below, **Most common paths** lists whole paths and how often each was taken.
