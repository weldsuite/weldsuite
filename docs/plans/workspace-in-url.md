# Workspace in the URL, step 2 (FE-013)

Status: implemented in one PR (#1225), not the four below. ADR: `FE-013` in
`weldsuite-documentation` ("Platform URLs name the workspace, as `/w/{slug}/…`",
Proposed; flips to Accepted when #1225 merges). The rewrite is **on by
default**; `VITE_WORKSPACE_IN_URL=false` at build time is the kill switch.

How it landed, against the design below:
- Store, rewrite, `toPublicPath()` / `useWorkspaceHref()`:
  `apps/web/platform/lib/workspace-url-rewrite.ts`. The rewrite is wired in
  `src/main.tsx`.
- The shell check: a pure decision table in `lib/workspace-url-gate.ts` and the
  hook in `components/workspace-url-gate.tsx`, used by `AppShellClient`. The
  not-found/error screen is `components/workspace/workspace-link-problem.tsx`,
  shared with the `/w/$workspace` page, which now only runs with the kill
  switch off. With the rewrite on, the router strips `/w/` before routing, so
  that route is never matched.
- §4: the `lib/router` wrappers needed no change. A `to` that already names a
  workspace goes through `input` like any other URL, and the shell activates
  it.
- §6 iframe: nothing builds an `?embedded=1` URL any more, so there was
  nothing to change.
- Signing out returns to the browser URL (`callbackUrl` keeps `/w/{slug}`).

## Spike result (PR 1): rewrites work, with four rules

Tested two ways on `@tanstack/react-router` 1.160.2 / `router-core` 1.160.0:
1. A vitest harness (memory history, 12 cases; kept outside the repo).
2. The real app: a temporary `rewrite` in `src/main.tsx` on the dev server,
   using the `/preview` pages, which need no sign-in.

What works:
- A prefixed URL loads the bare route, through the real code-split route
  tree. `useRouterState`, `useLocation` and `usePathname` report the internal
  path.
- `<Link>` hrefs carry the prefix, with params, search and hash kept.
  Active-link matching (`aria-current`) still works.
- Clicking a link, `navigate({ to })`, `navigate({ href })` (bare or already
  prefixed: `href` goes through `input` first), `redirect()` from
  `beforeLoad` and back/forward all land on prefixed URLs.
- `preloadRoute({ to })` resolves bare paths.

The four rules PR 2 must follow:
1. **`output` must return a new `URL`.** `buildLocation` reads the URL it
   passed in again after `output` runs. Changing it in place leaks the prefix
   into the internal `href`, which breaks route matching.
2. **No automatic canonicalisation on the client.** The router only redirects
   to the rewritten URL on the server. `navigate` to the same location doesn't
   write history either, because `commitLocation` compares internal hrefs. To
   swap a bare path or org id for the slug, the gate calls
   `router.history.replace(router.buildLocation({ to: pathname, search: true,
   hash: true }).publicHref, state)`.
3. **`router.history.push/replace` bypasses `output`** (the URL stays bare).
   PR 1 moved the three app call sites to `router.navigate({ href })`.
4. **Plain `<a href>` tags are outside the router.** The app rail
   (`components/app-sidebar-client.tsx`) renders `<a href="/welddesk">` and
   navigates with `router.push` on click. The click is fine, but middle-click,
   open-in-new-tab and copy-link get a bare path, which would open in the
   session's last workspace. That's the bug this ADR is about. PR 2 adds a
   `useWorkspaceHref(path)` hook (`router.buildLocation(...).publicHref`) for
   these. About 13 files mix plain anchors with router navigation and need a
   look.

PR 1 left two pieces for PR 2:
- **The `urlRef`/`activeRef` store moved to PR 2**, since only the rewrite
  uses it.
- **`bootstrapsOwnOrg` stays as it is**, since the gate replaces it.
  `isMinimalPath` now uses `isWorkspaceScopedPath`. `/welcome` and
  `/call-room` (which has no Clerk login) are on the non-workspace list.

Step 1 shipped on 2026-10-16 (#1156, 4d7a53c4b): the `/w/$workspace` entry
route resolves a slug or Clerk org id, activates it and redirects to the bare
path; emails, notifications, OAuth and Stripe returns build `/w/{orgId}/…`.
What is left is the part that makes the address bar carry the workspace, so
copied links, bookmarks and reloads keep it.

## The key choice: router URL rewrites, not moving 479 route files

The ADR's step 2 moves every workspace route to `src/routes/w/$workspace/`
and rewrites about 1,000 links and every `pathname` parser. TanStack Router
1.160 (what we run) has a `rewrite` option that does the same job at the
history boundary:

- `input({ url })` runs when the router reads the browser URL. It strips
  `/w/{ref}` and records `ref`. Routes match the bare path, as today.
- `output({ url })` runs when the router builds a link or commits a
  navigation. It adds `/w/{active slug}` to workspace-scoped paths.

So `<Link to="/weldcrm/customers">` renders `href="/w/acme/weldcrm/customers"`,
`navigate()` writes the prefixed URL, and `useLocation()`, `usePathname()` and
`useRouterState(s => s.location.pathname)` keep returning the internal bare
path (64 + 3 call sites, untouched).

What this keeps unchanged: the route files and `routeTree.gen.ts`, every
`useParams({ from: '/weldcrm/…' })` and typed `to=`, all in-app links,
`appFromPathname` and the other router-state parsers, page-view analytics
(they log the internal path, so no slugs reach Mixpanel), the `/preview`
mirror.

What it doesn't cover, and the plan handles below: code that reads
`window.location.pathname` directly, `window.location` assignments to bare
paths, and `router.history.*` calls (which bypass `output`).

This meets the ADR's decision (the URL names the workspace, the URL wins, one
helper adds the prefix, one function strips it) without its mechanics. Since
FE-013 is Proposed, amend its step 2 text in the docs repo in the same change
(see Docs).

**Fallback if rewrites turn out not to work** (for example a router bug with
code-split preloads): the ADR's route move. Spike the rewrite first (PR 1)
and decide before PR 2.

## Design

### 1. One module for workspace paths: `lib/workspace-url.ts`

Extend the step 1 file; no new hand-built `` `/w/${…}` `` anywhere.

- `NON_WORKSPACE_PREFIXES` and `isWorkspaceScopedPath(pathname)`: `/auth`,
  `/onboarding`, `/invite`, `/w9`, `/w` itself, `/preview`, `/welcome`,
  `/call-room`, `/builder`. Today the list is spread across `isMinimalPath`
  and `bootstrapsOwnOrg` in `components/app-shell-client.tsx`; both start
  using this one.
- `stripWorkspacePrefix(pathname)`: the shared "strip it first" function for
  anything that reads the raw browser path.
- `workspacePath(ref, path)` stays the only builder (it already encodes the
  ref). `useWorkspaceUrl()` and the rewrite's `output` both call it.
- A small store (`useSyncExternalStore`-style, module level, since the
  rewrite runs outside React) holding `urlRef` (what the address bar named
  on load, or on a later `input`) and `activeRef` (the tab's Clerk org slug,
  falling back to its id).

### 2. The rewrite: `lib/workspace-url-rewrite.ts`, wired in `src/main.tsx`

- `input`: `parseWorkspacePath(url.pathname)`. If it matches, record `urlRef`
  and set `url.pathname` to the rest. Otherwise return unchanged.
- `output`: unchanged when the path isn't workspace-scoped, already starts
  with `/w/`, or there's no `activeRef` yet (the gate canonicalises later).
  Otherwise it returns a **new** `URL` whose pathname is
  `workspacePath(activeRef, url.pathname)`, never the one it was given (spike
  rule 1). Idempotent, keeps `search` and `hash`.
- Behind `VITE_WORKSPACE_IN_URL`. Off means `output` is the identity, so the
  app behaves exactly like step 1. `input` always strips, so a prefixed URL
  never 404s even with the flag off.

### 3. The gate: the shell decides which workspace a tab is in

Replaces the `/w/$workspace` page as the main resolver. It lives in
`AppShellClient` next to the existing org-activation effect, and the decision
is a pure function next to `resolveOrganizationToActivate` so it can be
tested on its own.

Once Clerk has loaded, for a workspace-scoped path:

| Address bar | Tab's org | Action |
|---|---|---|
| `/w/{ref}` = org slug or id | same | Render. If `ref` was the id or an old-case slug, `router.navigate({ replace: true })` to the same location, so `output` writes the slug (the ADR's org-id → slug swap). |
| `/w/{ref}`, another of the user's workspaces | different | Don't render. `setPendingOrganization`, `setActive`, drop `weldsuite:query-cache`, `location.replace(current URL)`. This is the workspace-link page's existing flow, moved here. |
| `/w/{ref}`, not one of the user's workspaces (after paging every membership) | any | Workspace-not-found screen with the workspace list, extracted from `app/workspace-link/page.tsx`. Never falls back silently. |
| bare path (old bookmark, email from before step 1) | any | Existing pending/first-membership logic, then `replace` to the same location, so `output` adds the active slug. |

- **Fast path:** comparing `urlRef` with `useAuth().orgSlug`/`orgId` needs
  no network, so the common case (the URL matches the tab) renders as soon
  as Clerk has loaded. Only a mismatch waits for `useOrganizationList`.
- **Children must not render on a mismatch.** Queries would otherwise fire
  with the wrong org's token, and the persisted cache would hydrate against
  the wrong workspace (FE-003).
- **Just-created workspace:** when `urlRef` equals the pending org id, call
  `setActive` without waiting to find it in the membership list (the new
  membership is often not in Clerk's client cache yet, the reason
  `lib/pending-organization.ts` exists). If `setActive` fails, show the
  error screen.
- The `/w/$workspace` routes stay as an in-app fallback: an internal
  navigation to a `/w/…` path (a stored return URL, say) still lands on the
  workspace-link page and resolves.

### 4. The `lib/router` wrappers

`Link`, `useRouter().push/replace/prefetch` and `redirect` need nothing for
bare hrefs. Add one normalisation: an href that already names a workspace
(`/w/{ref}/…`) is stripped to its rest when `ref` is the active workspace,
and becomes a full-page load (plain `<a>`, `location.assign`) when it isn't,
so the gate runs.

Lint: a `no-restricted-syntax` rule in the platform's ESLint config against
template literals starting with `` `/w/${ `` outside `lib/workspace-url*`.

### 5. Raw path readers (they see the public, prefixed URL)

| File | Fix |
|---|---|
| `lib/api/app-context-header.ts:39` | `appFromPathname(stripWorkspacePrefix(window.location.pathname))`. **Critical**: without it, `X-Weld-App` is dropped and app-scoped permissions fail. |
| `components/call/minimized-call-widget.tsx:384` | strip before `startsWith` |
| `app/weldmail/lib/mail-urls.ts:78` | check what consumes it; strip if it feeds the router |
| `app/weldhr/payroll/page.tsx:116`, `components/accounting/create-entity-dialog.tsx:145` | store the internal path (`usePathname()`) as `settings-return-url`, not `globalThis.location.pathname` |
| `app/weldbooks/banking/feeds/use-bank-feed-connect.tsx:184` | the public path is right for a return URL; make sure `safeReturnPath` accepts `/w/…` |
| `app/weldconnect/connectors/connectors-client.tsx:293,315` | already `useWorkspaceUrl(pathname)`, which keeps a named path. No change. |
| `history.replaceState(…, window.location.pathname…)` in billing, payment methods, connectors; spreadsheet copy-link | public path keeps the prefix. Correct as is. |

`router.history.push/replace` bypasses `output` (`weldbooks/banking/feeds/callback-page.tsx:39`,
`use-bank-feed-connect.tsx:169`, `workspace-link/page.tsx:93`): switch to
`router.navigate`.

### 6. `window.location` assignments (89)

About 55 are external (OAuth authorize, Stripe checkout, `mailto:`/`tel:`)
and need no change. Non-workspace targets (`/auth/…`, `/onboarding`) need
none either. The rest:

- **Workspace changes, which now go to the workspace's URL:**
  - `contexts/workspace-context.tsx` `switchWorkspace` (the switcher):
    `setActive` as today, then `location.href = workspacePath(slug ?? id, '/')`
    instead of `/`. Even if Clerk comes back with the old org after the
    reload, the URL wins, so the switcher no longer depends on the pending-org
    workaround.
  - `components/workspace/create-workspace-dialog.tsx`,
    `app/onboarding/components/provisioning-screen.tsx`,
    `app/onboarding/onboarding-page-client.tsx`,
    `app/invite/accept/accept-invite-client.tsx`, `app/invite/invite-client.tsx`:
    `workspacePath(newOrgId, '/')` where the org id is known. The gate swaps
    it for the slug.
  - `app/settings/general/delete-workspace-section.tsx`: `/` (bare), so the
    gate picks the next workspace.
- **In-app jumps to a bare module path**, which would bounce through the
  gate: `weldchat/components/message-input.tsx`, `weldhost/layout.tsx` (×2),
  `weldmail/setup/page.tsx` (×2), `weldmail/setup/setup-add-account.tsx` (×3),
  `weldcrm/calls/global-call-panel.tsx`. Use `useRouter().push`, or
  `workspaceHref()` where a full load is intended.
- `__root.tsx` and `root-error-fallback.tsx` → `/`: leave bare (the gate
  handles it).

### 7. Slug change

`app/settings/general/workspace-slug-card.tsx`: after a successful rename,
reload the Clerk organization so `orgSlug` updates, then `replace` the
current location (the address bar picks up the new slug). Add one line to the
dialog's list of what breaks: links copied with the old address stop
working. That line needs `en` and `nl` strings in
`packages/core/i18n/src/locales/{en,nl}/settings.ts`.

Old-slug redirects (keeping previous slugs) stay out of scope, as the ADR
says, unless they turn out to matter.

## Rollout, as four PRs against `develop`

1. **Helpers and readers, no behaviour change.** Extend `lib/workspace-url.ts`
   (scope list, `stripWorkspacePrefix`, store), use the scope list in
   `isMinimalPath`/`bootstrapsOwnOrg`, fix the readers in §5 (stripping is a
   no-op on bare paths), switch `router.history.*` to `navigate`, add the
   lint rule. Includes a throwaway **spike** of the rewrite on a branch:
   confirm `output` reaches `<Link href>`, `navigate`, preload-on-hover and
   `redirect` on 1.160, and that `useRouterState` reports internal paths.
2. **Rewrite and gate behind `VITE_WORKSPACE_IN_URL`.** On for test
   (`app-test.weldsuite.org`), off for production. Extract the
   not-found/error screens from the workspace-link page.
3. **Destinations and cleanups:** §6 switcher/create/invite/onboarding/delete,
   in-app `window.location` jumps, §7 slug card, e2e updates.
4. **Flip the flag in production.** FE-013 → Accepted, design doc updated.
   Remove the flag one release later.

## Tests

- Unit (vitest, next to `lib/workspace-url.test.ts`):
  - rewrite `input`/`output`: non-workspace prefixes, idempotence, encoded
    refs, `search`/`hash` kept, `//evil.example` still guarded
  - `stripWorkspacePrefix`
  - the gate's decision function as a table, like
    `resolveOrganizationToActivate`'s tests
  - `app-context-header` with a prefixed `window.location`
- Existing unit tests that mock `window.location.pathname` with bare paths
  keep passing (stripping is a no-op on them).
- Playwright: 338 `page.goto` calls to bare paths keep working through the
  gate. Of the 91 URL assertions, most are unanchored regexes and still
  match. Exact ones (`waitForURL('/')`) need a regex. New spec, which needs a
  test user in two workspaces (`.env.test`):
  - a deep link `/w/{other}/weldcrm/people` switches and lands there
  - an unknown slug shows the workspace list
  - reload keeps the workspace
  - two tabs on two workspaces each survive a reload
  - the switcher's URL is `/w/{slug}/`
- Help-docs screenshots run on `/preview/*`, which is outside `/w/`: no
  change. Check that no captured screen shows the address bar.
- Manual on test:
  - a Stripe checkout return and an OAuth return (already `/w/{orgId}`)
  - an email link
  - the desktop app (`apps/desktop` loads the bare root; the gate adds the
    slug)
  - the weldflow `?embedded=1` iframe: it inherits the parent's URL
    workspace; build its `src` with `workspacePath` so it can't open in
    another org

## Docs (weldsuite-documentation, skill `weldsuite-docs`)

- Amend FE-013's step 2 in place (it is still Proposed): the router `rewrite`
  instead of moving the route files, the gate table, and the flag. Move the
  route-move approach to Alternatives considered, with why: it touches 479
  route files and about 1,000 typed links for the same result.
- Record the step 1 follow-up as done or open: which org a fresh load starts
  with across two tabs on `@clerk/clerk-react` ^5.61.
- Flip to Accepted with PR 4. Update `design/platform/frontend-platform.md`.

## Out of scope, and follow-ups

- Keying the persisted query cache per org (two tabs on two workspaces
  discard each other's cache on reload). Supersedes part of FE-003, a
  separate ADR.
- Keeping old slugs for redirects (a master schema change).
- Mobile: `actionUrl` stays workspace-free, as in step 1.

## Open questions

1. Rewrite (this plan) vs the ADR's literal route move: confirm after the
   PR 1 spike.
2. Should the switcher keep the current module (`/w/{other}/weldcrm`) or go to
   the workspace home (`/w/{other}/`, the ADR's wording)? Keeping the module
   can land on a module the other workspace hasn't installed. `AppAccessGuard`
   then shows its "not installed" screen.
3. Is `VITE_WORKSPACE_IN_URL` acceptable as an env flag (needs a Pages
   rebuild to toggle), or should it be a `@weldsuite/feature-flags` flag
   (per workspace, but read before Clerk loads)?
