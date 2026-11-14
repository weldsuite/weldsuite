---
title: Frustration signals
nextjs:
  metadata:
    title: Frustration signals
    description: What rage clicks, dead clicks, quick backs, excessive scrolling and errors mean, and how to find the visits behind them.
screenshots_todo:
  - file: weldpanel-frustration.png
    shows: The Frustration page with the signal type picker, the trend chart and the Pages with the most signals table
---

WeldPanel spots the moments visitors get annoyed: clicking again and again, clicking something that does nothing, or leaving a page straight away. {% .lead %}

---

## The signals

The snippet detects them in the visitor's browser and sends each one as an event.

| Signal | Event | What happened |
| --- | --- | --- |
| **Rage clicks** | `$rageclick` | Three or more clicks within 0.7 seconds and 30 pixels of each other. Counted once per burst. Often a button that responds slowly, or something that looks clickable but is not. |
| **Dead clicks** | `$deadclick` | A click on something that looks clickable (a link, a button, anything with a pointer cursor) after which nothing happens for a second: the page does not change, navigate, load data, move focus or scroll. Clicks in fields and labels, downloads, email and phone links, and clicks with a modifier key do not count. |
| **Quick backs** | `$quickback` | Back to the previous page within 7 seconds. The page they left is often not what they expected. |
| **Excessive scrolling** | `$excessivescroll` | Scrolling up and down at least four times over three window heights within 20 seconds, once per page. The visitor is looking for something and not finding it. |
| **Errors** | `$exception` | A JavaScript error or failed promise in the visitor's browser that your site did not handle. Each message, script and line is reported once per visit, at most 20 per page load. |

Rage and dead clicks are clicks, so they follow the project's **Autocapture** setting. Signals are counted for visitors who did not consent too.

Error messages have email addresses and long numbers masked. With each error WeldPanel keeps the script address (without its query) and the line and column.

---

## The Frustration page

Open **Frustration** under **Behaviour** and pick the date range.

- A tile per signal shows how many there were in the period. Click a tile to look at that signal.
- **Trend** charts every signal over time.
- **Pages with the most signals** and **Elements with the most signals** list where the chosen signal happens most. Elements come from clicks only, so that list is empty for quick backs, excessive scrolling and errors.

Click **Watch recordings** to open the recordings with the chosen signal, or the link next to a page to see only the visits where it happened on that page. You need permission to watch recordings.

---

## In recordings

The same signals show up in **Recordings**:

- each row lists the visit's **Signals**;
- **Filters** > **Frustration** finds visits with rage clicks, dead clicks, quick backs or excessive scrolling, and **Has errors** those with errors;
- **Sort by** **Most frustration** or **Most errors** puts the worst visits first;
- the player marks each signal and error on the timeline.

See [Session recordings](/weldpanel/recordings).
