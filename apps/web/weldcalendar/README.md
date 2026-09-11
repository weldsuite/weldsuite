# WeldCalendar Web

Consumer WeldCalendar SPA — personal calendars and public booking pages on the
shared personal Weld account (same `personal_accounts` row as WeldMail).

## Setup

```bash
pnpm install
pnpm --filter weldcalendar-web dev
```

Runs on [http://localhost:3201](http://localhost:3201).

## Environment

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (required) | — |
| `VITE_PERSONAL_API_URL` | personal-api base URL | `http://localhost:8787` (prod: `https://api.weldmail.com`) |
| `VITE_BOOKING_PORTAL_URL` | Public booking portal origin | `http://localhost:3019` |

## Clerk Billing

WeldCalendar uses **Clerk Billing for users** (not organizations):

1. Enable Billing for Users.
2. Create a User Plan with slug `weldcalendar_pro`.
3. Free users: 1 calendar, 1 booking page. Pro: 10 / 10.

This plan is independent of `weldmail_pro`.

## Clerk Dashboard

Same Clerk application as WeldMail (`clerk.weldsuite.org`). Add these to
**Allowed origins** and **Redirect URLs**:

- `https://weldcalendar.weldsuite.org`
- `https://weldcalendar-test.weldsuite.org`

Create a **User Plan** with slug `weldcalendar_pro` (independent of `weldmail_pro`).

## Cloudflare Pages

CI deploys `weldcalendar-web` / `weldcalendar-web-test`. Attach custom domains:

- production: `weldcalendar.weldsuite.org`
- test: `weldcalendar-test.weldsuite.org`
