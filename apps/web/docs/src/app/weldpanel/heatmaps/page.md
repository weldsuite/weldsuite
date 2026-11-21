---
title: Heatmaps
nextjs:
  metadata:
    title: Heatmaps
    description: See where visitors click and how far they scroll on a group of pages, drawn on a snapshot of the page.
screenshots_todo:
  - file: weldpanel-heatmap-list.png
    shows: The Heatmaps list with a few page groups, their URL patterns and Last changed dates
  - file: weldpanel-heatmap-clicks.png
    shows: A click heatmap of a product page group on Desktop, with the stats row and the Most clicked elements table
  - file: weldpanel-heatmap-scroll.png
    shows: A scroll depth heatmap with the line where half of the visitors stop reading
---

A heatmap shows where visitors click and how far down they scroll, drawn on a snapshot of the page. {% .lead %}

---

## Create a page group

Heatmaps add up every page that matches a **page group**: a URL pattern.

1. Open **Heatmaps** under **Behaviour**.
2. Click **New page group**.
3. Enter a **Name**, such as "Product pages", and a **URL pattern**, such as `/products/*`. The pattern starts with a slash; a star matches any characters. Use `/pricing` for one page.
4. Click **Save**. The group's heatmap opens.

**Heatmaps** lists your page groups with their URL pattern and when they last changed. Search finds a group by its name or pattern. **Filter** narrows the list to groups that cover one page or several (a pattern with `*`), or by when they last changed. Click a group to open its heatmap. Its title row shows the group's name and URL pattern; use the arrow before the name to go back to the list.

To change or remove a group, use the **⋮** menu at the end of its row, or the **⋮** menu at the end of its heatmap's title row. Deleting a group keeps the click data: add the pattern again and the heatmap comes back.

---

## Choose what to see

The row under the title holds the heatmap's filters and period. **Device** and **Type** start as filters; click a filter's value to change it.

- **Device**: **Desktop** (windows 1024 pixels wide or more), **Tablet** (768 to 1023) or **Mobile** (narrower than 768).
- **Type**:
  - **Clicks**: each click, where it landed inside the element.
  - **Areas**: the share of all clicks each element received.
  - **Scroll depth**: how many visitors reached each depth of the page, and where half of them stop reading.
- **Date range**: the period to add up.

Under these rows is the page itself, with the heat layer drawn on it.

The column on the right has four tabs:

- **Elements**: the clicked elements ranked by their clicks, with each one's share. Search finds an element by its text or selector; **Filter** keeps elements with more or fewer clicks than a number.
- **Scroll depth**: how many visitors reached each depth of the page.
- **Info**: the page group's name, URL pattern and dates, and the figures of the heatmap on screen: **Pageviews**, **Clicks** (or **Page leaves** for scroll depth) and **Clicks not placed**.
- **AI summary**: click **Summarize** and AI reads up to 20 recent recorded visits to the group's pages, on the device and in the period you picked, and groups what visitors do into themes, each with a recording to watch. It uses credits from your wallet; visits summarized before are free. It needs AI switched on for the project.

Clicks are stored relative to the element that was clicked, so a heatmap stays right across screen sizes and small layout changes.

---

## The page snapshot

The background is a masked snapshot of the page, taken from a recent recording of that page group and device.

- When no recording covers the page yet, WeldPanel asks the next visitor who consented, on a matching page and device, to send one masked snapshot. You see "The background is on its way". The numbers already work; check back later for the background.
- When there is no snapshot and none can be asked for, for example because recordings are off or the page group has no visits, you see "No background for this page". The numbers are still right.
- **Clicks not placed** counts clicks on elements that are not in the snapshot, for example a menu that was closed when the snapshot was taken. They are counted, but not drawn.

Seeing the snapshot needs the **Watch session recordings** permission, because it is part of a recording. Without it you still see the numbers.

---

## What heatmaps need

- **Autocapture** on, on the project's **Privacy & collection** tab, for clicks and areas. Scroll depth comes from page leaves and works without it.
- Elements inside `data-panel-block` are not captured, so they get no clicks.
- Visitors who did not consent are counted too.
