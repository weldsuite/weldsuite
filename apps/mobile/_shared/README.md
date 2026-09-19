# `@weldsuite/mobile-realtime`

Shared Expo wiring for WorkspaceHub → TanStack Query sync (`useRealtimeSync`).

Per-app **sync maps** stay next to each app’s query keys (keys differ:
`['weldflow',…]` vs `['weldstash',…]` vs `['accounting',…]`). This package
only shares the shell helpers.

## Exports

| Import | Purpose |
|---|---|
| `RealtimeSyncBridge` | Mount inside `QueryClientProvider` + realtime provider |
| `MobileRealtimeProvider` | Simple Clerk-token `/ws` provider |
| `createMobileQueryClient` | Default QueryClient options for mobile shells |
| `useQueryKeyInvalidation` | Imperative screens listening to sync-map invalidations |
| `inv` | Invalidate-only sync-map entry (re-export) |
| `seedSyncMapKeys` | Ensure invalidate prefixes exist in the cache |

## App recipe

1. Depend on `@weldsuite/mobile-realtime`, `@weldsuite/realtime`, `@tanstack/react-query`.
2. Add `lib/sync-map.ts` with an `EntitySyncMap`.
3. Mount: `QueryClientProvider` → `MobileRealtimeProvider` → `<RealtimeSyncBridge syncMap={…} currentUserId={…} />`.
4. Add `apps/mobile/<app>` to Metro `watchFolders` for `apps/mobile/_shared` + `packages/core/realtime`.
