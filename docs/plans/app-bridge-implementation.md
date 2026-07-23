# WeldSuite App Bridge, Shopify-Style Custom Apps

## Context

WeldSuite customers want to build their own apps that integrate cleanly into the platform. Following the Shopify App Bridge model: customer apps are hosted externally (any tech stack), rendered in an iframe inside the platform shell, and communicate with the platform via an App Bridge SDK using `postMessage`. Apps appear in the sidebar alongside native modules and feel like first-class citizens.

The existing `packages/sdk/helpdesk-widget-sdk/` already has production-grade iframe management, postMessage communication, security, and state synchronization, all directly reusable.

---

## Architecture Overview

```
Customer's App (hosted on their infra)
  │
  ├── Uses @weldsuite/app-bridge SDK
  │   └── postMessage ↔ Platform Shell
  │
  └── Calls WeldSuite External API (authenticated via session token)
      └── GET/POST /v1/crm/contacts, etc.

Platform Shell
  │
  ├── /apps/$appCode route → renders iframe
  ├── AppBridgeHost listens to postMessage
  │   ├── Navigation requests → TanStack Router
  │   ├── Toast/modal requests → Platform UI
  │   ├── Session token requests → Clerk getToken()
  │   ├── Theme sync → pushes theme to iframe
  │   └── Context sync → workspace, user, locale
  │
  └── Sidebar entry from app manifest
```

---

## Phase 1: App Bridge SDK Package (~1 week)

### 1.1 Create `packages/app-bridge/`

Reuse patterns from `packages/sdk/helpdesk-widget-sdk/`:

| Reuse from helpdesk-widget-sdk | Adapt for App Bridge |
|------|------|
| `MessageBroker`, origin validation, request/response, queueing, rate limiting | Same pattern, new message types for app bridge |
| `SecurityManager`, origin whitelist, payload sanitization, secure IDs | Reuse as-is |
| `StateCoordinator`, dot-notation state, subscriptions, batch updates | Adapt for app context (user, workspace, theme) |
| `WeldSDK`, singleton registry, ready promise, lifecycle callbacks | Adapt as `AppBridge` class |

**SDK structure:**
```
packages/app-bridge/
  src/
    index.ts, main export
    AppBridge.ts, main class (like WeldSDK)
    types.ts, message types, config, context
    messages/
      MessageBroker.ts, adapted from helpdesk-widget-sdk
      SecurityManager.ts, reused from helpdesk-widget-sdk
      types.ts, AppBridge-specific message types
    actions/
      navigation.ts, navigate(), redirect(), history
      toast.ts, showToast()
      modal.ts, openModal(), closeModal()
      resource-picker.ts, pickContact(), pickProduct(), etc.
      session.ts, getSessionToken()
      fullscreen.ts, enterFullscreen(), exitFullscreen()
    context/
      hooks.ts, useAppBridge(), useSessionToken(), useWorkspace()
      provider.tsx, AppBridgeProvider (React context)
    utils/
      validation.ts, message validation
```

**AppBridge public API (what customer devs use):**
```typescript
import { createApp, useAppBridge } from '@weldsuite/app-bridge';

// Initialize
const app = createApp({
  apiKey: 'app_xxx',          // from app registration
  host: window.__WELDSUITE_HOST__,  // encoded host info passed via URL param
});

// Navigation
app.navigate('/settings');     // navigate within the app's iframe
app.redirect.toAdmin('/crm/contacts');  // navigate platform shell

// Session token (for API calls)
const token = await app.getSessionToken();
// → platform responds via postMessage with a short-lived JWT
// → customer app uses this to call External API

// Toast
app.toast.show({ message: 'Saved!', type: 'success' });

// Modal
app.modal.open({
  title: 'Select Contact',
  url: '/contact-picker',   // renders another iframe URL from the app
  size: 'large',
});

// Context (reactive)
app.subscribe('context', (ctx) => {
  console.log(ctx.workspace, ctx.user, ctx.locale, ctx.theme);
});

// React hooks (in @weldsuite/app-bridge/react)
function MyComponent() {
  const app = useAppBridge();
  const token = useSessionToken();      // auto-refreshing
  const { workspace, user } = useContext(); // reactive context
}
```

**Message types (postMessage protocol):**
```typescript
// Platform → App (inbound to iframe)
'app-bridge::init'           // { apiKey, context, sessionToken }
'app-bridge::context-update' // { workspace, user, locale, theme }
'app-bridge::session-token'  // { token, expiresAt } (response)
'app-bridge::modal-close'    // { result }
'app-bridge::navigation'     // { path } (platform navigated)

// App → Platform (outbound from iframe)
'app-bridge::ready'          // app loaded, request init
'app-bridge::request-token'  // request session token
'app-bridge::navigate'       // { url } navigate platform shell
'app-bridge::toast'          // { message, type, duration }
'app-bridge::modal-open'     // { title, url, size }
'app-bridge::modal-close'    // close current modal
'app-bridge::title'          // { title } set page title
'app-bridge::loading'        // { loading: bool } show/hide loading bar
'app-bridge::fullscreen'     // { enabled: bool }
'app-bridge::resize'         // { height } auto-resize iframe height
```

### 1.2 Session token flow

Like Shopify's session tokens, short-lived JWTs scoped to the app:

1. App calls `app.getSessionToken()` → sends `app-bridge::request-token` via postMessage
2. Platform host receives it → calls Clerk `getToken()` → creates a **scoped JWT** containing `{ userId, orgId, appCode, scopes }` via a new API endpoint
3. Platform sends `app-bridge::session-token` back with the JWT
4. App uses this JWT as `Authorization: Bearer <token>` header when calling the External API
5. External API validates the JWT and enforces `scopes` and `appCode` restrictions
6. Tokens expire after 5 minutes, SDK auto-refreshes

**New endpoint needed:** `POST /api/apps/session-token` in api-worker
- Input: `{ appCode }` + authenticated Clerk session
- Validates the app is installed in the workspace
- Returns a short-lived JWT with app-scoped claims
- Signs with a worker-level secret (not Clerk)

---

## Phase 2: Platform Host, iframe + Bridge Host (~1 week)

### 2.1 Catch-all route for custom apps

**New files:**
- `apps/web/platform/src/routes/apps/route.tsx`, layout with auth guard
- `apps/web/platform/src/routes/apps/$appCode/$.tsx`, splat route

The splat route loads the app's manifest, creates an iframe pointing to `manifest.appUrl + subPath`, and mounts the `AppBridgeHost` component.

### 2.2 AppBridgeHost component

**New file:** `apps/web/platform/app/apps/app-bridge-host.tsx`

Responsibilities:
- Creates sandboxed iframe (`sandbox="allow-scripts allow-forms allow-same-origin allow-popups"`)
- Passes `host` param in iframe URL (encoded platform origin + app config)
- Listens to postMessage from iframe via adapted `MessageBroker`
- Handles all bridge message types:
  - `request-token` → calls `/api/apps/session-token`, responds with JWT
  - `navigate` → uses TanStack Router `router.navigate()`
  - `toast` → calls platform `toast()` (sonner)
  - `modal-open` → renders a platform `<Dialog>` with another iframe inside
  - `title` → updates document title / breadcrumb
  - `loading` → shows platform loading bar
  - `resize` → adjusts iframe height
- Pushes context updates to iframe (workspace change, theme change, locale change)

**Reuse from helpdesk-widget-sdk:**
- `IframeManager` pattern for iframe creation + lifecycle (adapt from launcher/widget to single app iframe)
- `MessageBroker` for postMessage with origin validation, queueing, ready handshake
- `SecurityManager` for origin whitelist + sanitization

### 2.3 Sidebar integration

**File to modify:** `apps/web/platform/components/app-sidebar-client.tsx`
- Custom apps (type `'custom'`) route to `/apps/{appCode}` instead of `/{appCode}`
- Use `sidebarConfig` from manifest for icon/label
- Support remote icon URLs (not just lucide icons)

**File to modify:** `apps/web/platform/hooks/use-installed-apps.ts`
- Extend query response to include `type`, `appUrl`, `sidebarConfig` for custom apps

**File to modify:** `apps/web/platform/components/app-access-guard.tsx`
- Add `/apps` to allowed prefixes

### 2.4 Module sidebar for custom apps

**New file:** `apps/web/platform/app/apps/app-sidebar-config.ts`
- Custom apps can optionally declare sidebar navigation items in their manifest
- Rendered via the existing `UnifiedModuleSidebar` / `MODULE_CONFIGS` pattern
- Dynamic config loaded from manifest's `navigation` field

---

## Phase 3: Schema + API (~1 week)

### 3.1 Extend `app_catalog` schema

**File:** `packages/core/db/src/schema/app-catalog.ts`

New columns:

| Column | Type | Purpose |
|--------|------|---------|
| `type` | varchar(20) default `'native'` | `'native'` \| `'custom'` |
| `appUrl` | text | Base URL of the app (e.g. `https://my-app.com/weldsuite`) |
| `appApiKey` | varchar(50) | Unique API key for the app (`app_xxx`) |
| `appSecret` | text | Hashed secret for session token signing |
| `scopes` | jsonb default `[]` | Requested API scopes |
| `redirectUrls` | jsonb default `[]` | Allowed redirect URLs |
| `sidebarConfig` | jsonb | `{ icon, iconUrl, label, badge }` |
| `navigation` | jsonb | Optional sidebar nav items |
| `reviewStatus` | varchar(20) default `'pending'` | `'pending'` \| `'approved'` \| `'rejected'` |
| `developerOrgId` | varchar(255) | Clerk org of the developer |
| `webhookUrl` | text | URL for event webhooks |
| `webhookEvents` | jsonb default `[]` | Subscribed event types |

### 3.2 App registration API

**New file:** `apps/api-worker/src/routes/app-registry.ts`

| Endpoint | Purpose |
|----------|---------|
| `POST /api/app-registry` | Developer submits app manifest |
| `GET /api/app-registry` | List developer's apps |
| `GET /api/app-registry/:code` | Get app details |
| `PUT /api/app-registry/:code` | Update manifest |
| `DELETE /api/app-registry/:code` | Remove app |
| `POST /api/app-registry/:code/credentials` | Rotate API key/secret |
| `PATCH /api/app-registry/:code/review` | Admin approve/reject |

### 3.3 Session token endpoint

**New file:** `apps/api-worker/src/routes/app-session.ts`

`POST /api/apps/session-token`
- Authenticated via Clerk middleware
- Input: `{ appCode }`
- Validates app is installed in workspace
- Generates short-lived JWT (5 min) with claims: `{ sub: userId, org: orgId, app: appCode, scopes: [...] }`
- Signs with per-app secret (from `app_catalog.appSecret`)

### 3.4 External API, app-scoped auth

**File to modify:** `apps/workers/external-api/src/middleware/auth.ts`
- Support app session tokens alongside existing `wsk_` API keys
- Validate JWT signature against app secret
- Enforce `scopes` from JWT claims
- Add `appCode` to request context for audit logging

---

## Phase 4: Developer Portal + App Store (~1 week)

### 4.1 Developer settings page

**New files:**
- `apps/web/platform/src/routes/settings/developer/index.tsx`
- `apps/web/platform/app/settings/developer/page.tsx`

Features:
- Register new app (name, URL, scopes, icon, description)
- View API key + secret (show once on creation)
- Manage webhook subscriptions
- View installation stats
- Test app loading in dev mode (enter localhost URL)

### 4.2 App store updates

**File to modify:** `apps/web/platform/app/appstore/app-store-client.tsx`
- "Community Apps" / "Third Party" section for custom apps
- Show developer name, review badge, scope summary

**File to modify:** `apps/web/platform/app/appstore/[code]/app-detail-client.tsx`
- Scope permission display (what data the app accesses)
- Install/uninstall with scope consent dialog
- Developer info section

### 4.3 App installation consent

**New file:** `apps/web/platform/app/apps/install-consent-dialog.tsx`
- Shows requested scopes in human-readable format
- User must approve before installation
- Creates `workspaceInstalledApps` record + webhook subscription

---

## Phase 5: Developer Tools + Starter Template (~0.5 week)

### 5.1 Starter template

GitHub template repo or `packages/create-weldsuite-app/`:

```
weldsuite-app-template/
  src/
    App.tsx, example using useAppBridge(), useSessionToken()
    api.ts, helper to call External API with session token
  vite.config.ts, standard Vite React config (no special externals needed!)
  weldsuite.app.json, manifest template
  README.md, setup guide
```

**Key advantage over micro-frontends:** The customer app is a **completely standard React app**. No externals config, no shared dependencies, no version pinning. Any React version, any framework, any bundler. The only dependency is `@weldsuite/app-bridge`.

### 5.2 Documentation

- Getting started guide
- App Bridge API reference
- Session token authentication
- Webhook event reference
- Scopes reference
- App review guidelines

---

## Security Model

| Layer | Protection |
|-------|-----------|
| **iframe sandbox** | `allow-scripts allow-forms allow-same-origin allow-popups`, no top-level navigation |
| **Origin validation** | MessageBroker only accepts messages from registered `appUrl` origin |
| **Session tokens** | Short-lived JWTs (5 min), scoped to app + workspace, auto-refresh |
| **API scoping** | External API enforces `scopes` from JWT, app can only access permitted resources |
| **CSP** | `frame-src` whitelist only approved app domains |
| **Rate limiting** | MessageBroker: 100 msg/min. External API: tier-based (existing) |
| **Review process** | Apps must be approved before appearing in public app store |
| **Payload sanitization** | SecurityManager sanitizes all postMessage payloads (XSS prevention) |
| **Webhook signatures** | HMAC SHA-256 on outbound webhooks (existing pattern) |

---

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/core/db/src/schema/app-catalog.ts` | Add custom app columns |
| `apps/web/platform/components/app-sidebar-client.tsx` | Route custom apps to `/apps/{code}` |
| `apps/web/platform/hooks/use-installed-apps.ts` | Include custom app metadata |
| `apps/web/platform/components/app-access-guard.tsx` | Allow `/apps` prefix |
| `apps/api-worker/src/index.ts` | Mount new routes + middleware |
| `apps/workers/external-api/src/middleware/auth.ts` | Support app session token auth |
| `apps/web/platform/app/appstore/app-store-client.tsx` | Community apps section |

## New Files to Create

| File | Purpose |
|------|---------|
| `packages/app-bridge/` | App Bridge SDK (postMessage, hooks, React provider) |
| `apps/web/platform/src/routes/apps/route.tsx` | Custom apps layout route |
| `apps/web/platform/src/routes/apps/$appCode/$.tsx` | Catch-all splat route |
| `apps/web/platform/app/apps/app-bridge-host.tsx` | iframe host + bridge message handler |
| `apps/web/platform/app/apps/install-consent-dialog.tsx` | Scope consent on install |
| `apps/api-worker/src/routes/app-registry.ts` | App CRUD endpoints |
| `apps/api-worker/src/routes/app-session.ts` | Session token endpoint |
| `apps/web/platform/app/settings/developer/page.tsx` | Developer portal |

## Patterns to Reuse

| From | Reuse |
|------|-------|
| `packages/sdk/helpdesk-widget-sdk/src/core/MessageBroker.ts` | postMessage protocol, origin validation, request/response, queueing |
| `packages/sdk/helpdesk-widget-sdk/src/core/SecurityManager.ts` | Origin whitelist, payload sanitization, secure IDs |
| `packages/sdk/helpdesk-widget-sdk/src/core/IframeManager.ts` | iframe creation, sandbox attrs, ready handshake |
| `packages/sdk/helpdesk-widget-sdk/src/core/StateCoordinator.ts` | State sync across iframe boundary |
| `packages/sdk/helpdesk-widget-sdk/src/core/WeldSDK.ts` | Singleton pattern, ready promise, lifecycle callbacks |
| `apps/workers/external-api/src/middleware/auth.ts` | API key + scope validation pattern |
| `apps/workers/external-api/src/lib/rate-limit.ts` | Tier-based rate limiting |
| `packages/core/db/src/schema/external-webhooks.ts` | Webhook delivery + retry pattern |

## Verification

1. **SDK test:** Create a minimal React app using `@weldsuite/app-bridge`, verify `createApp()` + `getSessionToken()` work via postMessage
2. **Platform test:** Install a test custom app → verify sidebar entry → navigate to `/apps/test-app` → verify iframe loads with correct sandbox + host param
3. **Auth test:** App requests session token → platform returns JWT → app calls External API with JWT → verify scoped access works
4. **Bridge test:** App sends `navigate`, `toast`, `modal-open` messages → verify platform handles each correctly
5. **Security test:** App tries to call API endpoint outside its scopes → verify 403. Tampered origin → verify rejected by MessageBroker
6. **E2E:** Full flow, register app → install with consent → use app → uninstall
