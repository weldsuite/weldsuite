---
title: Privacy and data storage
nextjs:
  metadata:
    title: Privacy and data storage
    description: Where WeldPanel stores your visitors' data, what it never stores, how long it keeps data, and how to erase a person.
---

WeldPanel collects data about your visitors on your behalf. These are the rules it follows and the choices you have. {% .lead %}

---

## Where the data is stored

- **Recordings** are stored in a storage bucket under EU jurisdiction. They are not public: they are only played back inside WeldPanel, to people with permission to watch recordings.
- **Event tables** (pageviews, clicks, your own events) are stored in Western Europe.

This applies to every workspace, wherever the rest of its data is stored.

---

## What WeldPanel leaves out

- **IP addresses.** The IP address is used for two things only: to look up the country, region and city, and to count visitors who did not consent with an id that changes every day. The secret that id is made with is deleted after a day.
- **What visitors type, in events.** Clicks and form submits never carry the value of an input, text area or select. In recordings, fields are masked with the **Strict** and **Balanced** masking levels. With **Relaxed**, only passwords, card fields and fields you mark are masked. Password fields are masked at every level.
- **Secrets in page addresses.** Before a page address is stored, WeldPanel removes the part after `#`, any user name and password, and query parameters that look sensitive, such as `token`, `key`, `password`, `code`, `email` or `session`, and values that look like an email address.

Known bots are filtered out and not counted.

---

## Consent

Until a visitor consents, WeldPanel stores nothing in their browser and sends no id that can follow them. See [Consent and cookieless counting](/weldpanel/consent).

---

## Masking

Choose how much text recordings show with the project's masking level, and mark elements to mask, show or block. See [Session recordings](/weldpanel/recordings#masking).

---

## Who can see what

Watching recordings and seeing user profiles are separate permissions from reading reports, because a recording shows what a visitor saw and did, and a profile can hold an email address. Viewers have neither by default. See [WeldPanel](/weldpanel#permissions).

---

## How long data is kept

| Data | Kept for |
| --- | --- |
| Events | 12 months on Free, 25 months on other plans |
| Recordings | 30 days on Free and Business, 90 days on Scale and Enterprise |
| Favourite recordings | 13 months |

See [Usage and billing](/weldpanel/usage-and-billing#how-long-data-is-kept).

---

## Erasing a person

When someone asks you to delete their data, erase them from their profile under **Users**. Their profile and recordings are removed at once, and their events within a month. See [Users and profiles](/weldpanel/users#erase-a-person).

---

## Your own privacy notice

You decide what your site collects and whether your visitors need to consent. Mention WeldPanel analytics, and session recordings if you use them, in your privacy notice and your consent banner.
