# @weldsuite/app-sdk

SDK for building **WeldSuite apps**, small web apps that run inside the WeldSuite platform in a sandboxed iframe, talk to the WeldSuite API with a workspace-scoped token, and get per-app document + key-value storage for free.

- `@weldsuite/app-sdk`, framework-agnostic core: the iframe bridge (`WeldAppBridge`) and the API client (`WeldApi`).
- `@weldsuite/app-sdk/react`, optional React bindings: `WeldAppProvider`, `useWeldApp`, `useWeldApi`, `useCollection`, `WeldAppGate`. Requires `react >= 18`.

Scaffold a full app (Vite + React + manifest + Claude skill) with the CLI:

```bash
npm i -g @weldsuite/cli
weld app init my-app
```

## Install

```bash
npm install @weldsuite/app-sdk
```

## How it works

Your app is loaded in a sandboxed iframe by the WeldSuite platform:

1. On boot the SDK posts `weldapp:ready` to the parent window.
2. The host replies with `weldapp:init` carrying your app code, the current theme (`light`/`dark`), locale, the API base URL, a workspace-scoped access token (`wsat_…`), and the viewing user.
3. From then on the app can send correlated requests (`getToken`, `navigate`, `toast`) and receives push events when the theme or locale changes.

Tokens are short-lived; the SDK caches them and transparently refreshes 60 seconds before expiry (and retries once on a 401). You never handle token plumbing yourself.

## React usage (recommended)

```tsx
// main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WeldAppProvider, WeldAppGate } from '@weldsuite/app-sdk/react';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WeldAppProvider>
      <WeldAppGate fallback={<p>Connecting to WeldSuite…</p>}>
        <App />
      </WeldAppGate>
    </WeldAppProvider>
  </StrictMode>,
);
```

```tsx
// App.tsx
import { useEffect, useState } from 'react';
import { useWeldApp, useCollection } from '@weldsuite/app-sdk/react';
import type { AppRecord } from '@weldsuite/app-sdk';

interface Note extends Record<string, unknown> {
  text: string;
  pinned: boolean;
}

export default function App() {
  const { theme, locale, user, bridge } = useWeldApp();
  const notes = useCollection<Note>('notes');
  const [records, setRecords] = useState<AppRecord<Note>[]>([]);

  // Follow the platform theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void notes.list({ limit: 50 }).then((res) => setRecords(res.data));
  }, [notes]);

  const addNote = async (text: string) => {
    const created = await notes.create({ text, pinned: false });
    setRecords((prev) => [...prev, created]);
    await bridge.toast('Note added', 'success');
  };

  return (
    <main>
      <h1>Hello {user?.name} ({locale})</h1>
      <button onClick={() => void addNote('New note')}>Add note</button>
      <ul>
        {records.map((r) => (
          <li key={r.id}>{r.data.text}</li>
        ))}
      </ul>
    </main>
  );
}
```

## Core usage (no framework)

```ts
import { createWeldApp } from '@weldsuite/app-sdk';

const { bridge, api } = createWeldApp();
const init = await bridge.connect(); // { appCode, theme, locale, user, ... }

// Document storage (per-collection, declared in weldapp.json)
const items = api.records<{ title: string; done: boolean }>('items');
const page = await items.list({ limit: 20, filter: { done: false } });
const created = await items.create({ title: 'Ship it', done: false });
await items.update(created.id, { title: 'Ship it', done: true }); // replaces the document
await items.remove(created.id);

// Key-value storage
await api.kv.set('settings', { compact: true });
const settings = await api.kv.get<{ compact: boolean }>('settings'); // null when missing
await api.kv.delete('settings');

// Any other WeldSuite API the app's granted scopes allow
const contacts = await api.get<{ data: unknown[] }>('/v1/crm/contacts?limit=10');

// Host interactions
bridge.on('theme', (value) => console.log('theme is now', value));
await bridge.navigate('/crm/contacts');
await bridge.toast('Saved!', 'success');
```

## API surface

### `WeldAppBridge`

| Member | Description |
| --- | --- |
| `connect()` | Handshake with the host. Idempotent. Rejects after 10s outside WeldSuite. |
| `request(method, payload?)` | Correlated request/response with the host, 15s timeout. |
| `on(event, cb)` | Subscribe to `theme` / `locale` push events. Returns unsubscribe. |
| `getToken({ forceRefresh? })` | Cached token, auto-refreshed 60s before expiry. |
| `navigate(to)` | Navigate the platform shell. |
| `toast(message, variant?)` | Show a platform toast (`default` \| `success` \| `error` \| `warning`). |
| `init` / `isConnected` | Current init snapshot (theme/locale stay live). |
| `destroy()` | Detach listeners, fail in-flight requests. |

### `WeldApi`

| Member | Description |
| --- | --- |
| `fetch(path, init?)` | Authenticated fetch against the API base URL. 401 → refresh + retry once. |
| `get` / `post` / `patch` / `delete` | JSON helpers. Throw `WeldApiError` (`status`, `code`, `message`) on failure. |
| `records(collection)` | Typed accessor: `list({ limit, cursor, filter })`, `create(data)`, `get(id)`, `update(id, data)`, `remove(id)`. |
| `kv` | `get(key)` (null if missing), `set(key, value)`, `delete(key)`. |

List responses follow the platform envelope: `{ data: T[], pagination: { totalCount, hasMore, cursor } }`.

## Local development

Running `vite dev` in a plain browser tab will fail `connect()` after 10 seconds with a clear error, the bridge needs the WeldSuite host on the other side. Develop by deploying to your workspace (`weld app deploy`) or embedding the dev server in a workspace app that points at your local URL.

## License

MIT
