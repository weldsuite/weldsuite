---
title: Consent and cookieless counting
nextjs:
  metadata:
    title: Consent and cookieless counting
    description: What WeldPanel collects before a visitor consents, how to start full tracking, Global Privacy Control, and the project's consent mode.
screenshots_todo:
  - file: weldpanel-consent.png
    shows: The Privacy & collection tab with the Consent options Wait for consent (selected) and Track without consent
---

Until a visitor consents, WeldPanel counts them anonymously, without cookies or browser storage. Full tracking starts when your site calls `weldpanel.consent.grant()`. {% .lead %}

---

## Choose a consent mode

Set it on the project's **Privacy & collection** tab, under **Consent**:

| Mode | What happens |
| --- | --- |
| **Wait for consent** (default) | WeldPanel counts anonymously until your site calls `weldpanel.consent.grant()`. Recommended when you have visitors from the EU. |
| **Track without consent** | Full tracking starts at the first page view. Only choose this if your audience does not need to give consent. |

WeldPanel does not show a cookie banner of its own. You decide whether your visitors need to consent, and your banner or consent tool tells WeldPanel when they do.

---

## Before consent

Without consent, WeldPanel still counts:

- pageviews and page leaves, with scroll depth;
- clicks and form submits, when **Autocapture** is on;
- your own events from `track()`;
- frustration signals and JavaScript errors.

It does **not**:

- write anything to cookies, localStorage or sessionStorage;
- send a visitor id, session id or user id;
- accept `identify()` or `people.*` calls (they are dropped);
- record the visit, or send a snapshot of the page for heatmaps.

Visitors are counted with an anonymous id the collector works out on the server from the day, the project, the IP address and the browser. It changes every day and cannot follow anyone from one day to the next, so a visitor who comes back tomorrow counts as a new visitor. The IP address is not stored. Visits are split by 30 minutes without activity.

---

## Start full tracking

Call `grant()` when the visitor agrees, for example from the accept button of your cookie banner:

```js
// The visitor accepted analytics cookies
weldpanel.consent.grant();
```

From then on WeldPanel keeps an anonymous id and a session id in the browser's localStorage, under `weldpanel:<project token>`. With them it can link visits, recognise logged-in users after `identify()` and record sessions. The grant is remembered on later visits.

The snippet's stub queues calls, so your banner can call `grant()` before the WeldPanel script has loaded.

| Call | What it does |
| --- | --- |
| `weldpanel.consent.grant()` | The visitor agreed. Keep an anonymous id and a session id from now on. |
| `weldpanel.consent.revoke()` | The visitor withdrew. Delete everything stored and go back to counting without cookies. |
| `weldpanel.optOut()` | Send nothing at all, on this page and on later visits. Deletes everything stored. |
| `weldpanel.optIn()` | Undo `optOut()`. Consent goes back to the project's mode. |

A revoke or opt-out in one tab applies at once to the site's other open tabs. Events already waiting to be sent go out under the consent they were collected with.

---

## Global Privacy Control

When a visitor's browser sends the **Global Privacy Control** signal, WeldPanel counts them without cookies until your site calls `grant()`. This also applies to projects set to **Track without consent**.

---

## Track without consent

With **Track without consent**, the SDK behaves as if `grant()` was called on the first page view.

If you switch the project back to **Wait for consent**, the ids that were not created by `grant()` are deleted on each visitor's next page load.

---

## What visitors type

Whatever the consent, clicks and form submits never carry what visitors type or pick in a field. Recordings mask fields too, unless you chose the **Relaxed** masking level. See [Privacy and data storage](/weldpanel/privacy).
