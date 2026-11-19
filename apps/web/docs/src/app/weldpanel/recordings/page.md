---
title: Session recordings
nextjs:
  metadata:
    title: Session recordings
    description: Which visits WeldPanel records, how masking keeps personal data out, how to find and watch a recording, keep favourites, and let AI summarise sessions.
screenshots_todo:
  - file: weldpanel-recordings.png
    shows: The Recordings list with Filter pills, the sort picker, frustration signal badges and a favourite
  - file: weldpanel-player.png
    shows: A recording with the controls over the video, the Summary and Pages tabs under it, and the Timeline tab of the details column on the right
  - file: weldpanel-ai-summary.png
    shows: The Summary tab of a recording with What they tried to do, Outcome, Where they got stuck and The story
---

A recording replays a visit as the visitor saw it: the pages, the mouse, the clicks and the scrolling. Text and fields are masked before anything leaves the visitor's browser. {% .lead %}

Watching recordings needs the **Watch session recordings** permission.

---

## Which visits are recorded

A visit is recorded only when all of these hold:

- the visitor consented, or the project is set to **Track without consent** (see [Consent and cookieless counting](/weldpanel/consent));
- the visit is picked by the project's sample rate. By default every consented visit is recorded;
- your plan's recording allowance, or your credit wallet, covers it (see [Usage and billing](/weldpanel/usage-and-billing));
- the page is not excluded (recording pauses on an excluded page and starts again after it);
- the browser supports it. Current versions of the common browsers do.

The recording script loads only for visits that are recorded, so other visits do not download it.

Only the visible tab records. After 30 minutes without input, the recording pauses until the visitor does something again.

---

## Masking

The project's **Masking** level, on the **Privacy & collection** tab, decides what is hidden:

| Level | Text on the page | Form fields | Images |
| --- | --- | --- | --- |
| **Strict** | Masked | Masked | Blocked |
| **Balanced** (default) | Visible | Masked | Visible |
| **Relaxed** | Visible | Only passwords, card fields and fields you mark as sensitive are masked | Visible |

At every level:

- Password fields are always masked, also after a "show password" toggle.
- Canvas, video, audio and iframes from other sites are not recorded.
- Masked text keeps its length (`****`), so the page layout replays as it was.

The level also decides the text sent with autocaptured clicks: none with **Strict**; with **Balanced** and **Relaxed**, the element's visible text, with email addresses and long numbers replaced by `*`.

### Mark elements yourself

Add these attributes to your HTML to change masking for one element and everything inside it:

| Attribute | Effect |
| --- | --- |
| `data-panel-mask` | The text and fields are masked in recordings, and the text is not sent with clicks. |
| `data-panel-unmask` | The text and fields are shown even where the masking level would mask them. Passwords stay masked. |
| `data-panel-block` | Recordings show an empty box of the same size, and clicks inside it are not captured. |

```html
<div class="account-balance" data-panel-mask>Balance: 1,250.00</div>
<p class="order-summary" data-panel-unmask>2 items, delivery on Friday</p>
<section class="chat-widget" data-panel-block>…</section>
```

---

## Find a recording

Open **Recordings** under **Behaviour**. Each row shows the **Visitor**, when the visit **Started**, its **Duration**, the number of **Pages**, its frustration **Signals**, the **Entry page** and the **Device and place**. A star marks a favourite.

Search by a user id or anonymous id. Click **Filter** to add a filter:

- **Date range**;
- **Duration (seconds): At least** and **Duration (seconds): At most**;
- **Pages visited**, **Entry page** and **Exit page**;
- **Countries**, **Devices** and **Browsers**;
- **Cohort**;
- **Did this event**, or with **is not**, the sessions that did not do it;
- **Frustration**: rage clicks, dead clicks, quick backs or excessive scrolling;
- **Has errors** and **Favourites only**.

The menu next to **Filter** sorts the list: **Newest first**, **Longest first**, **Most pages**, **Most frustration** or **Most errors**.

Funnels, the Frustration page and user profiles link here with the filters already set.

---

## Watch a recording

Click a row to open the recording. Move the pointer over the video to show the controls:

- **Play** and **Pause**, **Replay from the start**, and back or forward 5 seconds.
- **Playback speed**: 1x, 2x, 4x or 8x.
- **Skip inactivity** jumps over the stretches where nothing happens.
- **Full screen**.
- The **timeline** has markers for pages, clicks, frustration, errors and your own events. Click one to jump there.

Space plays or pauses. The arrow keys move 5 seconds.

Under the player:

- **Summary**: the AI summary, see below.
- **Pages**: the pages visited and how long the visitor stayed on each. Search them, or click **Filter** to filter by page or by time on page. Click one to jump to it.

On the right, the details of the recording:

- **Timeline**: every event of the visit. Search it, or click **Filter** to show one type, such as frustration or errors. Click an event to jump to it.
- **Info**: the page on screen now, when the visit started, how long it took, the number of pages, clicks and events, the entry and exit page, the device, browser, OS and country, the visitor's name and email, their other sessions, and what each colour on the timeline means.
- **Insights**: the frustration signals, the active and idle time, the time spent on each page, and the moments worth watching. Click a moment to jump to it.

---

## Favourites

Recordings are kept for 30 or 90 days, depending on your plan. To keep one longer, open the **⋮** menu of its row in **Recordings** and click **Add to favourites**.

Favourites are kept for 13 months. Filter on **Favourites only** to find them. **Remove from favourites**, in the same menu, lets the recording expire again.

---

## AI summaries

### One recording

On the **Summary** tab, click **Summarise this recording**. The summary tells you:

- **What they tried to do**;
- the **Outcome**: **Succeeded**, **Gave up** or **Unclear**;
- **Where they got stuck**;
- **The story** of the visit.

### A set of recordings

On the **Recordings** page, set your filters and click **Summarize**. AI reads up to 20 of the matching sessions, newest first, and groups what it finds into **Themes**, each with the number of sessions and a link to **Watch an example**. A funnel drop-off is a good place to start.

### Credits and privacy

- Summaries use AI credits from your workspace's credit wallet. The summary shows how many it cost.
- A saved summary is free to read.
- A set summary reuses the summaries of sessions that already have one, without charging for them again.
- When the wallet does not have enough credits, the summary says so. Click **Add credits** to top up under **Settings** > **Billing**.
- Only masked content reaches the AI: what you see in the player, never a masked text or field.
- A project can have AI switched off. Its recordings then show "AI summaries are switched off for this project".
