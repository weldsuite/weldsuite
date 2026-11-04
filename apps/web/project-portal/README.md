# project-portal: WeldFlow client project portal

Where a client follows a project the team shares with them
(`projects.weldsuite.org/<workspace>`, `projects-test.weldsuite.org/<workspace>`):
progress, milestones, the latest status report, shared files and documents, the
message thread, and the approvals addressed to them (accept a deliverable,
approve a change). Clients are CRM contacts, not workspace members (ADR FLOW-020).

TanStack Start on a Cloudflare Worker (FE-015), Tailwind v4, `@weldsuite/ui`.
No Clerk, no database, no secrets of its own.

## How it talks to the API

Only server side, only flow-api's public routes (`/public/project-portal/*`):
over the `FLOW_API` service binding when deployed, and `FLOW_API_URL`
(default `http://localhost:8804`) in local dev. See `lib/server/flow-api.ts`.

## Sessions

Sign-in is an emailed six-digit code. `/auth/verify` returns a session token,
which goes into an httpOnly cookie per workspace (`pp_session_<slug>`, 30 days,
Secure outside local dev, SameSite=Lax) and never reaches browser JavaScript.
Every call forwards it as `Authorization: Bearer`. The sessions themselves live
in flow-api's KV, so this Worker has no KV binding. A 401 clears the cookie and
sends the reader to the sign-in page. Downloads go through
`/<workspace>/download/...`, which adds the session and streams the file.

## Texts

`packages/core/i18n/src/locales/{en,nl}/project-portal.ts`, section `portal`.
The language is the `locale` cookie, then Accept-Language; the server sends only
that dictionary with the page.

## Running locally

```bash
pnpm --filter flow-api dev          # http://localhost:8804
pnpm --filter project-portal dev    # http://localhost:3024/<workspace>
```

## Deploy

Workers `weldsuite-project-portal-test` and `weldsuite-project-portal`, custom
domains in `wrangler.toml`, released by `deploy.yml` (`frontend-project-portal`)
after the workers. The build picks the environment
(`CLOUDFLARE_ENV=test pnpm build`); the deploy is a plain `wrangler deploy`.
