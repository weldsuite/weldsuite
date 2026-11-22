# WeldMail: unsubscribe from inside an email

Status: phase 1 implemented (2026-11-21).

Gmail puts an **Unsubscribe** button next to the sender of every newsletter.
One click and Gmail asks the sender to stop, without the user visiting the
sender's site. WeldMail already does the asking. This plan puts the button
where people look for it, inside the open email.

## What already exists

| Piece | Where |
|---|---|
| `mail_subscriptions`: one row per (mailbox, sender address), with the `List-Unsubscribe` targets and RFC 8058 one-click flag | `packages/core/db/src/schema/mail-subscriptions.ts` |
| Rows upserted on every inbound message that carries `List-Unsubscribe` | `apps/workers/mail-inbound-worker/src/lib/email-storage.ts` |
| Backfill from stored messages | `POST /api/mail-subscriptions/scan` |
| The unsubscribe itself, done server-side: RFC 8058 one-click POST, else a `mailto:` request sent from the mailbox, else the sender's page handed back for the client to open | `POST /api/mail-subscriptions/:id/unsubscribe`, `@weldsuite/email/list-unsubscribe` (`performUnsubscribe`) |
| Both backends answer these routes | `apps/workers/mail-api/src/routes/mail-subscriptions`, Rust `mail` module |
| Manage subscriptions page | platform `/weldmail/subscriptions`, mobile `app/subscriptions.tsx` |

## The gap

1. The open email has no Unsubscribe button. The user has to know the
   Subscriptions page exists and find the sender there.
2. Marking a newsletter as spam does not offer to unsubscribe (Gmail:
   *Report spam and unsubscribe*).
3. Small bug: the "scan complete" toast prints a literal `{count}`; the page
   passes `subscriptions`.

## Design

**No backend, schema or migration change.** The reading pane finds the
sender in the mailbox's subscription list (`GET /api/mail-subscriptions?accountId=`)
by lower-cased sender address, which is already a subscription's identity
(`mail_subscriptions_account_sender_uidx`). The list is fetched once per
mailbox and cached by React Query, so opening emails costs no extra request
while the cache is fresh (1 minute).

Considered and rejected: a per-message "has List-Unsubscribe" flag. Messages
don't keep that header today, so it would take a tenant migration, a change to
the mailbox Durable Object schema and a Rust port, for the same answer the
subscription row already gives.

### Platform (`apps/web/platform/app/weldmail`)

- `lib/unsubscribe.ts`: the rules the Subscriptions page already had
  (sender label, link-only check, confirm copy per method, result toast), moved
  out so the page and the reading pane share them, plus
  `findSenderSubscription` and `canUnsubscribe`.
- `components/unsubscribe-sender-button.tsx`: the button beside the sender in
  the message header.
  - Shown when the sender has an **active** subscription with a URL or mailto
    target. After unsubscribing it turns into a muted "Unsubscribed" label.
  - Click opens the same confirm dialog as the Subscriptions page; the copy
    says what will happen (one-click request, unsubscribe email, or the
    sender's page opening in a new tab).
  - Link-only senders: the page opens synchronously inside the confirm click
    so the popup blocker allows it.
- More-actions menu: **Report spam and unsubscribe**, shown when the sender
  can be unsubscribed without leaving WeldMail (one-click or mailto) and the
  email is not already in Spam. Unsubscribes first, then marks as spam.
- `useUnsubscribeMailSubscription` writes the returned row into the cached
  list before refetching, so the button flips at once.

### Mobile (`apps/mobile/weldmail-app`)

- Message screen: an Unsubscribe chip under the sender when the sender has an
  active subscription, with the same confirm and outcomes as the mobile
  Subscriptions screen (link-only opens the in-app browser).
- `services/mail-tenant.ts`: `findSenderSubscription`, shared by both screens.

### Permissions and events

Unchanged: listing needs `messages:read`, unsubscribing `messages:update`
(both on the existing routes), and the route already publishes
`mail_subscription:unsubscribed`.

## Later (not in phase 1)

- **Suggest unsubscribing** from senders whose mail the user never opens
  (Gmail's "you haven't opened emails from this sender in 30 days"). Needs
  per-sender read counts: a store op in both store modes and the Rust port.
- **File mail that keeps arriving** after an unsubscribe (the page already
  marks such senders "Still sending"): offer Block sender there.
- Sort the Subscriptions page by volume as well as recency.
