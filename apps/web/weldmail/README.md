# WeldMail Web

Consumer WeldMail SPA — claim a `@weldmail.com` address and use a personal inbox.
UI matches the WeldSuite platform (Inter, shell chrome, mail list/detail patterns).

## Setup

```bash
pnpm install
pnpm --filter weldmail-web dev
```

Runs on [http://localhost:3200](http://localhost:3200).

## Environment

Copy `.env.example` or set:

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (required) | — |
| `VITE_PERSONAL_API_URL` | personal-api base URL | `http://localhost:8787` (prod: `https://api.weldmail.com`) |
| `VITE_REALTIME_URL` | realtime worker WebSocket, including the `/ws/personal` path | derived from the hostname (`ws://localhost:8790/ws/personal` locally) |

## Clerk Billing

WeldMail uses **Clerk Billing for users** (not organizations). Configure this in the Clerk Dashboard:

1. Enable **Billing** for **Users** (`npx clerk@latest enable billing --for users`).
2. Create a **User Plan** with slug `weldmail_pro`.
3. Optionally add feature slug `weldmail_pro` on that plan.
4. Free users stay on the default (no plan) — 50 sends/day, 1 address.

The app:

- `/pricing` — `<PricingTable for="user" />`
- `/account` — `<UserProfile />` (subscription / payment methods)
- Shell shows **Pro** badge when `has({ plan: 'weldmail_pro' })`

personal-api reads the same plan from JWT claims and enforces daily send limits (free 50 / pro 500).

## Cloudflare Email (backend)

Outbound: personal-api `[[send_email]]` binding → Cloudflare Email Sending.

Inbound: apex `weldmail.com` Email Routing catch-all → `mail-inbound-worker` (one-time zone setup). Authorize Email Sending for `*@weldmail.com` so MAIL FROM works.

`mail-inbound-worker` needs `DATABASE_URL_PERSONAL` (the shared personal Neon DB)
alongside `DATABASE_URL_MASTER`. Without it, a delivery to a `@weldmail.com`
address resolves its registry row and then fails to store — see
`scripts/secrets/manifest.ts`.

## Notifications

New mail reaches an open tab over the realtime worker rather than by polling:

1. `mail-inbound-worker` stores the message, then publishes `mail:new` to the
   owner's own hub (`personal:<clerkUserId>`, topic `mail.<clerkUserId>`).
   Personal accounts have no Clerk org, so they cannot use the workspace hub.
2. The SPA connects to `/ws/personal` on the realtime worker, which verifies the
   Clerk JWT **without** requiring an org and limits the subscription to that
   user's own mail and notification topics.
3. `MailEventsProvider` owns the single socket: it drives the sidebar unread
   badge, prepends the new row in the inbox, and raises a desktop notification
   when the browser has granted permission (asked once, on first signed-in load).

## Scripts

- `pnpm dev` — Vite dev server (port 3200)
- `pnpm build` — typecheck + production build
- `pnpm preview` — preview production build
