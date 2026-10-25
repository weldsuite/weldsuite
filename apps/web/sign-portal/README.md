# sign-portal — WeldSign signer portal

Where people outside a workspace open and sign documents sent with WeldSign
(`sign.weldsuite.org`, `sign-test.weldsuite.org`). Signers have no account:
they open a personal link, `/r/<token>`, from the request email.

Mirrors `apps/web/hr-portal`: Next 15 App Router, server-side `app/api/*`
route handlers that proxy to `app-api` and keep the signer session in an
httpOnly `signportal_session` cookie, Tailwind v4, `@weldsuite/ui`. Unlike
hr-portal there is no workspace slug in the URL: sign-api finds the workspace
from the link token through the master `sign_link_registry`.

The backend contract is the `/public/sign-portal/*` mount on sign-api
(`apps/workers/sign-api`), reached through the app-api forwarder. See
`docs/plans/weldsign.md`.

**Status: phase 2.** `/r/<token>` runs the signer flow: code screen,
e-signature consent, pdf.js document view with the signer's fields, adopt a
signature, finish, decline and download. It is not in the deploy pipeline yet: add it to `.github/scripts/vercel-apps.mjs` and
`deploy.yml`'s `on.push.paths` once its Vercel project and the
`sign(-test).weldsuite.org` DNS exist.

## Running locally

```bash
# terminal 1 — backend (app-api + sign-api and the other module workers)
pnpm dev:api                         # app-api on http://localhost:8789

# terminal 2 — this app
pnpm --filter sign-portal dev        # http://localhost:3023
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_API_URL` | `http://localhost:8789` | Origin of the `app-api` worker. Server-side only (used by `app/api/*` route handlers); never sent to the browser. |
| `SIGN_PORTAL_SECRET` | none | Same value as sign-api's `SIGN_PORTAL_SECRET`. Sent as `X-Sign-Portal-Key` so sign-api accepts the signer IP this server reports. Without it, the evidence trail records this server's IP instead of the signer's. Server-side only. |

## Deploy

Vercel project `weldsuite-sign-portal` (team weldsuite, Root Directory
`apps/web/sign-portal`). Like the other portals it is released only by
`deploy.yml` (`.github/scripts/vercel-apps.mjs`): a push to `develop` that
touches this app or a package it uses deploys it to test
(`sign-test.weldsuite.org`, bound to the `develop` branch), a push to `main` to
production (`sign.weldsuite.org`). Vercel's own Git builds are off for both
branches (`vercel.json`).

On the Vercel project, Preview and Production each have `APP_API_URL`
(`https://app-api-test.weldsuite.org` / `https://app-api.weldsuite.org`) and
`SIGN_PORTAL_SECRET` (Sensitive; the Doppler `test` / `prd` value, the same as
sign-api's). sign-api's `SIGN_PORTAL_URL` points signing links at these hosts.
