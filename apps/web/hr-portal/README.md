# hr-portal — WeldHR workforce portal

White-label portal where a company's **employees** and its **client contacts**
sign in to view schedules, leave, coaching, evaluations, tasks, performance
(employees) or their team's shared metrics and support requests (clients).

Mirrors `apps/web/commerce-portal`'s structure: Next 15 App Router, a
`[workspace]` dynamic segment carrying the workspace slug, email + one-time-code
sign-in, server-side `app/api/*` route handlers that proxy to `app-api` and
keep the session token in an httpOnly cookie, Tailwind v4, `@weldsuite/ui`.

The backend contract lives at
`apps/workers/app-api/src/routes/public-hr-portal/index.ts`, mounted at
`/public/hr-portal/*` on `app-api` (unauthenticated mount — the workspace is
resolved from `?slug=` / `X-Workspace-Slug`, sessions are bearer tokens this
app stores as an httpOnly `hrportal_session` cookie).

## Running locally

```bash
# terminal 1 — backend
pnpm --filter app-api dev          # http://localhost:8789

# terminal 2 — this app
pnpm --filter hr-portal dev        # http://localhost:3022
```

Then open `http://localhost:3022/<workspace-slug>/login`. WeldHR's workforce
portal has to be enabled for that workspace (WeldHR → Workforce portal →
Settings) or `/config` 404s and the login page shows the neutral "This portal
is not available" screen.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_API_URL` | `http://localhost:8789` | Origin of the `app-api` worker. Server-side only (used by `app/api/*` route handlers and `middleware.ts`) — never sent to the browser. |
| `HR_PORTAL_DEFAULT_HOSTS` | `team.weldsuite.org,team-test.weldsuite.org,localhost:3022` | Comma-separated hosts that serve the app directly at `/<slug>/...` (no rewrite). Any other host is treated as a custom domain — see below. |

## Custom domains

In production a workspace can point its own hostname (e.g. `team.acme.com`)
at this app. `middleware.ts` resolves that hostname to a workspace slug via
`GET /public/hr-portal/resolve-host?host=<hostname>` on `app-api` and rewrites
the request from `/<path>` to `/<slug>/<path>` (root `/` goes to
`/<slug>/login`, since there's no `/[workspace]` index page — employees and
clients land on different sub-paths). That endpoint is implemented: the
mapping is written when a workspace saves its custom domain under **WeldHR →
Workforce portal → Branding**.

The lookup is defensive by design — any failure (network error, non-2xx,
unexpected body) falls through and the request continues unrewritten, so a
backend hiccup never breaks the portal on its own default hosts. Successful
lookups are cached in-memory per middleware instance for 5 minutes; this is a
best-effort optimization only (Edge instances recycle often) and nothing
relies on it for correctness.

## i18n

This app does **not** use `@weldsuite/i18n` — that package's locale files are
owned by other agents and shouldn't be touched here. Instead it keeps its own
dictionary under `lib/i18n/`:

- `en.ts` — the canonical dictionary (`Dictionary` type is inferred from it)
- `nl.ts` — typed as `Dictionary`, so a missing or misspelled key is a
  `type-check` failure, not a runtime one
- `context.tsx` / `locale.ts` — a small React context (`I18nProvider`,
  `useI18n()`) plus the locale cookie (`hrportal_locale`) and
  `Accept-Language` detection used to pick the initial locale server-side in
  `app/layout.tsx`

The user-menu language toggle in `components/portal-topbar.tsx` flips the
cookie and in-memory locale; no page reload needed since the dictionaries are
plain JS objects. Every new user-visible string needs an entry in **both**
`en.ts` and `nl.ts`, in the same place in the object.

## Structure

- `app/[workspace]/login/page.tsx` — branded email → code → (optional picker)
  sign-in flow
- `app/[workspace]/(portal)/layout.tsx` — authenticated shell (fetches `/me`,
  applies branding, renders `PortalTopbar`, redirects to login on 401 — see
  `lib/client.ts`)
- `app/[workspace]/(portal)/me/**` — employee pages (home, schedule, leave,
  coaching, evaluations, tasks, performance)
- `app/[workspace]/(portal)/client/**` — client pages (overview, team member,
  milestones, requests)
- `app/api/auth/*` — request/verify/select/logout route handlers; these are
  the only place the session token touches a `Set-Cookie` header
- `app/api/portal/[...path]/route.ts` — generic authenticated proxy used by
  every other endpoint (`/config`, `/me`, `/employee/*`, `/client/*`)
- `lib/types.ts` — response shapes mirroring
  `apps/workers/app-api/src/services/weldhr/{portal-self-service,client-view}.ts`.
  `HrClientView` is imported type-only from `@weldsuite/app-api-client` so the
  client overview page can't silently drift from the backend contract.
- `lib/client.ts` — browser-side fetch helpers; redirect to `/<slug>/login`
  on a `401` is centralized here
- `middleware.ts` — custom-domain → slug rewrite (see above)

## Verification

```bash
pnpm --filter hr-portal type-check
pnpm --filter hr-portal lint
pnpm --filter hr-portal build
```

## Known follow-ups

- No automated tests yet (commerce-portal, the pattern this mirrors, has
  none either).
- The client "Milestones" page reuses `/client/overview` (there's no
  standalone `/client/milestones` endpoint — the overview response already
  carries the full shared-milestones list).
