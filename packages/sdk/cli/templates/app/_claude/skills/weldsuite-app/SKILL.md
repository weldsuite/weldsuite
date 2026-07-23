---
name: weldsuite-app
description: Building WeldSuite apps, iframe apps that run inside the WeldSuite platform. Use when working on a project with a weldapp.json manifest, when using @weldsuite/app-sdk, when interacting with WeldSuite app storage (collections / KV), or when deploying with the weld CLI. Covers the manifest schema, the host bridge lifecycle, the SDK API, storage endpoints, scopes, and the deploy/publish flow.
---

# Building WeldSuite apps

A WeldSuite app is a static web bundle (usually Vite + React) that the WeldSuite platform renders in a **sandboxed iframe**. The platform (host) gives the app a themed shell, the current user, and a short-lived **workspace-scoped API token** over a postMessage bridge. The app talks to the WeldSuite external API (`https://api.weldsuite.org`) with that token, most importantly to its own per-app storage (document collections + key-value store).

Everything below is what you need to build, wire, and ship one.

## 1. The manifest, `weldapp.json`

Lives at the project root. Validated by the CLI on deploy and again server-side. Field by field:

| Field | Type | Required | Rules / meaning |
| --- | --- | --- | --- |
| `code` | string | yes | Permanent app identity. 3–50 chars, `^[a-z][a-z0-9-]*$` (lowercase letters, digits, dashes, starts with a letter). Never change after `weld app create`. |
| `name` | string | yes | Display name, 1–100 chars. |
| `description` | string | no | Up to 2000 chars. Shown in the app store. |
| `icon` | string | no | Lucide icon name, e.g. `"Puzzle"`, max 50 chars. |
| `category` | string | no | Store category, max 50 chars. |
| `version` | string | yes | Strict semver `\d+.\d+.\d+` (e.g. `1.2.0`), max 20 chars. **Bump before every deploy.** |
| `entrypoint` | string | no | Bundle entry HTML, defaults to `index.html`. Max 255 chars. |
| `scopes` | string[] | no (default `[]`) | API scopes the app needs beyond its own storage. Format `resource:action`, `resource:*`, or `*`. Max 50. See §5. |
| `collections` | array | no | Document-storage collections the app uses. Each: `name` (`^[a-z][a-z0-9_-]*$`, 1–100 chars, required) + optional `description` (≤500). Max 50. Declare every collection referenced in code. |
| `agentTools` | array | no | Tools the app exposes to WeldAgent (AI). Each: `name` (snake_case, ≤64), `description` (1–1000), optional `parameters` (JSON Schema object), and `action`: `{ type: 'storage.list' \| 'storage.create' \| 'storage.update' \| 'storage.delete' \| 'api.request', collection?, method?, path? }`. `collection` for `storage.*` actions; `method` + `path` for `api.request`. Max 50. |
| `pricing` | object | no | `{ type: 'free' \| 'subscription', monthlyPrice?: 0–10000, currency?: 3-letter code }`. |
| `mobile` | boolean | no | Reserved, v1 renders on the web platform only. |

Example:

```json
{
  "code": "expense-notes",
  "name": "Expense Notes",
  "description": "Attach quick expense notes to your workspace.",
  "version": "1.1.0",
  "icon": "Receipt",
  "scopes": ["crm:read"],
  "collections": [
    { "name": "notes", "description": "Expense notes" }
  ]
}
```

The canonical schema is `userAppManifestSchema` in the WeldSuite monorepo (`packages/app-api-client/src/schemas/user-apps.ts`); the CLI ships an identical copy for offline validation.

## 2. Bridge lifecycle (host ↔ app postMessage protocol)

The SDK implements this, you rarely touch raw messages, but knowing the lifecycle explains behaviour:

1. **App boots** inside the sandboxed iframe and posts `{ type: 'weldapp:ready' }` to `window.parent`.
2. **Host replies** with `{ type: 'weldapp:init', payload: { appCode, theme: 'light' | 'dark', locale, apiBaseUrl, token, tokenExpiresAt, user: { id, name, imageUrl } } }`.
3. **Requests**: the app sends `{ type: 'weldapp:request', id, method: 'getToken' | 'navigate' | 'toast', payload? }`; the host answers `{ type: 'weldapp:response', id, ok, payload?, error?: { message } }`. `getToken` returns `{ token, tokenExpiresAt, apiBaseUrl }`.
4. **Push events**: the host sends `{ type: 'weldapp:event', event: 'theme' | 'locale', payload: { value } }` when the platform theme or locale changes.

Consequences:

- `connect()` **fails after 10s outside WeldSuite** (e.g. a plain `vite dev` tab). This is expected, develop by deploying to a workspace.
- Tokens are short-lived. The SDK caches them and refreshes 60s before expiry; a 401 triggers one refresh + retry. Never store the token yourself.
- Request timeout is 15s.

## 3. Using @weldsuite/app-sdk

Install: `npm install @weldsuite/app-sdk`. Two entry points: core (`@weldsuite/app-sdk`) and React (`@weldsuite/app-sdk/react`).

### React (recommended)

```tsx
// main.tsx, the provider performs the handshake; the gate waits for it.
import { WeldAppProvider, WeldAppGate } from '@weldsuite/app-sdk/react';

createRoot(rootElement).render(
  <WeldAppProvider>
    <WeldAppGate fallback={<p>Connecting…</p>}>
      <App />
    </WeldAppGate>
  </WeldAppProvider>,
);
```

```tsx
// Anywhere below the provider:
import { useWeldApp, useWeldApi, useCollection } from '@weldsuite/app-sdk/react';

const { app, theme, locale, user, bridge, status, error } = useWeldApp();
const api = useWeldApi();                       // bound WeldApi client (also on useWeldApp().api)
const notes = useCollection<Note>('notes');     // typed storage accessor (no query lib attached)
```

Theme awareness pattern:

```tsx
useEffect(() => {
  document.documentElement.dataset.theme = theme; // CSS switches on :root[data-theme='dark']
}, [theme]);
```

### Core (no framework)

```ts
import { createWeldApp } from '@weldsuite/app-sdk';

const { bridge, api } = createWeldApp();
const init = await bridge.connect();
bridge.on('theme', (value) => applyTheme(value));
await bridge.navigate('/crm/contacts');     // navigate the platform shell
await bridge.toast('Saved', 'success');     // 'default' | 'success' | 'error' | 'warning'
```

### Storage CRUD

```ts
const notes = api.records<Note>('notes');
const page = await notes.list({ limit: 50, cursor, filter: { pinned: true } });
// page = { data: AppRecord<Note>[], pagination: { totalCount, hasMore, cursor } }
const created = await notes.create({ text: 'hello', pinned: false });
const one = await notes.get(created.id);
await notes.update(created.id, { text: 'hello', pinned: true }); // REPLACES the document, send all fields
await notes.remove(created.id);

await api.kv.set('settings', { compact: true });
const settings = await api.kv.get<{ compact: boolean }>('settings'); // null when missing
await api.kv.delete('settings');
```

### Any other API

```ts
const contacts = await api.get<{ data: Contact[] }>('/v1/crm/contacts?limit=10');
await api.post('/v1/tasks', { title: 'Follow up' });
```

Errors throw `WeldApiError` with `status`, `code`, `message`.

## 4. Storage endpoints (what the SDK calls)

All on the external API, `Authorization: Bearer <wsat_ token>`; responses use `{ data }` / `{ data, pagination: { totalCount, hasMore, cursor } }` envelopes, errors `{ error: { code, message } }`.

- `GET /v1/app-storage/collections/{collection}/records`, query: `limit`, `cursor`, `filter` (JSON string, jsonb containment, e.g. `{"status":"open"}`)
- `POST /v1/app-storage/collections/{collection}/records`, body `{ data }`
- `GET /v1/app-storage/collections/{collection}/records/{id}`
- `PATCH /v1/app-storage/collections/{collection}/records/{id}`, body `{ data }`, **replaces** the document
- `DELETE /v1/app-storage/collections/{collection}/records/{id}`, 204
- `GET /v1/app-storage/kv/{key}` / `PUT /v1/app-storage/kv/{key}` (body `{ value }`) / `DELETE /v1/app-storage/kv/{key}`

Everything else on `/v1/*` (CRM, tasks, tickets, …) works with the same token, **subject to granted scopes**.

## 5. Scopes

Format: `resource:action`, `resource:*`, or `*` (avoid `*`). App storage needs no scope. Examples of the shape:

- `crm:read`, read CRM objects (contacts, customers, leads, …)
- `crm:write`, create/update CRM objects
- `tasks:read`, `tasks:write`, WeldFlow tasks
- `tickets:read`, `tickets:write`, WeldDesk tickets
- `commerce:*`, all commerce actions

Request the **narrowest** scopes that work; the workspace admin sees and consents to the list at install time, and new scopes on an update require re-consent.

## 6. weld CLI

Env: `WELD_API_KEY` (a `wsk_…` workspace API key, from Settings → API keys) and optional `WELD_API_URL` (default `https://api.weldsuite.org`).

| Command | Purpose |
| --- | --- |
| `weld app init [dir] [--name --code]` | Scaffold a new app (Vite + React + SDK + manifest + this skill). |
| `weld app create` | One-time registration of the app from `weldapp.json`. |
| `weld app deploy [--dir dist] [--changelog text] [--skip-build]` | Validate manifest → run build → upload `dist/**` as a new version. |
| `weld app publish [--notes text]` | Submit for public app-store review. |
| `weld app list` | Table of your apps (code, name, visibility, review status, installs). |
| `weld skill install [--force]` | Install this skill + CLAUDE.md snippet into another project. |
| `weld --help` / `weld --version` | Help / version. |

## 7. Definition of Done for a WeldSuite app change

- [ ] `npm run build` and `npm run typecheck` pass (strict TS, no `any`, no `@ts-ignore`).
- [ ] Every storage collection used in code is declared in `weldapp.json` → `collections`.
- [ ] Every non-storage API call is covered by a scope in `weldapp.json` → `scopes` (narrowest possible).
- [ ] UI respects both themes (`light` and `dark` via `data-theme`) and renders sensibly while `status` is `connecting` / `error`.
- [ ] `update()` calls send the **full document** (PATCH replaces, not merges).
- [ ] `version` in `weldapp.json` bumped (semver) before `weld app deploy`.
- [ ] No hand-rolled token handling, all API access goes through `WeldApi` / the bridge.
- [ ] Deployed with `weld app deploy` and verified inside a workspace, not just in a local tab.
