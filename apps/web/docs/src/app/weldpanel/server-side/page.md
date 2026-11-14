---
title: Server-side tracking and import
nextjs:
  metadata:
    title: Server-side tracking and import
    description: Send events and profile updates from your own server with a WeldPanel server key, and import historical events.
screenshots_todo:
  - file: weldpanel-server-keys.png
    shows: The Server keys tab with two keys, one active and one revoked, and the Create key button
---

Some events happen on your server, not in a browser: a renewed subscription, a payment, a background job. Send them with a **server key**, and import older events the same way. {% .lead %}

---

## Create a server key

1. Open **Projects**, click the project and open the **Server keys** tab.
2. Click **Create key**.
3. Name it after what will use it, such as `billing-backend`, and click **Create key**.
4. Copy the key (`wps_…`) and store it in your server's secrets. Click **I have saved it**.

The full key is shown only this once. WeldPanel stores only a hash of it, so a lost key cannot be recovered: create a new one.

A server key can send data, never read it. Keep it on your server and out of the browser.

The tab lists each key with when it was created and **Last used**. Click **Revoke** to stop a key. Anything that sends events with it stops working at once, and this cannot be undone.

Server keys need the manage permission for WeldPanel projects, which owners and admins have by default.

---

## Send events from Node.js or Workers

The SDK's server client runs on Node.js 18 and later, Cloudflare Workers, Deno and Bun.

```ts
import { createPanelServer } from '@weldsuite/panel-sdk/server';

const panel = createPanelServer({ secretKey: process.env.WELDPANEL_SECRET_KEY! });

panel.track({ name: 'Subscription renewed', distinctId: user.id, userId: user.id, props: { plan: 'pro' } });
panel.people.set(user.id, { email: user.email, plan: 'pro' });
panel.people.increment(user.id, 'renewals');

await panel.flush();
```

| Call | What it does |
| --- | --- |
| `track({ name, distinctId, userId?, props?, timestamp?, eventId?, url?, title? })` | Queues an event. `distinctId` says who it is about: use the same user id your site passes to `identify()`. Timestamps can be up to 7 days old. |
| `identify({ userId, anonId })` | Links a browser's anonymous id to a user, like `identify()` in the browser. |
| `people.set(userId, props)`, `set_once`, `unset`, `increment` | Profile updates, as in the browser, with the user id first. |
| `flush()` | Sends what is queued. Resolves to `{ accepted, dropped }`. |
| `import(events)` | Sends historical events now, with timestamps up to 5 years old. |

Events go out when you call `flush()`, or as soon as 100 are waiting. Call `flush()` before your process or request ends, for example `ctx.waitUntil(panel.flush())` on Cloudflare Workers.

Event names and properties follow the same rules as in the browser, see [Track events and identify users](/weldpanel/track-events#track-your-own-events).

---

## Or call the HTTP API

Post a batch of events to `/v1/track` with the key as a bearer token:

```bash
curl -X POST https://pnl.weldsuite.org/v1/track \
  -H "Authorization: Bearer $WELDPANEL_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "lib": "server",
    "lib_version": "1.0.0",
    "events": [
      {
        "event_id": "8f2c6a4e-1b7d-4c3a-9e51-0d6f2b9a7c13",
        "name": "Subscription renewed",
        "ts": "2026-11-14T09:30:00Z",
        "distinct_id": "user_123",
        "props": { "plan": "pro" }
      }
    ]
  }'
```

- `event_id`: your own unique id for the event, 8 to 64 characters. Sending the same id twice counts the event once, so a retry is safe.
- `ts`: when it happened, as an ISO 8601 time.
- `distinct_id`: who it is about. Optional: `user_id`, `anon_id`, `url`, `title` and `props`.

The answer is `{ "accepted": 1, "dropped": 0 }`. A bad or revoked key gets a `401`.

---

## Import historical events

Use `import()` in the server client, or post the same body to `/v1/import`. Import takes timestamps up to 5 years old.

```ts
await panel.import(
  orders.map((order) => ({ name: 'Order placed', distinctId: order.customerId, timestamp: order.createdAt })),
);
```

---

## Limits

| | `/v1/track` | `/v1/import` |
| --- | --- | --- |
| Events per request | 100 | 1,000 |
| Oldest timestamp | 7 days | 5 years |

- Times in the future are not accepted. Events outside the window are counted in `dropped`.
- Server events get no country or device: there is no browser to read them from.
- A paused project accepts nothing: the answer says `accepted: 0`.
- Server and imported events count towards your monthly event allowance. See [Usage and billing](/weldpanel/usage-and-billing).
