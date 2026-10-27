# WeldPanel

Product and web analytics for WeldSuite customers, in the class of Mixpanel,
with session recordings, heatmaps and frustration signals in the class of
Microsoft Clarity. A customer adds a snippet to their website or web app and
gets traffic numbers, funnels, retention, user paths and user profiles, and can
watch what a visitor actually did when a number looks wrong.

The point of having both in one module: every chart leads to the recordings
behind it. A funnel step with a big drop-off has a "watch the people who
dropped here" button; a rage-click spike links to the sessions it came from.

## Decisions (agreed 2026-10-27)

| Question | Decision |
|---|---|
| Placement | Its own platform module (`/weldpanel`, own sidebar entry, app code `weldpanel`) with two workers: `panel-api` (Clerk, `panel-api(-test).weldsuite.org`, one per module, API-001) and `panel-ingest`, a public collector (`pnl.weldsuite.org` / `pnl-test.weldsuite.org`), the same split as desk-api and helpdesk-widget-api (DESK-003). |
| What is tracked in v1 | Any website through a script snippet, and web apps with logged-in users (`identify()`, user profiles, a server-side event API). |
| Not in v1 | One-switch tracking on WeldSuite-hosted sites, replacing Mixpanel in the platform itself, mobile SDKs. See "Later". |
| Event storage and queries | Cloudflare Basin: Pipelines → Iceberg tables on R2 → Basin SQL, the stack EVT-014 already chose. Reports are typed query specs compiled to SQL on the server, so the engine can be swapped (ClickHouse) without touching the UI. |
| Clarity features in v1 | Session recordings, heatmaps (click, scroll, area), frustration signals (rage clicks, dead clicks, quick backs, excessive scrolling, JS errors) and AI session summaries. |
| Billing | Each plan includes a monthly allowance of events and recordings. Usage above it is charged from the prepaid credit wallet (BILL-005); with an empty wallet, recordings stop and events are capped. |
| CRM | Link, don't create. An identified user whose email matches a WeldCRM person shows their website activity and recordings on the person page. Nothing is written to WeldCRM. |
| Consent | Cookieless counting before consent: anonymous pageviews and events with a daily-rotating visitor hash, no cookies or storage, no recordings, no identity. Full tracking starts when the site calls `consent.grant()`. Sites outside the EU can switch consent off per project. |
| Residency | EU only, for all workspaces. Recordings in an EU-jurisdiction R2 bucket. The Basin event tables on a normal bucket with location hint `weur` (Western Europe): a Basin catalog cannot use an EU-jurisdiction bucket (phase 0 spike), and ClickHouse EU was turned down (decided after the spike, 2026-10-27). |

## Concepts

- **Project**: one thing being tracked: a website or a web app. A workspace can
  have several. Has a public **project token** (`wpk_…`, safe to put in page
  source, write-only), optional **secret keys** (`wps_…`, server-side ingest and
  imports), allowed domains, and settings: autocapture, masking level, recording
  sample rate, consent mode, excluded URLs, IP and bot filters, retention.
- **Event**: something that happened: `$pageview`, `$pageleave`, `$autocapture`
  (a click or form submit), the frustration events (`$rageclick`, `$deadclick`,
  `$quickback`, `$excessivescroll`, `$exception`), or a custom event from
  `track('Signed up', { plan: 'pro' })`. Has a timestamp, a distinct id, a
  session id, standard columns (URL, referrer, UTM, device, geo) and custom
  properties.
- **Visitor ids**: an **anonymous id** (random, kept in the browser after
  consent; before consent a server-side daily hash of salt + project + IP + user
  agent), and a **user id** once the site calls `identify('user_123')`. The
  **distinct id** is the user id when known, else the anonymous id.
- **Identity link**: anonymous id → user id, written on `identify()`. One user
  id can have many anonymous ids (devices); an anonymous id links to at most one
  user id (Mixpanel's simplified ID merge). Resolved at query time, so events
  sent before login count towards the user.
- **Person (user profile)**: properties of an identified user (`$email`,
  `$name`, plan, company…) set with `people.set()`. Mutable and erasable.
- **Session**: a visit. Starts on the first event, ends after 30 minutes without
  events. Client-generated id after consent; derived at query time (gaps over
  30 minutes) for cookieless visitors.
- **Recording**: the rrweb capture of one session, stored as numbered chunks.
  Not every session is recorded: a per-project sample rate decides, and never
  before consent.
- **Report**: a saved query (insight, funnel, retention, flow) with a name and
  an owner. **Dashboard**: a grid of reports. **Cohort**: a saved filter on
  people ("signed up in the last 30 days and did not upgrade").

## Architecture

```
 customer site ── @weldsuite/panel-sdk ──▶ panel-ingest (pnl.weldsuite.org)
                                              │  token → KV → project, settings, quota state
                                              │  geo/UA enrich, bot filter, consent mode
                                              ├──▶ Basin streams (one per table) ──▶ events_v1, identities_v1,
                                              │                                     people_v1, replay_chunks_v1
                                              ├──▶ R2 `weldsuite-panel-replays` (EU)  recording chunks
                                              └──▶ PanelProject DO (people, identity, live visitors)
                                                   PanelUsage DO (per workspace: counts, quota)

 platform ── /api/panel/* ──▶ panel-api ──▶ Basin SQL (REST)        reports, recordings list, heatmaps
                                       ├──▶ R2 replays (proxied)     player
                                       ├──▶ PanelProject DO          people, live
                                       ├──▶ tenant DB                projects, reports, dashboards
                                       └──▶ @weldsuite/ai            summaries (credits)
```

### `panel-api` worker (`apps/workers/panel-api`)

Scaffolded with `pnpm create:module-api panel` on `@weldsuite/worker-kit`.
Registered in `packages/core/api-modules/src/index.ts` as
`mod('panel', 8825, ['weldpanel'], ['/api/panel'])` and in
`API_FORWARD_MODULES` with a `PANEL_API` binding on app-api.

Routes (Clerk, `apiAuth()`), organised by object:

| Route | Purpose |
|---|---|
| `/api/panel/projects` | list, create, get, update, delete |
| `/api/panel/projects/:id/rotate-token` | issue a new project token; the old one stops at once |
| `/api/panel/projects/:id/keys` | create and revoke secret keys (phase 3) |
| `/api/panel/projects/:id/settings` | domains, autocapture, masking, sampling, consent mode, exclusions, retention |
| `/api/panel/projects/:id/install` | install snippets and status (events seen in the last 24 hours) |
| `/api/panel/query` | `POST` a typed query spec (below), returns rows plus `dataAsOf` |
| `/api/panel/reports` · `/dashboards` · `/cohorts` | saved objects, CRUD |
| `/api/panel/lexicon` | event and property names seen, with descriptions and hidden flags |
| `/api/panel/people` | list and search; `/:distinctId` profile, activity feed, recordings; `DELETE` erases (GDPR) |
| `/api/panel/people/by-email` | for the WeldCRM person card |
| `/api/panel/sessions` | recordings list with filters; `/:id` metadata and chunk manifest; `/:id/chunks/:seq` streams a chunk from R2; `/:id/favorite` |
| `/api/panel/sessions/:id/summary` | AI summary of one recording (generate, cached) |
| `/api/panel/insights/summarise` | AI summary of a set of recordings (for example the people who dropped at funnel step 3) |
| `/api/panel/heatmaps` | heatmap data for a page group and device class, plus the snapshot to draw it on |
| `/api/panel/live` | visitors right now, current pages |
| `/api/panel/usage` | events and recordings this month against the plan allowance, overage charged |

### `panel-ingest` worker (`apps/workers/panel-ingest`)

Public, no Clerk, not on `apiAuth()` (like helpdesk-widget-api). Must never
open a tenant database: a busy website would keep the workspace's Neon compute
awake all day (DATA-008).

| Route | Purpose |
|---|---|
| `GET /s.js` | the loader script, versioned and cached at the edge |
| `GET /c/:token` | client config: sampling, masking, consent mode, excluded URLs (cached) |
| `POST /e` | a batch of events: uncompressed `text/plain` JSON up to 64 KiB (`sendBeacon` must be synchronous, so no `CompressionStream`), or `fetch` keepalive |
| `POST /r` | one recording chunk (`session`, `seq`, gzip body) |
| `POST /v1/track` · `/v1/import` | server-side events with a secret key; import accepts old timestamps |

Per request:

1. Token → project. KV `panel:project:<token>` holds workspace id, project id,
   settings and status, written by panel-api whenever a project changes. The
   tenant `panel_projects` row is the source of truth; the master registry
   `panel_project_registry` only routes (DATA-009 pattern), and KV caches
   the registry. Phase 1 reads only KV: the collector has no database binding
   and no secrets at all. Secret keys (phase 3) are looked up by SHA-256 hash,
   like `api_key_registry`; if that needs the master DB, panel-ingest gets it
   but never `DATABASE_ENCRYPTION_KEY`, so it cannot decrypt a tenant DB URL
   even by mistake.
2. `Origin` must match an allowed domain (or a subdomain) when the project lists
   any. Per-IP rate limits. Known bots dropped (user-agent list, plus
   Cloudflare's verified-bot flag where the zone provides it).
3. Enrichment on the server: country, region and city from `request.cf`,
   device, browser and OS from the user agent. The IP is used for geo and the
   cookieless hash only, never stored. Query parameters that look like secrets
   (`token`, `email`, `password`, `key`…) are stripped from URLs.
4. Quota state from KV `panel:quota:<workspace>` (`ok`, `replay_blocked`,
   `events_blocked`), written by the PanelUsage DO.
5. Write events to the Basin stream through the pipeline binding, recording
   chunks to R2, identity and people operations to the PanelProject DO, and
   counts to the PanelUsage DO (aggregated per isolate, flushed every few
   seconds). Answer `204` straight away; the writes run in `waitUntil`.

### Durable Objects (in panel-ingest)

- **PanelProject**, one per project, SQLite storage:
  - `people`: distinct id, user id, email, name, properties JSON, first and last
    seen. The source of truth for profiles: mutable, searchable, erasable.
  - `identities`: anonymous id → user id.
  - `erased`: ids erased but not yet rewritten out of Iceberg (queries exclude
    them).
  - `live`: sessions seen in the last five minutes, for the live view.
  - On change it writes a profile snapshot to `people_v1` and the link to
    `identities_v1`, so reports can filter and break down by user properties.
  - Scaling: if one project outgrows a single object, `people` and `identities`
    shard by hash of the distinct id; live and settings stay in one.
- **PanelUsage**, one per workspace: events and recordings per day and month
  across all projects; flushes to the master table `panel_usage_monthly`;
  settles overage with the wallet (see "Plan allowance and overage"); writes
  the quota state to KV.

### Basin tables

A catalog on the bucket `weldsuite-panel` (`weldsuite-panel-test` for test),
namespace `panel`. One stream, sink and pipeline per table: a pipeline is
billed for everything it reads, so fanning one stream out by a `kind` column
would bill it once per table, while stream ingress is free (phase 0 spike).
Roll interval 60 seconds, compaction and snapshot expiration on. Data is one
to two minutes behind.

| Table | Rows | Key columns |
|---|---|---|
| `events_v1` | one per event | `event_id`, `workspace_id`, `project_id`, `name`, `ts`, `received_at`, `distinct_id`, `anon_id`, `user_id`, `session_id`, `cookieless`, `url`, `host`, `path`, `title`, `referrer`, `referrer_host`, `utm_source/medium/campaign/content/term`, `country`, `region`, `city`, `device_type`, `browser`, `os`, `viewport_w`, `el_selector`, `el_text`, `x`, `y`, `rel_x`, `rel_y`, `scroll_depth`, `error_message`, `properties` (JSON string), `lib`, `lib_version` |
| `identities_v1` | one per link | `workspace_id`, `project_id`, `anon_id`, `user_id`, `ts` |
| `people_v1` | one per profile change | `workspace_id`, `project_id`, `user_id`, `version`, `ts`, `properties` (JSON), `deleted` |
| `replay_chunks_v1` | one per chunk | `workspace_id`, `project_id`, `session_id`, `seq`, `ts_start`, `ts_end`, `bytes`, `has_full_snapshot`, `r2_key` |

- Catalog sinks offer no partitioning or sort order (phase 0 spike): files
  follow arrival time, which prunes time ranges well, but every file holds
  every project, so a project filter cannot skip files. Scan size per query
  follows the whole platform's volume in the time range. See "Risks".
- Custom properties are a JSON string read with `json_get_str` / `json_get_float`.
  If that proves slow for hot properties, a `_v2` table adds typed columns.
- Current profile = `QUALIFY ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY version DESC) = 1`.
- A person is `COALESCE(identities.user_id, events.distinct_id)`.
- There is no session table: the recordings list and session metrics are
  aggregates over `events_v1` and `replay_chunks_v1` by `session_id`.

### Query layer

Reports never send SQL. The client posts a typed spec, Zod-validated in
`@weldsuite/app-api-client/schemas/weldpanel`; `@weldsuite/panel-domain`
compiles it to Basin SQL:

| Kind | What it answers |
|---|---|
| `web` | visitors, visits, pageviews, bounce rate, visit duration, top pages, entry and exit pages, sources, UTMs, countries, devices, browsers |
| `trends` | count, unique users, per-user average, or sum/average of a property, over time, filtered, broken down by a property, compared with the previous period |
| `funnel` | ordered steps (event + filters), conversion window, strict or loose order, breakdown, time to convert, drop-off per step |
| `retention` | first event → return event, by day, week or month |
| `flows` | the most common paths before or after an event |
| `sessions` | the recordings list: duration, pages, clicks, frustration counts, errors, user, device, country |
| `heatmap` | clicks per element and position, scroll depth distribution, for a page group and device class |

Rules:

- The compiler always adds `workspace_id = … AND project_id = …` from the
  authenticated context and a time range (at most the project's event
  retention, 25 months at most). The Basin token
  sees every workspace (EVT-014), so a unit test runs every spec kind through
  the compiler and fails if a query lacks either filter.
- Basin SQL takes no bind parameters, so event names and property keys are
  checked against a strict pattern and every literal goes through one escaping
  function, also tested.
- Results are cached in KV per workspace and spec hash for two minutes. The UI
  shows how fresh the data is.
- Read the table once where possible: every extra reference (a subquery, a
  CTE, a join) is another full scan. Top-N breakdown values are picked in
  panel-api from a first result, not in a subquery (6.7 s → 1.2 s in the
  spike). The identity join is added only for projects that have identified
  users. Standard fields stay typed columns; custom properties are JSON
  (about 1.7× the bytes of a typed column).
- The low-level REST call (`basinSql(env, sql)`) is shared with
  `packages/domains/core/src/analytics-query.ts`, not copied.
- Funnels are per-step CTEs (each step joins the previous step's
  person-and-timestamp set, not the raw event table twice). Whether this stays
  fast at volume is the main thing phase 0 measures.

### SDK (`packages/sdk/panel-sdk`, `@weldsuite/panel-sdk`, MIT per OPS-002)

- **Snippet**: `<script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…"></script>`.
  The npm package exposes the same API for apps that bundle it.
- **Core** (target under 10 KB gzipped): `init`, `track`, `identify`, `reset`,
  `people.set` / `set_once` / `unset` / `increment`, `consent.grant()` /
  `revoke()`, `optOut()`. Pageviews including SPA navigation (History API),
  `$pageleave` with scroll depth, autocapture of clicks and form submits (element
  text masked by the masking level), UTM and referrer capture, session
  handling, batching with retry, `sendBeacon` on unload.
- **Frustration detection** in the browser:
  - rage click: 3 or more clicks within 700 ms and 30 px;
  - dead click: a click followed by no DOM change, navigation or request within
    1 second, on an element that looks clickable;
  - quick back: back to the previous page within 7 seconds;
  - excessive scrolling: direction changes at least 4 times while scrolling
    past 3 page heights within 20 seconds;
  - JS errors: `error` and `unhandledrejection`, message, source and line,
    deduplicated per session.
- **Recording plugin**, loaded only when the session is sampled and consent
  was given, so sites that don't record never download it. rrweb (MIT)
  `record()`, flushed every 10 seconds or 64 KB, gzipped with
  `CompressionStream`. Masking levels:
  - *strict*: all text and inputs masked, images blocked;
  - *balanced* (default): all inputs masked, page text visible;
  - *relaxed*: only passwords and fields marked sensitive masked.

  Password fields are always masked. Attributes `data-panel-mask`,
  `data-panel-unmask` and `data-panel-block` adjust per element. Cross-origin
  iframes are not recorded. Canvas and video are off.
- **Server**: the same package's `server` entry posts to `/v1/track` with a
  secret key (fetch-based, so it runs on Node and Workers).
- **Consent**: without consent nothing is written to cookies or storage, no
  session id is kept, `identify()` and `people.*` calls are dropped and the
  recording plugin is not loaded. A `GPC` signal counts as no consent, also on
  a project with `consentMode: 'none'`, until the site calls `grant()`.

### Recordings

- Chunks go to the private R2 bucket `weldsuite-panel-replays` (EU
  jurisdiction; `-test` for test) at
  `<retention tier>/<workspace>/<project>/<yyyy-mm-dd>/<session>/<seq>.json.gz`,
  and one row per chunk to `replay_chunks_v1`. The bucket has no public domain
  (EVT-015); the player reads chunks through panel-api after a permission check.
- Retention by R2 lifecycle rule per tier prefix (`30d/`, `90d/`). A favourite
  is copied to the `keep/` prefix (13 months), the way Clarity keeps favourites.
- The player is `rrweb-player` inside the module: timeline with event markers
  (pages, clicks, frustration, errors, custom events), skip inactivity, speed,
  page list, error list, the person and their other sessions, and the AI
  summary panel.
- Recordings list filters: date, duration, pages visited, entry and exit page,
  country, device, browser, user or cohort, did / did not do an event,
  frustration type, has errors, favourites.
- One R2 object per chunk costs class A operations on long sessions. If that
  shows up in the bill, the PanelProject DO can buffer chunks and write larger
  objects; not in v1.

### Heatmaps

- Click data comes from `$autocapture` events: element selector, position
  relative to the element (`rel_x`, `rel_y`) and the viewport width class
  (desktop, tablet, mobile). Positions relative to elements keep heatmaps right
  across screen sizes and small layout changes.
- Pages are grouped by URL pattern (`/products/*`), defined in the heatmap view.
- Types: **click** (points), **area** (share of clicks per element), **scroll**
  (how far down people get, from `$pageleave` scroll depth).
- Background: a masked full snapshot of the page from a recent recording of
  that page group and device class, rendered with the rrweb replayer in a
  sandboxed iframe, with the heat layer drawn over the resolved elements. When
  no recording covers the page, `/c/:token` asks the next consented visitor's
  SDK for one masked snapshot of it.

### AI

Through `@weldsuite/ai` and charged with `chargeAiUsage` / `billedModelId` from
`@weldsuite/core-domain/ai-billing` (AI-001, AI-005), run in panel-api.

- **Session summary**: the recording and its events are turned into a compact
  text timeline (pages and time on each, clicked element text, form fields
  touched (labels only, never values), frustration events, errors, where the
  session ended), then summarised: what the visitor tried to do, where they got
  stuck, and whether they succeeded. Cached in `panel_ai_summaries`.
- **Set summary**: up to 20 sessions from a filter or a funnel drop-off,
  summarised one by one (cached), then grouped into themes with example
  sessions.
- Only masked content reaches the model. A project can switch AI off.
- Later: questions in plain language turned into a query spec (never SQL), and
  WeldPanel tools for WeldAgent workspace agents.

### Data model (tenant DB, `packages/core/db/src/schema/weldpanel.ts`)

Configuration and saved objects only. No event data, no profiles.

| Table | Holds |
|---|---|
| `panel_projects` | name, kind (`website`/`app`), token, allowed domains, settings JSON, status, created by |
| `panel_reports` | name, kind, spec JSON, owner, visibility (private / workspace) |
| `panel_dashboards`, `panel_dashboard_tiles` | layout and the reports on it |
| `panel_cohorts` | name, filter spec |
| `panel_event_definitions` | lexicon: description, hidden, verified, per event and property |
| `panel_heatmap_pages` | saved page groups (URL patterns) |
| `panel_session_favorites` | favourited recordings and notes |
| `panel_ai_summaries` | cached summaries (session or set), model, credits charged |

Master DB: `panel_project_registry` (token → workspace and project, status, a
settings snapshot for the collector), `panel_key_registry` (hashed secret keys),
`panel_usage_monthly` (workspace, month, events, recordings, overage charged).
Schema files can be added; migrations are generated only after approval.

### CRM link

Resolved when someone looks, never at ingest, so no tenant database wakes up for
website traffic.

- The WeldCRM person page gets a "Website activity" card. It calls
  `/api/panel/people/by-email`; panel-api asks the workspace's PanelProject DOs
  for profiles with that email and returns last seen, recent events and
  recordings.
- The WeldPanel profile page shows "Open in WeldCRM" when a CRM person with the
  profile's email exists, looked up through `@weldsuite/crm-domain/people` when
  the page opens.

### Privacy and GDPR

- EU storage: recordings under the EU jurisdiction, event tables in Western
  Europe by location hint. The DPA and the customer-facing wording say
  exactly that, not "EU jurisdiction" for everything. No IP addresses stored.
- Cookieless until consent, as above. A `consentMode: 'none'` project setting
  for sites that don't need it.
- Erasure (`DELETE /api/panel/people/:distinctId`, or by email): the profile
  and identity links go from the PanelProject DO at once and the ids land in
  `erased`, which every query excludes. Recording chunks are deleted from R2
  straight away (found through `replay_chunks_v1`). The Iceberg rows are
  rewritten by a weekly job, well within GDPR's one month.
- Iceberg deletes need an engine Basin SQL is not (it is read-only): a small
  PyIceberg job on Cloudflare Containers, fed by an erasure queue. The same job
  drops partitions past a project's retention.
- WeldPanel's tables hold pseudonymous ids and customer-defined properties.
  That is an exception to EVT-014's "no personal data in analytics tables",
  covered by its own ADR (PANEL-002) and made safe by the erasure job.
- Customers need to name WeldSuite as a processor for this data: the DPA and
  sub-processor list need an update before launch.

### Plan allowance and overage

- Allowances per plan, as a `weldpanel` limit in the plan definitions, exposed
  through the licence context `licenceGate()` caches (SEC-007). There is no
  generic per-plan quota mechanism yet; the WeldSign plan proposed the same
  shape, so whichever lands first should make it shared. Proposal in "Open
  items".
- PanelUsage DO counts and settles: once a month's usage passes the allowance,
  it charges the wallet with `consumeCredits` in blocks (10,000 events, 100
  recordings), idempotent per workspace, month and block, like WeldMeet's
  per-minute billing. Rates in `SERVICE_CREDIT_RATES` and a master
  `system_settings` row `weldpanel.pricing`, editable in the admin console.
- When the wallet cannot cover a block: recordings stop at once
  (`replay_blocked`); events continue for 10% over the allowance, then are
  dropped until the next month, a top-up or an upgrade (`events_blocked`).
- Owners get an email and the module a banner at 80% and 100% of the allowance
  and when data is being dropped.

### Platform UI (`apps/web/platform/app/weldpanel/`)

Route wrappers in `src/routes/weldpanel/`, hooks in
`hooks/queries/use-weldpanel-queries.ts`, charts with the platform's existing
recharts components, a project switcher in the module header.

| Page | Contents |
|---|---|
| Overview | web analytics dashboard (Plausible-like) with live visitors |
| Insights | trends builder: events, measure, filters, breakdown, chart type, compare |
| Funnels | step builder, conversion, time to convert, drop-off → recordings |
| Retention | cohort grid |
| Flows | top paths from or to an event |
| Users | list with filters and cohorts; profile with properties, timeline, recordings, CRM link |
| Recordings | list and filters, player, AI summary, favourites |
| Heatmaps | page group, device, click / area / scroll |
| Frustration | rage and dead clicks, quick backs, errors: trends, top pages and elements, recordings |
| Dashboards | saved reports in a grid |
| Settings | projects, install (snippet, npm, server key), privacy and masking, consent, recording sample rate, lexicon, usage |

Every string in en and nl (`packages/core/i18n/src/locales/{en,nl}/weldpanel.ts`).

### Entity events

Config mutations publish entity events as usual: `panel_project`
(`created`, `updated`, `deleted`), `panel_report` and `panel_dashboard`
(`created`, `updated`, `deleted`), so the audit log, realtime list refresh and
WeldConnect keep working. Tracked visitor events never go on the entity bus:
too many of them, and they carry customer user data (EVT-005).

### Permissions

App `weldpanel` in `packages/core/permissions/src/apps.ts`, objects prefixed
like `sign_*`:

- `panel_projects:read|create|update|delete|manage`: `manage` covers keys,
  privacy settings and usage.
- `panel_reports:read|create|update|delete`: reports, dashboards, cohorts.
- `panel_recordings:read|delete`: kept apart from reports, because a recording
  shows what a visitor saw and did, the way WeldPass keeps `read` and `reveal`
  apart (PASS-002).
- `panel_people:read|delete`: profiles carry emails; `delete` is erasure.
- Defaults: OWNER/ADMIN all; MEMBER `panel_projects:read`, reports read and
  create (own), recordings read, people read; VIEWER `panel_projects:read`
  and `panel_reports:read` (shared reports and dashboards, no recordings or
  profiles).

## Phases

| Phase | Scope | Done when |
|---|---|---|
| 0. Spike and skeleton | Basin spike (below). `panel-api` and `panel-ingest` scaffolds, api-modules entry and forwarder, schema (no migration until approved), permissions, app registration in `use-installed-apps.ts`, `app-registry.ts` and the app store, feature flag (SEC-008), empty module page, docs-repo design doc and ADRs | Spike numbers written down and go/no-go agreed; module installs and opens behind the flag; CI green |
| 1. Collect | Projects and keys, master registry and KV, `/s.js`, `/c`, `/e`, SDK core (pageviews, SPA navigation, autocapture, custom events, UTM, sessions, consent and cookieless mode, batching), Basin stream, pipelines and tables, enrichment, bot filter, install check, usage counting (no enforcement yet) | A test site's events land in `events_v1` with correct geo and device; in cookieless mode the browser stores nothing |
| 2. Web analytics and insights | Query compiler, cache, `dataAsOf`, Overview dashboard, live visitors, trends builder, saved reports, dashboards, lexicon | Overview numbers match a hand count on the test site; a saved report survives a reload |
| 3. People and funnels | `identify` / `reset` / `people.*`, PanelProject DO, identity resolution in queries, Users list and profile, server-side `/v1/track` and `/v1/import`, funnels, retention, flows, cohorts, WeldCRM person card | Events sent before login count for the user after `identify()`; a 4-step funnel matches a hand-computed result |
| 4. Recordings and frustration | Recording plugin and masking levels, `/r`, EU replay bucket and lifecycle rules, recordings list and player, favourites, frustration detection in the SDK, Frustration page, funnel drop-off → recordings | A recorded session replays with no unmasked input; a deliberate rage click shows up as a filter hit and a marker in the player |
| 5. Heatmaps | Click, area and scroll queries, page groups, device classes, snapshot rendering, snapshot request through `/c` | Heatmap for a page with known clicks puts them on the right elements at desktop and mobile widths |
| 6. AI | Session summary, set summary from a filter or funnel drop-off, credit charging, project AI switch | A summary is charged once, cached, and never contains masked text |
| 7. Billing, privacy and launch | Plan allowances, PanelUsage settlement, quota states in KV, banners and emails, erasure and retention job on Containers, DPA update, help docs (`apps/web/docs`) | Over-allowance usage is charged once per block; an erased user is gone from reports, recordings and (within a week) Iceberg; flag removed |

Phase 0 spike, on the test account with synthetic data (50M events across 200
projects, one project with 5M):

1. Can a Basin Catalog sink write to an EU-jurisdiction bucket, and can Basin
   SQL query it? (The sink docs currently say it does not support writing "to
   R2 buckets into a different jurisdiction".)
2. Latency and bytes scanned for a 30-day trends query with a breakdown, a
   4-step funnel with a 7-day window, 8-week retention and a recordings-list
   aggregate, on the 5M-event project. Target: p95 under 5 seconds, no
   budget-gate rejections.
3. Cost of `json_get_*` on custom properties against a typed column.
4. Basin Pipelines pricing at 50M and 500M events a month.

If (1) fails, see "Risks". If (2) fails, the query layer stays and the store
behind it changes; ClickHouse Cloud (EU) is the fallback.

### Progress

**Phase 0, started 2026-10-27.**

Done:

- `apps/workers/panel-api` scaffolded (`pnpm create:module-api panel`, port
  8825, owns `/api/panel`, no routes yet); app-api forwards `/api/panel` over
  `PANEL_API`; secrets entry in `scripts/secrets/manifest.ts`.
- `apps/workers/panel-ingest`: Hono skeleton with `/health` only, custom
  domains `pnl-test.weldsuite.org` / `pnl.weldsuite.org`, added to
  `deploy.yml`'s worker list.
- Schema with generated migrations (approved 2026-10-27): tenant
  `packages/core/db/src/schema/weldpanel.ts` (migration `0232_weldpanel`) and
  master `weldpanel-registry.ts` (migration `0061_weldpanel_registry`).
- Permissions: app `weldpanel`, objects `panel_projects`, `panel_reports`,
  `panel_recordings`, `panel_people`, with role defaults.
- Platform: app registry, logo, sidebar, catalog fallback, breadcrumbs,
  `/weldpanel` with an empty-state home page, en + nl strings, tests.
- App Store seed entry, unpublished until phase 1 works. That row is the gate
  for now, as it was for WeldSign; no Flagship flag yet.

- Basin spike, run 2026-10-27, results in
  [weldpanel-research/basin-spike.md](weldpanel-research/basin-spike.md): go
  for Basin; no EU jurisdiction for catalog buckets (location hint works); one
  stream per table; query rules above; project mixing is the scaling risk.
  All spike resources deleted.
- Residency decided: event tables on Basin with location hint `weur`,
  recordings in the EU-jurisdiction bucket.
- Design doc and ADRs PANEL-001 to PANEL-007 merged in
  `weldsuite-documentation` (weldsuite/weldsuite-documentation#50).

**Phase 1 (Collect), started 2026-10-27.**

Done:

- `@weldsuite/panel-domain` (`packages/domains/panel`): the KV project record
  and keys, default settings, `wpk_` tokens, the SDK→collector wire format
  (Zod; the envelope is strict, each event is checked on its own so a bad
  event costs that event, not the batch), the `events_v1` row type and its
  stream schema file.
- `@weldsuite/panel-sdk` (`packages/sdk/panel-sdk`, MIT): snippet with a
  queueing stub, npm `init()`, pageviews incl. SPA navigation, `$pageleave`
  with scroll depth, click and submit autocapture (masked text, never input
  values, `data-panel-block` / `data-panel-mask`), `track()`, consent
  (cookieless until `grant()`, GPC, `revoke`, `optOut`), excluded URLs,
  batching with `sendBeacon`. 5.1 KB gzipped; the build fails above 10 KB.
- panel-ingest: `/s.js`, `/c/:token`, `POST /e` with CORS; KV only; origin,
  bot, paused, IP-filter and excluded-path drops; clock-skew correction;
  secret-looking query params, fragments and credentials stripped from URLs;
  geo from `request.cf`, its own user-agent parser; the cookieless id
  `ck_` + SHA-256(daily salt, project, IP, UA), with the salt held by the
  `PanelSalt` Durable Object and deleted after a day; `PanelUsage` counts
  events per workspace and day (no enforcement yet); `panel:seen:<project>`
  for the install check. Click vs submit is kept in the reserved `$action`
  property, as `events_v1` has no column for it. No rate limiting yet.
- panel-api: projects CRUD, settings, pause, token rotation, install info
  (snippet from the SDK's own `installSnippet`), registry + KV sync, entity
  events `panel_project`.
- Platform: home with project picker and install status, projects list,
  project page (Install, General, Privacy & collection, Danger zone), en + nl.
- Basin: test bucket `weldsuite-panel-test` (`weur`) with stream
  `weldpanel_events_test`, sink and pipeline into `panel.events_v1`,
  compaction and snapshot expiration; production bucket `weldsuite-panel`
  (`weur`) and stream `weldpanel_events`.
- Verified on test (2026-10-27): panel-ingest deployed from the branch, a
  temporary project in test KV, a real page with the snippet in a browser.
  All 11 events landed in `events_v1` within two minutes with the right
  consent state, masking, UTM, stripped `token=` parameter, `$action`, geo
  and device; the excluded page sent nothing. The temporary project was
  removed from KV; its rows stay in the test table.

Open:

- Production sink and pipeline (and catalog compaction / snapshot expiry):
  waiting for a dedicated catalog token in Doppler `prd`
  (`PANEL_CATALOG_TOKEN`). Until then production events would queue in the
  stream without reaching a table.
- panel-api secrets on test and production (`pnpm secrets:sync <env> panel-api`)
  before the UI can create projects there.
- Per-IP rate limiting on `/e`.
- Help docs (`apps/web/docs`) once the module is published.

## Later (not in v1)

- One-switch tracking on WeldSuite-hosted sites (customer websites, help
  center, booking and sign portals), no snippet needed.
- Replace Mixpanel in the platform with WeldPanel (`apps/web/platform/lib/analytics.ts`,
  `providers/mixpanel-provider.tsx`).
- WeldDesk: the helpdesk widget passes the WeldPanel session id with a
  conversation, so the agent can watch what the visitor just did. Cheap once
  recordings exist.
- React Native SDK (events first, recordings later) and a `weldpanel-app`
  (MOB-001).
- First-party collector domains (`stats.customer.com` through Cloudflare for
  SaaS custom hostnames) so ad blockers don't drop events.
- Group analytics (companies, linked to WeldCRM companies), alerts and anomaly
  detection, experiments and feature flags.
- WeldConnect triggers on tracked events ("visitor viewed pricing three times"),
  WeldAgent and MCP tools, a `panel:read` query API on external-api.
- Import from Mixpanel and GA4; export to CSV and to the customer's warehouse
  (the data already sits in Iceberg).
- Questions in plain language turned into reports.

## Docs repo

A design doc `design/modules/weldpanel.md` in `weldsuite-documentation` and
ADRs under a new `PANEL` area, written in phase 0 (skill `weldsuite-docs`):

- PANEL-001 WeldPanel is its own module with two workers: `panel-api` (Clerk)
  and `panel-ingest` (public collector that never opens a tenant DB).
- PANEL-002 Events, identity links, profile snapshots and the recording chunk
  index live in Basin Iceberg tables; pseudonymous ids and customer properties
  are allowed there, removed by an erasure job (an exception to EVT-014).
- PANEL-003 Reports are typed query specs compiled on the server; clients never
  send SQL; every query is scoped to workspace and project by the compiler.
- PANEL-004 Profiles and identity live in a Durable Object per project; the
  WeldCRM link is resolved on read.
- PANEL-005 Recordings are masked rrweb chunks in a private EU bucket, read
  through panel-api, kept by lifecycle prefix.
- PANEL-006 Cookieless until consent.
- PANEL-007 Plan allowance with overage from the credit wallet.

## Risks

- **EU residency of the event tables.** A Basin catalog cannot use an
  EU-jurisdiction bucket, so the event tables sit on a bucket with location
  hint `weur`: stored in Western Europe, without a jurisdictional guarantee
  (decided 2026-10-27). A customer who needs the guarantee for analytics data
  cannot get it in v1. Switch the bucket to the EU jurisdiction once Basin
  supports it (it needs new tables, so a `_v2` migration); ClickHouse EU
  behind the same query layer stays the fallback. Recordings are under the EU
  jurisdiction already.
- **Project mixing.** Every Basin file holds every project, so the bytes a
  report scans grow with the whole platform's traffic, not the customer's. Fine
  at launch (the spike's 5M-event project ran its reports in 1.5–5.8 s on a
  50M-event table, with no budget rejections). Track bytes scanned per query
  from phase 2. When it grows: shard the event table by a hash of the project
  into N streams and tables, give big projects their own table, rewrite recent
  files sorted by project with the PyIceberg job, or move to ClickHouse.
- **Account limits.** Basin allows 20 streams, 20 sinks and 20 pipelines per
  account. WeldPanel needs 4 of each per environment (one per table), and
  EVT-014's per-module tables want more. Request a limit increase early.
- **One Basin token for every workspace.** Isolation rests on the compiler; the
  tests above guard it.
- **Ad blockers.** A new collector domain is not on block lists yet, but will be
  once WeldPanel is known. First-party domains are the answer (Later).
- **Site performance.** The core SDK must stay small; the recording plugin
  loads only for sampled, consented sessions.

## Open items

- Allowances per plan (proposal, plan slugs `free` / `business` / `scale` /
  `enterprise`): Free 50k events / 500 recordings; Business 1M / 5k; Scale
  5M / 25k; Enterprise 20M / 100k. Overage rate per 10k events and per 100
  recordings to set with the wallet pricing.
- Retention per plan (proposal): events 12 months on Free, 25 months above;
  recordings 30 days (90 on Scale and Enterprise); favourites 13 months. A
  favourite outlives its events on Free, so the player must work from the
  chunks alone there, or favourites keep their events too.
- The rest of the open questions the design doc lists (grace counting when the
  wallet is empty, the cookieless salt's storage, EU placement of the Durable
  Objects and the KV query cache, permissions for heatmaps and the live view).
- Default recording sample rate (proposal: 100% up to the plan allowance, with
  a per-project override).
- Collector host name: `pnl.weldsuite.org` is a proposal; avoid words block
  lists match (`analytics`, `track`, `collect`).
- Legal: DPA and sub-processor update, wording customers can use in their own
  privacy policy and consent banner (en/nl).
