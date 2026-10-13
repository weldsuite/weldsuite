---
title: WeldReach
nextjs:
  metadata:
    title: WeldReach
    description: Cold email outreach from dedicated mailboxes, with replies in one inbox and WeldCRM hand-off.
---

WeldReach sends cold email sequences from dedicated outreach mailboxes, stops a sequence as soon as someone replies, and collects every reply in one inbox. {% .lead %}

WeldReach is available on request. A workspace owner or admin asks for access from the app store, and WeldSuite reviews each request by hand.

---

## Before you start

- **Use separate outreach domains.** Send from look-alike domains such as `getacme.com` or `acme-mail.com`, never from your main company domain. If an outreach domain gets a poor reputation, your normal email is not affected.
- **Email businesses only.** WeldReach skips free-mail and consumer addresses (Gmail, Outlook.com, Hotmail and similar).
- **Check the law for every country you email.** In the Netherlands and Germany, business addresses also need prior consent unless the recipient is an existing customer. Every WeldReach email names you as the sender and contains an opt-out.

---

## Request access

1. Open the **App Store** and choose **WeldReach**.
2. Click **Request access** and answer the questions: what you will use it for, which countries you will email, roughly how many emails per day, and where your contact lists come from.
3. Tick each statement in **Before you send**.
4. Send the request. You receive an email once it is approved; WeldReach is then installed automatically.

---

## Set up

The setup guide walks through four steps.

1. **Sender details** — your company name and address, and the opt-out line added to every email.
2. **Payment method** — inboxes cost $5 per inbox per month, billed to the card you add.
3. **Domains** — buy a domain in WeldHost, or bring an existing one into WeldHost, then connect it to WeldReach. The mail records (MX, SPF, DKIM, DMARC) are set up for you. A domain that already receives email or hosts a website cannot be connected, because its mail records would change.
4. **Mailboxes** — create one or more mailboxes per domain, each with its own sender name and signature.

New mailboxes warm up for about two weeks before they can send in a campaign. After that they start at a low daily volume and build up gradually.

---

## Run a campaign

1. **Prospects** — import a CSV, a WeldCRM list or a WeldData list. Invalid, consumer and role addresses (`info@`, `sales@`) are left out, as are addresses on your suppression list.
2. **Campaign** — write the steps of your sequence. Use variables such as `{{firstName}}` or `{{companyName|your team}}` (the part after `|` is used when the value is empty). Follow-ups can be sent as a reply in the same thread.
3. **Mailboxes** — choose which mailboxes send for the campaign. WeldReach rotates between them; each prospect keeps the same sender for the whole sequence.
4. **Schedule** — set the time zone, sending days, sending window and a daily limit.
5. **Launch.**

WeldReach pauses a mailbox or campaign automatically when too many emails bounce.

---

## Replies

Replies arrive in the WeldReach **Inbox**. A reply stops the sequence for that person (or, if you choose, for everyone at the same company).

- Each reply is labelled automatically, for example *interested*, *not interested* or *out of office*. Labelling uses AI credits from your workspace.
- Answer from the same mailbox, in the same thread.
- **Add to CRM** creates the person and company in WeldCRM, optionally with an opportunity.
- A reply asking to stop, and every bounce, is added to your suppression list so that address is never emailed again.

---

## Next steps

- [Install apps](/getting-started/install-apps)
- [Team and permissions](/settings/team-and-permissions)
