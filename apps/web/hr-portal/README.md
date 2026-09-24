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

## Rendering, caching and live updates

**Server-rendered.** Every page under `app/[workspace]/` is a server
component. `page.tsx` loads that page's data from app-api with the session
cookie (`lib/server/portal.ts`) and hands it to the client view (`view.tsx`)
through TanStack Query's `HydrationBoundary`. The HTML already contains the
data, and the browser doesn't refetch it on hydration. The signed-in layout
loads `/me` the same way, so an expired session gets a real HTTP redirect to
`/<slug>/login`. The workspace layout sets the title and favicon from the
branding in `generateMetadata`, and brand colours are inline CSS variables, so
the first paint is already on-brand.

Times are rendered in the time zone stored in the `hrportal_tz` cookie, on the
server and in the browser alike, so hydration matches. On a first visit both
render in UTC, then `TimeZoneSync` stores the browser's zone and refreshes once.

**Caching.**
- Client side, reads are cached in memory under `['portal', slug, path, query]`
  (`lib/query-client.ts`). Moving between pages is instant and entries
  revalidate in the background after 30 seconds.
- Server side, the public branding config (`/config`) is cached for 60 seconds.
- Nothing is written to browser storage. This is personal HR data on possibly
  shared devices. The cache is dropped on sign-in, on sign-out and on a 401.
- On the server a fresh QueryClient is made per request. Never share one: it
  would leak one user's data into another user's render.

**Live updates.** `usePortalRealtime` (mounted by `PortalShell`) opens a
WebSocket to the realtime worker's `/ws/hr-portal`. It authenticates with a
single-use ticket from `GET /public/hr-portal/realtime/ticket`, which app-api
stores in the shared KV. The socket joins the workspace's separate
`hrportal:<orgId>` hub, never the staff hub. It can subscribe only to
`hrportal.workspace` plus the user's own `hrportal.employee.<id>` or
`hrportal.client.<companyId>` topic.

app-api publishes a `{ entity, id }` signal there on every WeldHR change. The
portal invalidates the matching cached queries, and mounted pages refetch
through the normal API. Some changes also show a toast, for example "Your leave
request was approved". Internal coaching logs, draft evaluations and records
not shared with the client are never signalled to the portal.

## Deployment

Vercel project **`weldsuite-hr-portal`** (team `weldsuite`), Git-connected to
this repo with root directory `apps/web/hr-portal` — the same setup as
`booking-portal` and `meeting-portal`. Build settings live in `vercel.json`.
It is not part of `.github/workflows/deploy.yml`; Vercel's Git integration is
the releaser.

| Branch | Vercel target | Hostname | `APP_API_URL` |
| --- | --- | --- | --- |
| `main` | Production | `team.weldsuite.org` | `https://app-api.weldsuite.org` |
| `develop` | Preview (branch domain) | `team-test.weldsuite.org` | `https://app-api-test.weldsuite.org` |
| other branches | Preview | `*.vercel.app` | `https://app-api-test.weldsuite.org` |

`HR_PORTAL_DEFAULT_HOSTS` is `team.weldsuite.org,team-test.weldsuite.org` in
every environment. These hostnames match what `app-api` puts in invite emails
(`hrPortalOrigin()` in `apps/workers/app-api/src/services/weldhr/portal-mail.ts`).

DNS: both hostnames are CNAMEs to `cname.vercel-dns.com`.

**Customer domains.** A workspace's custom domain (WeldHR → Workforce portal →
Branding) has to be added to this Vercel project as well, and the customer
points a CNAME for it at `cname.vercel-dns.com`. Saving the domain in WeldHR
only writes the host → workspace lookup the middleware uses; adding it to
Vercel is currently a manual step.

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
  `HrClientView` mirrors the type of the same name in
  `packages/clients/app-api-client/src/domains/weldhr.ts`; change both together.
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
- Adding a customer's custom domain to the Vercel project is manual. It can be
  automated from the portal branding save in app-api (it already calls the
  Vercel API for WeldPass).
