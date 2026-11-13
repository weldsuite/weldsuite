# Mobile apps: choosing Global, EU or a self-hosted server

**Status:** phases 1–5 built (2026-11-12), behind `EXPO_PUBLIC_SERVER_PICKER`:
on in development and preview builds and test OTAs, off in production. Phase 6
(launch) waits for the EU edition. Decision record:
[MOB-006](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/MOB-006-one-store-build-server-chosen-at-sign-in.md).
What was decided on the open questions, and what differs from the first draft:
"Decisions taken" at the end.

**Where it comes from:** work package 4.F4 ("the same facade over
`@clerk/expo`, plus a server address at sign-in") and P5's "EU server in the
server picker" in the docs repo's
`design/platform/editions-and-self-hosting-phases.md`. The design doc
(`editions-and-self-hosting.md`, "Mobile apps") already settles the outcome:
the apps ask for a server at sign-in ("WeldSuite cloud" or "your own server"),
discover OIDC from it, and one store build serves all three deployments. This
plan is how to get there.

## Goal

- One App Store / Play build of each app works against **Global**, **EU** and
  a **self-hosted** install.
- The sign-in screen shows which server the app talks to, with a way to change
  it. Global stays the default, so nobody who uses the apps today sees a new
  step.
- On EU and self-hosted, people sign in through that server's OIDC provider
  (Zitadel on EU), and the app hides what the server doesn't offer.

Not in scope: porting `weldmeet-app` to LiveKit, WeldAgent on EU (AI-011), and
moving a workspace between deployments (`weldsuite workspace export/import`).

## What exists today

**Mobile (12 apps plus `_template`):**

- Every app is built for exactly one deployment. `eas.json` bakes in
  `EXPO_PUBLIC_APP_API_URL`, `EXPO_PUBLIC_PERSONAL_API_URL`,
  `EXPO_PUBLIC_REALTIME_URL`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` and
  `EXPO_PUBLIC_API_MODULES` per profile. `EXPO_PUBLIC_APP_API_URL` is read in
  26 places, usually as a module-level constant in `services/app-api.ts`.
- Auth is Clerk only. Each `app/_layout.tsx` mounts `ClerkProvider` with
  `tokenCache` and `__experimental_disableNativeClientSync`. 87 files across
  the apps and template import `@clerk/*`, mostly `useOrganizationList`,
  `useAuth`, `useUser` and `useOrganization`.
- Most auth code is already shared in `@weldsuite/mobile-ui`:
  `contexts/ClerkAuthContext.tsx` (user, token, sign-out),
  `components/LoginScreen.tsx` (Google and Apple via `useSSO`, email, passkeys)
  and `contexts/WorkspaceContext.tsx`.
- Each app copies the same `services/app-api.ts`: `createApiOriginResolver`
  from `@weldsuite/api-modules`, a module-level token getter and an
  `X-Weld-App` header. WeldMail and WeldCalendar also pair a personal-api host
  with the app-api host (`services/personal-api.ts`).
- Push: the app registers an Expo push token at `/api/push-tokens`. Both
  Global (`packages/core/notifications/src/channels/push.ts`) and Rust
  (`rust/crates/notifications/src/push.rs`) send the full message to Expo's
  push service.

**Web platform (already done, the model to copy):**

- `apps/web/platform/lib/runtime-config.ts` defines the `/config.json`
  contract: `backend`, `edition`, `modules`, `unavailableFeatures`,
  `apiBaseUrl`, `realtimeUrl`, `videoProvider`, `auth`, `env`.
- `apps/web/platform/lib/auth/` is the auth facade (SEC-012): one interface,
  Clerk behind it on Global, OIDC with PKCE (`oidc-client-ts`) on Kubernetes.
  `oidc/claims.ts` reads the workspace from the token. Switching workspace on
  OIDC is a new sign-in request with Zitadel's org scope
  (`session.ts`, `setActiveOrganization`).
- The provider is chosen once, before the first render. Nothing changes it
  afterwards.

**Rust backend:**

- `GET /config.json` (`config_json` in `rust/bins/weldsuite/src/server.rs`)
  returns `backend: "rust"`, the modules, the edition flags, `realtimeUrl` and
  `auth` with the **web** client id (`OIDC_WEB_CLIENT_ID`). There is no client
  for native apps yet.
- One origin serves every module, and personal-api lives under
  `https://<host>/personal-api`.
- EU test cluster: `app.test.weldsuite.eu` (Zitadel at
  `auth.test.weldsuite.eu`). The EU production domain is still a placeholder
  in `rust/deploy/flux/clusters/eu/cluster-settings.yaml`.

## Design

### 1. The server choice

```ts
type ServerKind = 'global' | 'eu' | 'self-hosted';

interface ServerChoice {
  kind: ServerKind;
  /** Origin of the server; absent for Global, which uses the baked-in hosts. */
  origin?: string;
}
```

- **Global**: the values baked in by `eas.json`, exactly as today. No
  `/config.json` request: Global (Pages) serves none.
- **EU**: the origin comes from a new build variable,
  `EXPO_PUBLIC_EU_SERVER_URL` (`https://app.test.weldsuite.eu` in `development`
  and `preview`, the production host once EU launches). Without it the option
  isn't shown.
- **Self-hosted**: the person types an address, or opens a link such as
  `weldmail://server?url=https://weldsuite.example.com` (which an admin can
  hand out as a QR code). The app normalises it to an `https://` origin,
  fetches `<origin>/config.json`, and only accepts it when the document parses,
  says `backend: "rust"` and has an `auth` block the app can use.

The choice is saved on the device (AsyncStorage, key `weldsuite:server`). It
isn't secret; the tokens are.

**Changing server restarts the app.** The flow: sign out of the current
server (which also unregisters the push token there), clear local data
(section 7), save the new choice, then `Updates.reloadAsync()` from
`expo-updates` (already a dependency). The boot code reads the choice before
the first render, like the platform does. This keeps the "provider is chosen
once" rule, so no hook ever changes under a mounted tree, and every
module-level constant (API hosts, realtime URL) is read fresh.

### 2. Runtime config on mobile

Move the pure parts of the platform's runtime config into a shared package so
web and mobile parse the same contract:

- `runtimeConfigSchema` (Zod v3) and `parseRuntimeConfig` move to
  `@weldsuite/app-api-client/schemas/runtime-config`, which both already
  depend on. `apps/web/platform/lib/runtime-config.ts` imports them from there
  and keeps its browser-only loading code.
- The schema gains `auth.mobileClientId` (section 5).

Mobile boot, in a new shared module:

1. Read the saved `ServerChoice`. None saved means Global.
2. Global: build the runtime from the `EXPO_PUBLIC_*` values.
3. EU or self-hosted: fetch `<origin>/config.json` with a 5 s timeout. Keep the
   last good copy on the device so the app opens offline. With no answer and
   no copy, show a "Can't reach <server>" screen with "Try again" and "Change
   server".
4. Expose the result as one object read by everything else:

```ts
interface MobileRuntime {
  server: ServerChoice;
  apiOrigin: string;          // app-api on Global, the server's origin on Rust
  apiModules: Set<ApiModuleId>; // EXPO_PUBLIC_API_MODULES on Global, empty on Rust
  personalApiOrigin: string;  // personal-api host on Global, `${origin}/personal-api` on Rust
  realtimeUrl: string | null;
  platformUrl: string;        // links that open the web app
  auth: { provider: 'clerk'; publishableKey: string } | OidcMobileAuth;
  edition: 'global' | 'eu' | 'self-hosted';
  modules: Set<string> | 'all';
  unavailableFeatures: Set<string>;
  env: Record<string, string>; // config.env, for keys such as Mapbox
}
```

An empty `apiModules` set makes `createApiOriginResolver` send every path to
`apiOrigin`, which is what the Rust backend wants.

### 3. Where the code lives

A new package, **`@weldsuite/mobile-platform`** (`packages/clients/mobile-platform`),
following MOB-002 (share through packages):

- `server/`: `ServerChoice` storage, address normalisation, `/config.json`
  fetch and cache, `getMobileRuntime()`, `switchServer()`.
- `auth/`: the facade, the Clerk adapter and the OIDC adapter (section 4).
- `api/`: `createMobileApiClient({ appCode, getToken })`, replacing the 12 copies of
  `services/app-api.ts` boilerplate (origin resolver, token getter,
  `X-Weld-App`). Each app keeps its own list of domain clients.
- `edition/`: `useEdition()`, `useEditionFeature(name)`, `isModuleAvailable(id)`.

UI stays in `@weldsuite/mobile-ui`: `LoginScreen`, a new `ServerPicker` sheet
and a `ServerSettingsRow` for the settings screens. `ClerkAuthContext` becomes
a thin wrapper over the facade during the migration, then goes.

The pure OIDC pieces the platform already has (`oidc/claims.ts`, the scope
templates, the facade types in `lib/auth/types.ts`) move to a package both can
import, so the workspace-from-token rules exist once. `@weldsuite/permissions`
is the wrong home; a small `@weldsuite/auth-shared` under `packages/core` is
the simplest fit.

### 4. The auth facade

Same shape as the platform's `AuthImplementation`: `Provider`, `useAuth`,
`useUser`, `useOrganization`, `useOrganizationList`, `getToken`, `signOut`,
plus `signIn(options)` for providers with hosted sign-in.

**Clerk adapter (Global).** Passes `@clerk/expo` through, with today's
`ClerkProvider` settings. Clerk-only screens (Google and Apple via `useSSO`,
email codes, passkeys) stay in `LoginScreen` and render only on Clerk, like the
platform's `<ClerkOnly>`. An ESLint rule forbids `@clerk/expo` imports outside
the adapter and those screens, as on the web.

**OIDC adapter (EU, self-hosted).** A small PKCE client of our own
(`packages/clients/mobile-platform/src/auth/oidc/`) on `expo-web-browser`,
`expo-crypto` and `expo-secure-store`, which every app already ships.
(`expo-auth-session` needs the `expo-application` native module, which most
apps lack, so it would have forced native builds.)

- Authorization code with PKCE against the discovery document at `issuer`.
  Scopes as on the web: `openid profile email offline_access`, Zitadel's
  roles scope and the audience scope from `/config.json`.
- Redirect URI `<scheme>://sso-callback` (`weldmail://sso-callback`, …): the
  route every app already has for Clerk SSO, so the deep link lands on an
  existing screen on Android too.
- Tokens in `expo-secure-store`, keyed by server origin. Access tokens are
  refreshed with the refresh token; `getToken()` always returns a fresh one.
- Workspaces from the token through the shared `claims` code. A token asked
  for without an org scope lists the person's workspaces; one asked for with
  `urn:zitadel:iam:org:roles:id:<orgId>` is that workspace's token.
- **Switching workspace** needs a new authorization request, so it opens the
  in-app browser sheet. Zitadel's session cookie means no password prompt, but
  iOS still shows its "wants to use … to sign in" sheet. To keep that to the
  first visit, the adapter keeps one refresh token per workspace, so switching
  back to a workspace already used is silent.
- Sign-out revokes the refresh tokens at the revocation endpoint and deletes
  them. It doesn't open the end-session page in a browser.
- `prompt=create` for "Create account", as on the web.

**The token getter.** `AuthGuard` in each `_layout.tsx` wires
`setAppApiTokenGetter` from `useClerkAuth().getCredentials`. It wires it from
the facade's `getToken` instead. The rest of the guard (pick the first
workspace, route to `/authorisation` or `/no-workspace`) already only uses
calls the facade offers.

### 5. Backend changes

1. **A native OIDC client.** New setting `OIDC_MOBILE_CLIENT_ID` in
   `rust/bins/weldsuite/src/config.rs`, sent as `auth.mobileClientId` in
   `/config.json`. Chart value, `ZITADEL_MOBILE_CLIENT_ID` in the flux cluster
   settings, and a runbook step to create the Zitadel "Native" application
   (PKCE, refresh tokens on, the 12 `<scheme>://sso-callback` redirect
   URIs, roles and user info inside the ID token). Its tokens must carry the same audience, which the audience scope
   already gives.
2. **Self-hosted docs.** Customers with their own OIDC provider register a
   public native client with those redirect URIs and set
   `OIDC_MOBILE_CLIENT_ID`. Without it, `/config.json` has no
   `mobileClientId` and the apps say "This server doesn't allow the mobile
   apps yet".
3. **Requirements a self-hosted server must meet**, checked by the app and
   listed in the docs: HTTPS with a certificate the phone trusts (production
   builds block cleartext, and a private CA won't work without installing it
   on the phone), and `/config.json` reachable from the phone.
4. **Push relay** (section 6).

Global needs no backend change.

### 6. Push notifications

- The app registers its token with whichever server it talks to, because the
  push-tokens call goes through the same client. On a server switch it
  deletes the token on the old server first.
- **EU today sends message content through Expo**, which runs on US
  infrastructure. The design doc promises content-free push in EU ("New
  message", the app fetches the rest).
- **A self-hosted server can't send push to WeldSuite's apps at all.**
  Sending through Expo needs WeldSuite's Expo access token, which can't be
  handed to customers.

Both point to the relay in the design doc: a small WeldSuite service that
takes `{ token, kind, server }` from a server registered with it and sends a
content-free notification. The app opens, fetches what's new and shows it.
This is its own piece of work with its own ADR; this plan only depends on it.
Until it exists:

- EU: decide between "push off" and "Expo with content" (open question 3).
- Self-hosted: push off. The settings screen says so.

Notification taps carry the server origin in `data`, and the app ignores taps
for a server it no longer talks to.

### 7. Local data when the server changes

Things kept on the device today that would leak between servers or break:

- the in-memory TanStack Query cache (the apps don't persist it today; if
  one starts to, its key must include the server origin),
- WeldMail's offline store (`lib/offline`) and other per-app caches,
- the saved workspace and last-opened screens,
- Clerk's token cache (cleared by Clerk's sign-out) and OIDC tokens (cleared
  by the adapter).

`switchServer()` clears them through one registry: each app registers its
clear functions at start-up, so a new cache can't be forgotten.

### 8. Edition flags

From `modules` and `unavailableFeatures` in the runtime:

- **The app's own module must be served.** If it isn't, the server picker
  says "WeldAgent isn't available on this server" and doesn't save the choice.
  Today that blocks `weldagent-app` on EU (AI-011) and `weldmeet-app`, which
  uses RealtimeKit while the Kubernetes editions use LiveKit (MEET-007).
- **Features inside a module** are hidden with `useEditionFeature`. From the
  current Rust edition list: `chat-calls` (WeldChat calls), `mail-domains`,
  `mail-free-addresses` and `mail-ai` (WeldMail), `analytics` (Mixpanel off),
  `billing`, `credit-top-up` and `paid-apps`. Each app gets a short audit for
  the ones it shows.

### 9. The screens

- **Sign-in.** Under the form, a row: "Server: WeldSuite cloud · Change". It
  opens the `ServerPicker` sheet with the three options. For self-hosted, an
  address field and "Connect", which checks `/config.json` and shows the
  server's name and edition before saving. On OIDC servers the sign-in screen
  shows "Sign in" and "Create account", which open the server's own sign-in
  page; Google, Apple, email and passkey buttons are Clerk-only.
- **Settings.** A "Server" row in each app's settings shows the current
  server and offers "Switch server", which explains that the app signs out.
- **Build gate.** `EXPO_PUBLIC_SERVER_PICKER=on|off`. On in `development` and
  `preview`, off in `production` until EU is ready. With it off the app
  behaves exactly as today, so the code can ship before EU launches.
- Every new string in English and Dutch, through `LoginScreenCopy` and the
  labels mobile-ui already takes.

### 10. Builds and releases

- No new native module: the OIDC client uses `expo-web-browser`, `expo-crypto`,
  `expo-secure-store`, AsyncStorage and `expo-updates`, which every app already
  has, so the change ships as OTA updates (MOB-003, `runtimeVersion` policy
  `appVersion`).
- `eas.json` per app and `.github/actions/deploy-mobile` (the OTA build env):
  `EXPO_PUBLIC_SERVER_PICKER` (`on` for test, `off` for production) and
  `EXPO_PUBLIC_EU_SERVER_URL` (the EU test cluster for test). The Global values
  stay as they are. `.github/actions/deploy-prepare/filters.yml` republishes the
  apps when `packages/clients/mobile-platform` changes.
- `_template` first, then the apps (MOB-002), so `pnpm create:mobile-app`
  produces apps that already have it.

## Phases

| Phase | What | Visible change | Done when |
|---|---|---|---|
| 1. Facade on Global | `@weldsuite/mobile-platform` with the Clerk adapter and `createMobileApiClient`. Template and all 12 apps moved off direct `@clerk/expo` imports. ESLint rule. Runtime-config schema moved to `@weldsuite/app-api-client`. | None | No `@clerk/expo` import outside the adapter and Clerk-only screens; apps pass their Jest suites and Maestro flows on Global test; OTA to production. This is 4.F4's first half. |
| 2. Server choice | `ServerChoice`, `/config.json` loading and caching, `switchServer()` with reload, local-data registry, `ServerPicker` and settings row behind `EXPO_PUBLIC_SERVER_PICKER`. API, personal-api and realtime hosts read from the runtime. | Preview builds only | A preview build can point at a Rust server and load `/config.json`; switching back to Global works and leaves no data behind. |
| 3. OIDC sign-in | OIDC adapter. `OIDC_MOBILE_CLIENT_ID` in Rust, chart and flux; Zitadel native client on the EU test cluster. Shared claims package. | Preview builds only | Sign in, switch workspace, refresh, sign out against `app.test.weldsuite.eu`, on iOS and Android. A Maestro flow for it. |
| 4. Edition flags | Module check in the picker, `useEditionFeature` audit per app. | Preview builds only | Every app on the EU test cluster shows nothing that answers 404 or `unavailableFeatures`. |
| 5. Push | Push off or on per open question 3; relay as its own project. Token clean-up on switch. Tap filtering by server. | Preview builds only | No push sent for a server the app no longer uses; EU behaviour matches the decision. |
| 6. Launch | EU production host in `eas.json`, picker on in production, self-hosted docs on help.weldsuite.org. | Yes | EU launch (P5). Self-hosted with M7. |

Phase 1 is worth doing now on its own: it is the work package the editions
plan already expects, it changes nothing for users, and every later phase is
smaller for it.

## Tests

- Jest in the new package: address normalisation, `/config.json` parsing and
  the fallbacks (HTML answer, invalid JSON, timeout, cache), runtime built for
  each kind, `switchServer()` clearing every registered store, claims to
  workspaces (shared with the platform's `claims.test.ts`).
- Jest per app: the `AuthGuard` routes on the facade with both adapters
  mocked.
- Maestro: one flow on Global test (today's sign-in), one on the EU test
  cluster (OIDC sign-in, workspace switch, sign-out, switch back to Global).
- Manual before launch: a self-hosted install from the chart (the kind smoke
  test cluster or `drill`) with a non-Zitadel OIDC provider, such as Keycloak.

## Decisions taken

The open questions below were settled on their recommended answers when the
work was built; change them here and in MOB-006 if that was wrong.

1. Global is the default; the picker is a "Change" link. No new step on first launch.
2. Test servers (the EU test cluster) only in development and preview builds and test OTAs.
3. EU push is off until the content-free relay exists (`MobileRuntime.pushEnabled`).
4. The browser sheet on a first switch to a workspace is accepted; one refresh
   token per workspace keeps later switches silent.
5. Self-hosted is built alongside EU, behind the same picker switch.
6. MOB-006 written (Proposed); the push relay gets its own ADR when it is designed.

Still open: the EU production origin (the flux EU cluster still has a
placeholder domain), and the Zitadel native application on the EU test cluster
(`ZITADEL_MOBILE_CLIENT_ID` is empty until it is made, so the apps refuse that
server with "doesn't allow the mobile apps yet").

## Open questions (as first drafted)

1. **First launch.** Default to Global with a "Change" link (recommended: no
   change for today's users), or ask everyone to pick on first launch?
2. **Test servers in production builds.** Keep Global test and EU test to
   `development` and `preview` builds (recommended), or allow them in
   production behind a hidden menu for support?
3. **EU push before the relay exists.** Off (recommended: keeps the EU
   promise), or Expo with content until the relay ships?
4. **Workspace switching on OIDC.** Is the browser sheet on a person's first
   switch to a workspace acceptable, or should the backend accept one token
   listing all workspaces plus a workspace header? The second is a change to
   SEC-012 and the Rust auth crate.
5. **Self-hosted at EU launch, or later?** Self-hosted needs the docs, the
   requirements check and (for push) the relay. Shipping EU first is smaller.
6. **ADR.** "One store build per app; the server is chosen at sign-in" is
   decided in the design doc but has no ADR. Proposed: MOB-006 in
   `weldsuite-documentation`, with the push relay as its own ADR.
