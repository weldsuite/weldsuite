---
title: Sending limits
nextjs:
  metadata:
    title: Sending limits
    description: How many people your workspace can email with WeldMail, what happens when you reach a limit, and where outreach campaigns belong.
---

WeldMail is for one-to-one business email. To keep your mail out of spam folders, every workspace has limits on how many people it can email. {% .lead %}

---

## Why there are limits

Mail providers judge every sender by how recipients react. A burst of unwanted mail from one workspace hurts the delivery of everyone's email, including yours. The limits keep WeldMail trustworthy and stop it from being used for bulk or cold email.

Normal one-to-one email, such as quotes, follow-ups and replies to customers, stays far below them.

---

## What counts toward a limit

- **Recipients, not messages.** Everyone in **To**, **Cc** and **Bcc** counts. A message to five people uses five.
- **A rolling window.** Limits cover the last hour or the last 24 hours, not a calendar day, so they free up gradually. Some workspaces also have a monthly limit.
- **Per sender address and per workspace.** Each address has its own hourly and daily limit, and the workspace has a daily limit across all addresses.
- **New contacts.** A new contact is someone who has never written to your workspace. Writing first to many new people is the pattern the limits are built for, so it has its own, lower daily limit.
- **Replies.** Answering a message someone sent you has its own daily allowance. A busy day of new conversations does not stop you from replying to customers.

Mail sent by WeldCRM sequences, scheduled messages and automations counts the same way as mail you write by hand.

---

## Limits by trust level

Every workspace has a trust level. It grows with age and a clean sending record.

| Level | How you get it |
| --- | --- |
| **New** | Your workspace is younger than 14 days, or has no paid plan. |
| **Standard** | The default once your workspace is 14 days old and on a paid plan. |
| **Trusted** | Your workspace has paid for 60 days with very few bounces and complaints, or WeldSuite sets it. |

| Limit | New | Standard | Trusted |
| --- | --- | --- | --- |
| Recipients per message | 20 | 50 | 50 |
| Recipients per sender address per hour | 30 | 100 | 400 |
| Recipients per sender address per day | 150 | 500 | 2,000 |
| Recipients per workspace per day | 300 | 2,000 | 10,000 |
| New contacts per workspace per day | 50 | 200 | 1,000 |

Addresses on `weldmail.com` share one reputation with other workspaces, so they can reach at most 20 new contacts a day, whatever the level. Connect your own domain to send more.

{% callout title="These are the defaults" %}
WeldSuite can adjust the limits for your workspace. The **Sending limits** tab always shows the ones that apply to you right now.
{% /callout %}

---

## See your usage

Open **Settings**, choose **WeldMail** and open the **Sending limits** tab. It shows:

- your trust level and whether sending is active, restricted, on hold or suspended
- recipients used today against the workspace limit, new contacts used today, and the month so far
- usage per sender address, for the last hour and the last 24 hours
- deliveries over the last 7 days: delivered, hard bounces, soft bounces, complaints and rejected

A hard bounce means the address does not exist. A complaint means the recipient marked your mail as spam. A high share of either lowers your limits.

---

## When you reach a limit

WeldMail does not send the message and tells you why. It names the limit and says when you can send again. Nothing you wrote is lost: the message stays open in compose, or in your drafts, so you can send it later.

| Message | What it means | What to do |
| --- | --- | --- |
| Sending limit reached | An hourly, daily or monthly limit is full. | Wait for the time shown, or send fewer recipients. |
| New contacts limit reached | You reached today's limit for people who never wrote to you. | Wait, or reply to people who wrote to you. For outreach campaigns, use [WeldReach](/weldreach). |
| Too many recipients | The message has more recipients than your level allows. | Split it into several messages. |
| Recipient unavailable | A recipient asked not to receive mail from your workspace. | Remove them and send again. |
| Partly sent | Some recipients got the message and some did not. | The message is in **Sent**. Remove the people who already have it, then send again. |
| Can't send from this address | The address does not belong to your workspace. | Pick one of your own addresses. |
| New conversations paused, or sending suspended | Your workspace is restricted. See below. | Contact support. |

---

## If your workspace is restricted

If mail from your workspace triggers many bounces or complaints, or WeldSuite needs to review it, a banner appears at the top of WeldMail.

- **Restricted:** lower limits apply and you cannot email new contacts for now.
- **On hold:** new conversations are paused while WeldSuite reviews your sending.
- **Suspended:** sending is turned off.

While a workspace is restricted or on hold, **replies to messages you received still go through**. While sending is suspended, replies are blocked too, unless WeldSuite allows them. The banner shows the reason when there is one. Contact support if you think the restriction is a mistake.

People in a WeldCRM sequence show **Paused: sending limit** while their emails are held back.

---

## Outreach campaigns

WeldMail is not built for emailing people who do not know you. For campaigns to prospects, use [WeldReach](/weldreach). It sends from separate outreach mailboxes and domains, so a campaign never affects your normal email. WeldReach is available on request: an owner or admin can ask for access in the **App Store**.

---

## Keep your limits healthy

- Write to people who expect to hear from you, and remove addresses that bounce.
- Do not send the same message to many people who never wrote to you.
- Use your own domain for business mail instead of a `weldmail.com` address.
- Keep an eye on the **Sending limits** tab, especially after you import contacts or start a sequence.

---

## Next steps

- [Send and reply to email](/weldmail/send-email)
- [WeldReach overview](/weldreach)
- [WeldMail overview](/weldmail)
