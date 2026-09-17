# WeldApps Developer Portal

Developer-facing SPA for creating, deploying, and managing WeldApps.
Talks to the same `app-api` `/api/user-apps` routes as the platform manage UI.
CLI uploads (`weld app deploy`) continue to use `external-api` `/v1/user-apps`.

## Setup

```bash
pnpm install
pnpm --filter developer-web dev
```

Runs on [http://localhost:3202](http://localhost:3202).

## Environment

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (required) | — |
| `VITE_APP_API_URL` | app-api base URL | `http://localhost:8789` (hosted builds derive from hostname) |
| `VITE_PLATFORM_URL` | Platform SPA origin for deep links | derived from hostname |
| `VITE_ENVIRONMENT` | `test` \| `production` | — |

## Clerk Dashboard

Same Clerk application as the platform. Add to **Allowed origins** and **Redirect URLs**:

- `https://developer.weldsuite.org`
- `https://developer-test.weldsuite.org`
- `http://localhost:3202` (local)

## Cloudflare Pages

CI deploys `developer-web` / `developer-web-test`. Ops must create the Pages
projects (Git auto-deploy **off**) and attach custom domains:

- production: `developer.weldsuite.org` → project `developer-web`
- test: `developer-test.weldsuite.org` → project `developer-web-test`

## Related

- Platform manage UI: `/apps/manage` on `app.weldsuite.org`
- CLI: `@weldsuite/cli` (`weld app create|dev|deploy|publish`)
- Plan: project store `docs/developer-portal.md`
