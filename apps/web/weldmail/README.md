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

## Scripts

- `pnpm dev` — Vite dev server (port 3200)
- `pnpm build` — typecheck + production build
- `pnpm preview` — preview production build
