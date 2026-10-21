# Workspace slug first in the URL: `/acme/weldcrm/…` (replaces `/w/acme/…`)

Status: PR 1 (reserve the names) in review. PR 2 not started. Supersedes the
URL *shape* of FE-013 ("Platform URLs name the workspace, as `/w/{slug}/…`",
Accepted). Everything else FE-013 built stays: the router rewrite, the shell's
workspace check, `toPublicPath()`, the not-found screen, and org-id links from
the backend.

Decided (2026-10-21):
- **Reserve only today's names.** That's today's app and page names and the
  `public/` folders. Customers may use other slugs starting with `weld`
  (`weldon`, `weld-masters`).
- **Apps are never at the root.** A bare `/weldcrm/…` is not a page of its
  own: it redirects to `/{slug}/weldcrm/…` in the tab's workspace, so old
  bookmarks and pre-FE-013 emails keep working. App names therefore stay
  reserved.

## Why this needs care

FE-013 rejected slug-first URLs for one reason: a slug and a top-level route
can be the same word. `/settings/team` could be the Settings page or a
workspace called `settings`, and every new module adds another name that
existing workspaces may already use. `/w/` avoided that by construction.

This plan removes the prefix and handles the collision explicitly, in four
layers:

1. **Routes win.** The platform reads the first path segment. If it is a
   top-level route, a static file or a reserved name, the path is in-app;
   otherwise it names a workspace. The list of route segments is derived from
   the router's own route tree at runtime, so a new module can't be missed.
2. **Reserved slugs.** No workspace can claim a top-level route name (apps
   included) or a `public/` folder name. This is one shared list
   (`@weldsuite/app-api-client/schemas/workspace-slug`), instead of the copies
   in app-api-client and workspace-worker. `w` is reserved by the format
   already, since slugs need 3+ characters.
3. **Org-id fallback.** A workspace whose slug is reserved anyway (it existed
   before the rule, or was set through Clerk) gets links by its Clerk org id,
   `/org_2Ab…/weldcrm`. Org ids can't clash with anything: slugs can't contain
   `_`, and no route starts with `org_`. So correctness never depends on every
   slug being valid, and no workspace has to be renamed before release.
4. **A CI test** fails when a top-level route or a `public/` entry is missing
   from the reserved list.

## What the code looks like now

All of this goes through a handful of helpers, which keeps the change small:

- `apps/web/platform/lib/workspace-url.ts`: `parseWorkspacePath` (regex
  `^/w/([^/]+)(/.*)?$`), `workspacePath(ref, path)` (builds `/w/{ref}{path}`),
  `isWorkspaceScopedPath` (the `NON_WORKSPACE_SEGMENTS` list),
  `stripWorkspacePrefix`, `findWorkspace`.
- `apps/web/platform/lib/workspace-url-rewrite.ts`: the rewrite's `input` and
  `output`, `toPublicPath()`, `useWorkspaceHref()`.
- `apps/web/platform/lib/workspace-url-gate.ts` +
  `components/workspace-url-gate.tsx`: picks `ref` (`refOf(slug, id)`) and
  canonicalises the address bar.
- About 20 platform callers use those helpers: the switcher, the
  create/invite/onboarding flows, the slug card, raw-path readers,
  `use-workspace-url.ts`, and the connectors callback. None of them builds
  `/w/` by hand, and an ESLint rule flags it if anyone does.
- **Backend:** `workspaceAppUrl()` in `packages/core/worker-kit/src/app-url.ts`
  and its mirror in `packages/core/emails/src/links.ts` build every
  `/w/{orgId}/…` link. Callers: billing, calendar, call, connect and desk
  OAuth, notifications, the flow digest, host. Separately,
  `isAllowedConnectorReturnUrl` in
  `packages/core/connectors/src/woocommerce/auth.ts` parses `^/w/[^/]+`.
- **Slug rules exist in three copies:**
  - `packages/clients/app-api-client/src/schemas/workspace-settings.ts`
  - `packages/clients/core-api-client/src/schemas/workspace.ts`
  - `apps/workers/workspace-worker/src/lib/slug.ts` (used by `slugifyWorkspaceName`)

  Each copy reserves only `www app api admin mail welddesk weldmail support
  help`.
- **Clerk writes slugs back.** `organization.updated` in
  `apps/workers/workspace-worker/src/routes/webhooks/clerk.ts` copies Clerk's
  slug into `workspaces.slug`, bypassing our validation. Layer 3 covers this.

Top-level route segments on `develop` today: `agents apps appstore auth
call-room documents invite new-chat objects onboarding preview settings social
w9 welcome` plus 20 `weld*` modules. Static entries in `apps/web/platform/public/`:
`assets email logos models sounds favicon.ico __ENV.js _headers
df3-worklet-processor.js` and a few `.svg` files. Cloudflare Pages serves
these before the SPA fallback, so a workspace called `assets` would never
reach the app.

## Design

### URL forms the platform accepts

| Address bar | Meaning |
|---|---|
| `/acme/weldcrm/x` | workspace `acme`, page `/weldcrm/x` (the new canonical form) |
| `/org_2Ab…/weldcrm/x` | workspace by Clerk org id (backend links, reserved-slug workspaces) |
| `/w/acme/weldcrm/x`, `/w/org_…/x` | legacy (emails since 2026-10-16, bookmarks): accepted forever, replaced in place by the canonical form |
| `/weldcrm/x`, `/settings`, `/` | bare in-app path: opens in the tab's workspace and gains its slug, as today |
| `/auth/…`, `/onboarding`, `/w9/…`, `/preview/…` | outside a workspace, unchanged |
| `/typo/x` (not a route, not one of your workspaces) | the workspace-not-found screen with your workspaces, not the 404 page |

### 1. One reserved-name module (shared, done in PR 1)

`packages/clients/app-api-client/src/schemas/workspace-slug.ts`, exported as
`@weldsuite/app-api-client/schemas/workspace-slug`, holds:
- `SLUG_REGEX` (unchanged)
- `RESERVED_WORKSPACE_SLUGS`: today's infrastructure names, every top-level
  route, and every `public/` folder. Only names a slug could match are listed.
- `isReservedWorkspaceSlug(slug)`
- `workspaceSlugSchema`, used by `updateWorkspaceSlugInput`

`workspace-worker` turned out to depend on app-api-client already, so it
imports the list instead of mirroring it. Its old "does not depend" comment
was out of date. With no second copy, no equality test is needed.
`slugifyWorkspaceName` prefixes reserved names as before
(`Settings` → `workspace-settings`). `resolveUniqueSlug` now repairs a
reserved or malformed slug that Clerk chose, in both onboarding and partner
onboarding.

`core-api-client/src/schemas/workspace.ts` keeps its own short list. It only
types the legacy `core-api` settings client, no server validates with it,
and it can't import app-api-client without the two packages depending on
each other.

The Clerk webhook (`organization.created` / `organization.updated` in
`workspace-worker/src/routes/webhooks/clerk.ts`) still copies Clerk's slug
as-is. PR 2's org-id fallback (layer 3) makes that harmless.

### 2. Parsing (platform, `lib/workspace-url.ts`)

- `APP_SEGMENTS`: the first segments of every route, built once from the route
  tree (`routeTree` children's `path`), plus the `public/` names. The route
  tree comes in as a parameter (`initWorkspaceUrls(routeTree)` from
  `src/main.tsx`), so `lib/` doesn't import the generated file and tests can
  pass a fake tree.
- `parseWorkspacePath(pathname)` returns `{ ref, rest, legacy }`:
  - `/w/{ref}/rest` → legacy form (kept)
  - first segment in `APP_SEGMENTS` (or empty) → `null` (in-app path)
  - first segment matches `SLUG_REGEX` or `^org_[A-Za-z0-9]+$` → `{ ref, rest }`
  - anything else (`%`, uppercase-only noise, …) → `null`, so the router's
    404 handles it
- `workspacePath(ref, path)` → `/{ref}{path}` (drops the `/w`).
- `isWorkspaceScopedPath` keeps its non-workspace list. `w` stays in it, since
  legacy `/w/` paths must never be treated as in-app.

### 3. Building links: canonical ref with org-id fallback

`refOf(slug, id)` in `lib/workspace-url-gate.ts` becomes
`slug && !isReservedWorkspaceSlug(slug) ? slug : id`. It's the only place a link's
ref is chosen, so the switcher, `toPublicPath`, the address-bar swap and the
not-found screen all inherit the fallback. `useWorkspaceUrl()`
(`orgSlug || orgId`) and the slug card's post-rename reload use the same
function.

### 4. Rewrite and gate

- `input`: unchanged except it calls the new `parseWorkspacePath`.
- `output`: unchanged. It already builds through `workspacePath`.
- Gate: unchanged logic. It already replaces any URL whose ref isn't the
  canonical one (org id → slug, wrong case), so `/w/acme/x` → `/acme/x` comes
  for free once `parseWorkspacePath(window.location.pathname)?.ref` is
  compared with the legacy flag taken into account (a legacy URL always gets
  replaced).
- Cost: a URL whose first segment is an unknown word now waits for the
  membership list (a Clerk call) before showing not-found. That's only for
  typos and other people's workspaces.

### 5. Backend links

`workspaceAppUrl()` (worker-kit and emails) → `{base}/{orgId}{path}`. Org ids
are unambiguous (layer 3), so the backend needs no route list. Links already
sent keep working through the legacy form. `isAllowedConnectorReturnUrl`
accepts `/w/{ref}/…`, `/{orgId}/…` and `/{slug}/…` before the page check.
Keeping its page allow-list is what makes that safe: a `/{x}/weldconnect/…`
path is only accepted when the rest is an allowed page.

### 6. Copy and screens

The not-found screen is now also what a typo shows. Retitle it in en and nl
(`common.workspaceLink.notFoundTitle` / `notFoundDescription`): "Page or
workspace not found", "This link points to a page that doesn't exist or a
workspace you're not a member of." The slug card's "WeldSuite links" warning
changes `/w/{currentSlug}/` to `/{currentSlug}/`. The slug input's error
message gets a "reserved" case for route names.

### 7. Existing workspaces

No forced renames. Run this once on the master DB before PR 2 ships. It's
read only. The list matches `RESERVED_WORKSPACE_SLUGS` as of PR 1; run it
again whenever a name is added:

```sql
-- Workspaces whose slug is now reserved. Read only; master DB.
select w.id, w.slug, w.name, w.clerk_org_id, w.is_active, w.deleted_at, w.created_at
from workspaces w
where w.slug in ('www', 'app', 'api', 'admin', 'mail', 'support', 'help',
  'agents', 'apps', 'appstore', 'auth', 'call-room', 'documents', 'invite',
  'new-chat', 'objects', 'onboarding', 'preview', 'settings', 'social', 'welcome',
  'weldads', 'weldbooks', 'weldcalendar', 'weldcall', 'weldchat', 'weldcommerce',
  'weldconnect', 'weldcrm', 'welddata', 'welddesk', 'welddrive', 'weldflow',
  'weldhost', 'weldhr', 'weldknow', 'weldmail', 'weldmeet', 'weldpass',
  'weldreach', 'weldstash', 'assets', 'email', 'logos', 'models', 'sounds')
order by w.created_at;
```

After PR 2, those workspaces fall back to org-id URLs automatically. Tell
their owners they can pick a new slug in settings; the slug card now rejects
reserved names. If the query returns nothing, nothing changes for anyone.

## Rollout, as two PRs

1. **Reserve the names (no URL change, safe on its own).** It contains:
   - the shared `workspace-slug.ts`, imported by the worker
   - validation in the slug update (server and the settings card), onboarding
     and partner onboarding
   - the CI test that every top-level route and `public/` folder is reserved

   Then run the collision query.
2. **Slug-first URLs.** Parsing, `workspacePath`, the `refOf` fallback,
   `workspaceAppUrl` in both copies, the WooCommerce allow-list, copy, tests
   and e2e. The ESLint rule against hand-built `` `/w/${…}` `` stays, so no
   new legacy-form links appear. A hand-built `` `/${slug}/…` `` can't be
   linted apart from ordinary paths, so `workspacePath()` stays the only
   builder by review. Ships to test, then production with the next release.
   Rolling back is a one-commit revert, and legacy `/w/` links keep working
   either way, because parsing accepts both forms.

The ADR goes in with PR 2: **FE-015 "Platform URLs put the workspace slug
first"**, Proposed, superseding FE-013's URL shape. FE-013's status line then
becomes "Superseded by FE-015", and the frontend design doc's key flow 3 is
updated to match.

## Tests

- **Unit, `lib/workspace-url.test.ts`:** a table for `parseWorkspacePath`
  - canonical, org id, legacy `/w/`, app segment, `public/` file
  - `/`, `//evil.example`, `/w/acme//evil.example`, uppercase, encoded refs

  plus `workspacePath`, and `refOf` with a reserved slug.
- **Unit, the reserved list (PR 1, `apps/web/platform/lib/reserved-workspace-slugs.test.ts`):**
  every top-level route (through pathless groups) and every `public/` entry
  is reserved; `weldon` / `weld-masters` are accepted; reserved names and bad
  formats are rejected. Also in workspace-worker: `slug.test.ts` and
  `onboard-slug.test.ts` for `resolveUniqueSlug`.
- **Rewrite contract** (`lib/workspace-url-rewrite.test.tsx`):
  - slug-first links, `navigate`, redirects
  - a legacy `/w/` URL routes and gets replaced
  - an app segment is never read as a workspace
- **Gate** (`components/workspace-url-gate.test.tsx`): a legacy URL is
  replaced in place; a reserved-slug workspace settles on its org id; an
  unknown first segment shows not-found.
- **Backend:** `workspaceAppUrl` in both packages, and
  `isAllowedConnectorReturnUrl` for all three forms.
- **Playwright** (`e2e/specs/workspace-url.spec.ts`): change `/\/w\/[^/]+/` to
  `/\/[a-z][a-z0-9-]+\//` and add a legacy `/w/` case. The onboarding spec
  waits for `/{slug}/`. Other specs use unanchored regexes, so they keep
  passing.
- **Manual on test:**
  - an email link (legacy and new)
  - a Stripe and an OAuth return
  - the switcher and a slug rename
  - a typo URL
  - a workspace whose slug is reserved (create one through Clerk's
    dashboard)

## Risks

- **A new top-level route with a name an existing workspace already uses.**
  The CI test only forces the name into the reserved list. That workspace's
  links then switch to its org id, and old copied `/{slug}/…` links open the
  new module instead. Customers may use `weld…` slugs, so this applies to new
  modules too. Run the collision query for a new top-level route's name before
  merging it, and note this in the PR template for new top-level routes.
- **Two-letter slugs:** `SLUG_REGEX` requires 3+ characters, so nothing
  changes there.
- **Analytics, logs and the help-docs screenshots:** page views log the
  internal path, so they're unaffected. Screenshots use `/preview`, which is
  outside a workspace.

## Open questions

1. Should the org-id fallback show a hint on the slug card ("your workspace's
   address uses its id because `x` is reserved")?
2. How long should legacy `/w/` parsing stay? The plan says forever: emails
   live in inboxes indefinitely, and it costs one regex.
