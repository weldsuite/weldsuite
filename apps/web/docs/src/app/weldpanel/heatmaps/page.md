---
title: Heatmaps
nextjs:
  metadata:
    title: Heatmaps
    description: See where visitors click and how far they scroll on a group of pages, drawn on a snapshot of the page.
screenshots_todo:
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
4. Click **Save**.

Pick a group in the **Page group** menu to see its heatmap. Use **Edit page group** or **Delete page group** to change it. Deleting a group keeps the click data: add the pattern again and the heatmap comes back.

---

## Choose what to see

- **Device**: **Desktop** (windows 1024 pixels wide or more), **Tablet** (768 to 1023) or **Mobile** (narrower than 768).
- **Type**:
  - **Clicks**: each click, where it landed inside the element.
  - **Areas**: the share of all clicks each element received.
  - **Scroll depth**: how many visitors reached each depth of the page.
- **Date range**: the period to add up.

Above the heatmap you see the **Pageviews**, **Clicks** and **Page leaves** of the group in the period. **Most clicked elements** lists the elements with their clicks and share. For scroll depth, a line tells you where half of the visitors stop reading.

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
