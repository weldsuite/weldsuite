# Help center: Next.js on Vercel → TanStack Start on Cloudflare Workers (pilot)

Status: Draft, not started. Pilot for ADR FE-015 (Proposed) in
`weldsuite-documentation`, which amends FE-007. Next: Phase 0 (count custom
domains, enable Cloudflare for SaaS on the test zone).

## Goal

Rebuild `apps/web/helpcenter` as a TanStack Start app that runs as a
Cloudflare Worker, with the same pages, branding, URLs and SEO output as today.
Customer domains move from the Vercel project to Cloudflare for SaaS custom
hostnames. The pilot settles whether FE-015 becomes the rule for every public
portal, so it measures as it goes (see "Exit criteria").

## Decisions

| Topic | Decision |
|---|---|
| Framework | TanStack Start (React 19, file-based TanStack Router routes, server functions, server routes). Pin the current 1.x when Phase 1 starts. |
| Build / host | `@cloudflare/vite-plugin`, one Worker with static assets. Names: `helpcenter-dev` at the top level, `helpcenter-test` / `helpcenter` under `[env.test]` / `[env.production]`. |
| Where | In place, in `apps/web/helpcenter` (same package name, same port 3008). There is no parallel app. Vercel keeps serving its last deployment until DNS moves. |
| Data | Same `/public/helpcenter/*` mount on desk-api. The transport changes to a `DESK_API` service binding; `HELPCENTER_API_URL` stays as the local-dev fallback. |
| Caching | `caches.default` with a TTL per call, keyed by upstream URL. Same TTLs as today: content 60 s, config uncached, sitemap 3600 s. |
| Tenant | The domain comes from the `Host` header in server code and is passed through router context. There is no `/[domain]/…` path rewrite. |
| Custom domains | Cloudflare for SaaS custom hostnames on the `welddesk.org` zone, with a Worker route `*/*` on that zone, managed through `@weldsuite/cloudflare-zones` (official SDK `customHostnames`). |
| Schema | No change. `helpcenter_domains` already has `dnsStatus`, `sslStatus`, `verificationError` and `dnsConfig`, which can hold what Cloudflare reports. |

**Out of scope:**
- the desk-api public routes themselves
- the WeldDesk settings UI, apart from the CNAME target it displays
- other portals
- `admin`, `docs` and `api-docs`

## Current state

27 source files. The only Next-specific code is listed below.

| Today (Next 16.4) | Where | Replacement |
|---|---|---|
| `proxy.ts` rewrites host → `/[domain]/…` and sets security headers | `proxy.ts` | Start request middleware: resolve the domain from `Host` and set the same four headers on every response |
| `app/[domain]/{page,articles/[slug],category/[id],search}` server components | `app/[domain]/**` | Routes `/`, `/articles/$slug`, `/category/$id`, `/search` with server-function loaders |
| `generateMetadata` (branding, OG image, favicon, per-article title) | `[domain]/layout.tsx`, article and category pages | Route `head()` built from loader data |
| `notFound()` | layout, article, category | `throw notFound()` + `notFoundComponent` |
| ISR via `fetch(…, { next: { revalidate } })` | `lib/api-client.ts` | `cachedFetch(url, ttl)` over `env.DESK_API.fetch`, stored in `caches.default` |
| Route handlers: `sitemap.xml`, `robots.txt`, `api/feedback` | `app/**/route.ts` | Start server routes at the same paths |
| `next/link`, `usePathname`, `useRouter` | Breadcrumbs, Header, Sidebar, TableOfContents, SearchBar | `@tanstack/react-router` `Link`, `useLocation`, `useNavigate` |
| `next/image` (logo) | `Header.tsx` | Plain `<img>` with width and height |
| `next/font/google` (Inter) | `app/layout.tsx` | Self-hosted `@fontsource-variable/inter` |
| `cookies()` / `headers()` for locale | `app/layout.tsx` | Read the request in the root route's server function; `createHeaderAdapter` already runs on Workers |
| `MetadataRoute.Sitemap` type | `lib/sitemap-xml.ts` | A local type |

These carry over unchanged: `next-themes` (it has no Next.js dependency),
`@weldsuite/i18n`, the CSS sanitiser and accent-colour guard in the domain
layout, `sanitize-html`, Tailwind v4 and every component's markup.

`flexsearch`, `@algolia/autocomplete-core` and `react-highlight-words` are
imported nowhere and get dropped.

## Phases

### Phase 0: Facts and accounts (no code)

1. Count help-center custom domains in master `helpcenter_domain_registry`,
   split into:
   - WeldHost-zone domains, where desk-api wrote the CNAME and can rewrite it.
   - Customer-managed DNS, where the customer has to change the CNAME.

   This sizes the cutover in Phase 5 and the Cloudflare for SaaS cost.
2. Enable Cloudflare for SaaS on the test zone and on `welddesk.org`, and
   create the fallback-origin hostname customers will CNAME to (proposed
   `custom.welddesk.org`).
3. Settle the test hostname for helpcenter (`*.welddesk-test…`?). Nothing in
   the repo names one today.
4. Record the baseline on Vercel: TTFB p50/p95 for the home and article pages
   on two tenants, the Lighthouse SEO and performance scores, and the response
   HTML for one article (meta tags, sitemap, robots).

### Phase 1: Scaffold

- Replace Next with TanStack Start + `@cloudflare/vite-plugin` in `apps/web/helpcenter`:
  - `vite.config.ts`, `wrangler.jsonc` (or `.toml`) with the names above
  - `DESK_API` service bindings per env, `nodejs_compat`
  - `src/routes/__root.tsx`
- Port `styles/tailwind.css` with `@tailwindcss/vite` in place of PostCSS.
- `pnpm dev` runs on 3008 through the Cloudflare Vite plugin, with the
  `HELPCENTER_API_URL` fallback when no `DESK_API` binding is present.
- Check that `pnpm --filter @weldsuite/api-modules test` (`wrangler-config.test.ts`)
  passes for the new config.

### Phase 2: Port pages and data

1. `lib/api-client.ts` → server-only module.
   - `upstream(path, params)` picks `env.DESK_API` or the URL fallback.
   - `cachedFetch` wraps it, with a TTL argument per call.
   - The exported function signatures stay the same, so the pages barely change.
2. Request middleware: domain from `Host` (localhost → `<sub>.welddesk.org`,
   default `test.welddesk.org`, as `proxy.ts` does today) plus the security
   headers.
3. Routes and `head()`, as in the table. Keep `extractHeadings` and the
   layout's `sanitizeCss` / `accentColor` as they are.
4. Server routes `sitemap.xml`, `robots.txt`, `api/feedback`. The feedback
   POST keeps its body validation and goes through `DESK_API`.
5. Components: swap `next/*` imports for TanStack Router and remove
   `'use client'` (not needed in Start).
6. Run `sanitize-html` under `wrangler dev` with `nodejs_compat` on a real
   article. If it doesn't run, move sanitising to the client or use a
   Workers-safe sanitiser.

Done when every page, plus `sitemap.xml` and `robots.txt`, renders locally
against `pnpm dev:api`. The HTML must match the Next build for the same
tenant: title, description, OG, favicon, `lang`, brand CSS variable, custom CSS.

### Phase 3: CI and test deploy

- `.github/workflows/deploy.yml`:
  - New `frontend-helpcenter` job, modelled on `frontend-weldmail`:
    `pnpm build` then `pnpm exec wrangler deploy --env $CF_ENV`. It runs after
    `workers`, so desk-api deploys first.
  - Gate it on a `release_helpcenter` output from `prepare`, using the same
    change detection the Vercel apps get today (folder plus workspace deps).
- Remove `helpcenter` from `.github/scripts/vercel-apps.mjs`; delete
  `vercel.json` and `next.config.mjs`.
- `ci.yml`: confirm the type-check and lint jobs pick the app up. It isn't
  named in `.github/scripts/typecheck-targets.mjs` today, so check how that
  script finds apps.
- Deploy to test and attach the test wildcard route. Repeat the Phase 2
  checks on the test host.

### Phase 4: Custom hostnames in desk-api

- `@weldsuite/cloudflare-zones`: add `createCustomHostname`,
  `getCustomHostname` and `deleteCustomHostname` with the tree-shakable
  `customHostnames` resource. Follow CLAUDE.md: `createClient({ resources })`,
  never `new Cloudflare()`.
- Add `lib/custom-hostnames.ts` next to `apps/workers/desk-api/src/lib/vercel.ts`,
  which stays until Phase 5 is done.
- **Gate by environment.** A `HELPCENTER_HOSTING` var (`vercel` | `cloudflare`)
  in each `wrangler.toml` env picks the path. `HELPCENTER_CNAME_TARGET` (the
  fallback-origin hostname) is read only when it is `cloudflare`.
  - Test is set to `cloudflare` when this phase ships. The test Worker and its
    route have been live since Phase 3.
  - Production stays on `vercel` through this phase. It switches in Phase 5,
    step 2, once the production Worker serves the fallback origin.
  - Shipping this phase therefore changes nothing in production. Without the
    gate, a domain added before the cutover would CNAME to an origin no Worker
    serves yet, and re-verifying a domain still on Vercel would fail.
- `routes/helpcenter-settings/index.ts`, on the `cloudflare` path:
  - Add domain: create the custom hostname, then the CNAME (WeldHost zones).
    Roll back on failure, as today.
  - Verify: read the custom hostname's `status` and `ssl.status` into
    `dnsStatus` / `sslStatus` / `verificationError`. This replaces the
    DNS-over-HTTPS check.
    - A domain with **no custom hostname** has not been migrated yet. It is not
      a failure: fall back to the existing CNAME check and leave the stored
      status alone.
  - Delete: remove the custom hostname if one exists, and the Vercel
    registration if one exists.
- Pass the zone id and API token as worker config. Add the token to
  `scripts/secrets/manifest.ts`; remove `VERCEL_*` from the manifest and
  `wrangler.toml` only after Phase 5.
- Tests: extend the desk-api tests for the settings routes with a mocked SDK
  client, covering add, verify, rollback and delete.
- The platform's help-center domain settings show the new CNAME target. Any
  changed string needs `en` and `nl`.

### Phase 5: Production cutover

1. Deploy `helpcenter` to production on the `*/*` route of `welddesk.org`.
   Before DNS moves it serves nothing.
2. Set `HELPCENTER_HOSTING = "cloudflare"` and `HELPCENTER_CNAME_TARGET` for
   production desk-api and deploy it. From here, new domains get a custom
   hostname that the Worker from step 1 serves.
3. `*.welddesk.org`: repoint the wildcard record from Vercel to the Worker.
   Spot-check five tenants.
4. Back-fill a Cloudflare custom hostname for every active registry domain,
   with a one-off script in `apps/tools`.
   - WeldHost-zone domains: rewrite their CNAME to the new target in the same script.
   - Customer-managed domains: email the workspace owner, and show "action
     required" in settings.
   - Vercel keeps serving those domains from the last deployment, against the
     live API, until each one switches.
5. After four weeks, or once no customer-managed domains are left:
   - remove the domains from the Vercel project and archive the project
   - drop `lib/vercel.ts` and the `VERCEL_*` secrets from desk-api

**Rollback:**
- Repoint the `*.welddesk.org` wildcard to Vercel. Its last deployment still works.
- Set production `HELPCENTER_HOSTING` back to `vercel`, so new domains are
  registered on Vercel again.
- WeldHost-zone CNAMEs can be rewritten back by the same script.
- Keep the Vercel project until the exit criteria are met.

### Phase 6: Measure and decide

Compare against the Phase 0 baseline, then flip FE-015 to **Accepted** (and
mark FE-007 and DESK-006 as amended) or to **Deprecated**.

## Exit criteria

- Feature parity: every route, `sitemap.xml`, `robots.txt`, feedback, locale,
  theme, custom CSS and favicon override work on test and production.
- SEO parity: the Phase 0 article HTML has the same `<title>`, description,
  OG and canonical tags. Search Console shows no new crawl errors after two
  weeks.
- Performance: TTFB p95 for cached article pages is no worse than on Vercel.
  Lighthouse performance and SEO scores are within 5 points.
- Runtime: the compressed Worker bundle is well under the plan limit, CPU time
  p99 per request fits the plan, and the error rate is no worse than Vercel's.
- Domains: a new custom domain goes from add to served-with-TLS without manual
  steps, on test and on production.
- Effort: record the actual days spent. That number is the estimate for the
  remaining portals.

## Risks

- **Customer-managed domains** depend on customers changing DNS. Phase 0
  sizes this; dual-running through Vercel covers the gap.
- **Cloudflare for SaaS cost** per hostname above the included amount. Check
  it in Phase 0 against the domain count.
- **`sanitize-html` on Workers.** Checked early in Phase 2, with a fallback.
- **Library maturity.** Pin TanStack Start and the Vite plugin. Upgrades are
  separate PRs.
- **Cache invalidation** stays TTL-only, as with ISR. Purging on article
  publish is a later improvement (desk-api could call the Cache API through
  the Worker), not part of the pilot.

## Open questions

- The test hostname for the help center (Phase 0, step 3).
- The fallback-origin hostname name (`custom.welddesk.org` is a proposal).
- Should the feedback endpoint move from the Worker to a direct browser call
  to desk-api's public mount? It stays as a server route for now, to keep
  FE-008's "API origin is server-only" rule.
