<!-- weldsuite-app-skill -->
# CLAUDE.md, {{APP_NAME}}

This project is a **WeldSuite app**: a small Vite + React SPA that runs inside the WeldSuite business platform in a sandboxed iframe. For the full field-by-field manifest reference, bridge protocol, storage API, and deploy checklist, load the `weldsuite-app` skill at `.claude/skills/weldsuite-app/SKILL.md`.

## What a WeldSuite app is

- The platform renders `dist/index.html` in a sandboxed iframe and completes a postMessage handshake with `@weldsuite/app-sdk` (`weldapp:ready` → `weldapp:init`).
- The init payload provides theme (`light`/`dark`), locale, the current user, and a short-lived workspace-scoped API token, the SDK refreshes it automatically.
- The app gets per-app storage on the WeldSuite API: document collections and a key-value store. Broader API access (CRM, tasks, tickets, …) requires scopes declared in the manifest and granted at install time.

## Key files

- `weldapp.json`, the manifest. `code` is the permanent identity; bump `version` (semver) before every deploy; declare storage `collections` and API `scopes` here.
- `src/main.tsx`, mounts `WeldAppProvider` + `WeldAppGate`; don't remove them, the app cannot talk to WeldSuite without the provider.
- `src/App.tsx`, app UI. Uses `useWeldApp()` (theme/locale/user/bridge), `useCollection('items')` (typed storage CRUD), and `api.people.list()` as a `/v1` example.
- `src/styles.css`, themes via `:root[data-theme='dark']`; keep new styles working in both themes.

## Storage API (via the SDK, don't hand-roll fetches)

```ts
const items = useCollection<Item>('items');   // or api.records<Item>('items')
await items.list({ limit: 50, filter: { done: false } }); // jsonb containment filter
await items.create({ title: 'x', done: false });
await items.update(id, fullDocument);          // replaces the whole document
await items.remove(id);
await api.kv.set('key', value); await api.kv.get('key'); await api.kv.delete('key');
```

Every collection used in code must be declared in `weldapp.json` → `collections`.

## Deploy flow

1. `npm run build` must pass (deploy runs it for you).
2. Bump `version` in `weldapp.json` (strict semver).
3. `weld app deploy` (needs `WELD_API_KEY` or `weld login`; app must be registered once via `weld app create`).
4. Or push to GitHub: scaffold includes `.github/workflows/deploy-weld-app.yml` (secret `WELD_API_KEY`). `weld login` is interactive-only — CI must use the secret.
5. `weld app publish` only when the user wants it in the public store (not every CI push).

## Rules

- Keep TypeScript strict; no `any`, no `@ts-ignore`.
- The bridge connects inside WeldSuite, or in **local preview** when `localDev` is opted in (scaffold uses `import.meta.env.DEV`). Open `http://localhost:5173/` for UI + in-memory storage without the host; use `weld app dev` (optional `--tunnel`) for real integration at `/apps/{code}`.
- New user-visible behaviour should respect `theme` and degrade gracefully while `status !== 'ready'`.
