# WeldApps: native surfaces (extension points + remote UI)

Status: proposal. Follow-up to bridge protocol 2 (see "What shipped" below).

## Context

WeldApps render as a full page at `/apps/{code}` in a sandboxed iframe. Bridge
protocol 2 made that page feel much closer to a first-party module:

- **No token in the iframe.** The host performs the app's API calls with the
  member's own Clerk session (`fetch` bridge method). Community apps go through
  `app-api` `/api/user-apps/code/:code/gateway/v1/*`, which exchanges the session
  for the install's scoped `wsat_` token server-side, so external-api still
  enforces granted scopes.
- **Kept-alive frames.** Iframes live in `WeldAppFrameLayer` (shell level) and are
  positioned over the page's slot, so leaving and returning is instant and keeps
  state. Hovering an app in the rail preloads it.
- **Platform look.** Live design tokens (palette, radius, font) are pushed to the
  SDK, and a platform skeleton shows until the app reports its first render.
- **Native overlays and chrome.** `confirm`, `openModal` / `closeModal`,
  `setBreadcrumbs`, `setDirty` (leave guard), and Cmd/Ctrl+K / J forwarding.

Two gaps remain. Apps can only be a **separate page**: they cannot show up inside
WeldCRM, WeldDesk, and the rest, which is what makes first-party modules feel
integrated. And a page app is still a rectangle of foreign DOM: pixel parity
depends on the app using the SDK UI kit.

This plan closes both. It adds **surfaces** (extension points declared in the
manifest) and renders them with **remote UI**: the app describes its UI, and the
host draws it with real platform components.

## Goals

- Apps contribute UI to native slots: record tabs, record side panels, record
  actions, dashboard widgets, and settings pages.
- Surface UI is indistinguishable from first-party UI, with no drift and no
  foreign CSS.
- The security model is unchanged. App code never runs in the platform origin and
  never holds a credential. Scopes still gate data.
- Cheap enough to render many surfaces on one screen (a record page with three
  app tabs must not boot three full apps).

## Non-goals

- Replacing full-page apps. `/apps/{code}` keeps the protocol 2 iframe for
  arbitrary UIs (canvas, charts, bespoke layouts).
- Module federation for third-party code. It would run untrusted code in the
  platform origin; see the rationale in the protocol 2 discussion.

## Manifest: `surfaces`

Added to `userAppManifestSchema` (`@weldsuite/app-api-client/schemas/user-apps`)
and its CLI copy (`packages/sdk/cli/src/manifest.ts`):

```jsonc
"surfaces": [
  {
    "id": "customer-orders",
    "target": "record.tab",          // record.tab | record.panel | record.action | dashboard.widget | settings.page
    "entity": "customer",            // entity-events catalog type; required for record.*
    "label": "Orders",
    "icon": "ShoppingCart",
    "render": "remote",              // remote (default for non-page targets) | frame
    "path": "/surfaces/customer-orders",  // entry route inside the app
    "permission": "orders:read"      // optional platform permission to show it
  }
]
```

Validation rules:

- `entity` must exist in `packages/core/entity-events/src/events/`.
- A `record.*` surface requires the matching read scope (for example
  `companies:read`) in `scopes`. Otherwise it is rejected at `weld app deploy`.
- At most 20 surfaces per app, and 3 per `target` + `entity` pair.
- New surfaces on a version bump go through the existing scope-consent flow
  (`pendingScopes`), so a workspace sees what an update adds.

## Rendering model

### Remote UI (default for surfaces)

Based on Shopify's [`@remote-dom`](https://github.com/Shopify/remote-dom):

```
 ┌─ app runtime (hidden sandboxed iframe, 1 per app) ─┐        ┌─ platform (host) ─────────────┐
 │ app code + @weldsuite/app-sdk/remote                │  RPC   │ RemoteSurface slot           │
 │   <Stack><EntityList … onRowPress={…}/></Stack>     │ ─────▶ │   maps tree → real platform  │
 │   builds a remote tree of allowlisted components    │ ◀───── │   components (shadcn/ui)     │
 │   receives events (press, change, submit)           │ events │   serialises events back     │
 └─────────────────────────────────────────────────────┘        └──────────────────────────────┘
```

- **One runtime per app**, not one per slot. A hidden iframe on the app's bundle
  origin runs a `surfaces` entry (`index.html#/__surfaces`) and serves every
  mounted surface of that app over one MessageChannel. Each mount gets
  `{ surfaceId, target, entityType, entityId }` and returns a remote root.
- **Allowlisted components only.** This is the SDK UI kit's vocabulary, which
  already exists: `Page`, `Stack`, `Toolbar`, `Button`, `Badge`, `Input`, `Select`,
  `Textarea`, `FormField`, `Table`, `EntityList`, `DescriptionList`, `EmptyState`,
  `Alert`, `LoadingState`. There is no raw HTML, no `style`, and no `className`.
  Props are validated per component (Zod) on the host.
- **Host rendering** maps each remote component to the platform component
  (`@weldsuite/ui` / `apps/web/platform/components/ui`). Theme, density, dark
  mode, i18n direction and focus rings are the platform's own, so they cannot
  drift.
- **Data** goes through the same protocol 2 `fetch` proxy, so nothing new is
  needed on the security side.
- **URLs and images.** Links must be app-relative or platform-internal. Images
  are limited to the app's bundle origin or `https:`, and are loaded with
  `referrerpolicy="no-referrer"`.

The SDK side ships as `@weldsuite/app-sdk/remote`, with the same component names
as `@weldsuite/app-sdk/ui`. Porting a screen is mostly an import change:

```tsx
import { defineSurface, Stack, EntityList } from '@weldsuite/app-sdk/remote';

export default defineSurface('customer-orders', ({ entityId, api }) => {
  const orders = useQuery(() => api.records('orders').list({ filter: { customerId: entityId } }));
  return (
    <Stack>
      <EntityList rows={orders.data?.data ?? []} columns={[{ key: 'number', label: 'Order' }]} />
    </Stack>
  );
});
```

### Frame surfaces (escape hatch)

`render: "frame"` puts a protocol 2 iframe into the slot, for surfaces that need
free-form UI. Additions:

- A `resize` notification (`{ height }`, rate-limited) so the slot grows with
  content, capped per target (for example 640px for `record.panel`).
- Frames for off-screen slots are lazy: mounted on first visibility
  (IntersectionObserver) and unmounted when the record changes.

## Platform slots

A single component is placed at each extension point:

```tsx
<WeldAppSurfaceSlot target="record.tab" entityType="customer" entityId={id} />
```

- It reads installed apps (`useInstalledUserApps`) and filters manifest
  `surfaces` by target, entity, platform permission and granted scopes.
- Placements:
  - `record.tab`: object panel tabs (`components/object-panel`).
  - `record.panel`: the same host, as a stacked card.
  - `record.action`: the record header actions menu. It runs the app's action
    handler in the runtime, and `openModal` is available.
  - `dashboard.widget`: widget picker plus grid.
  - `settings.page`: an app section under workspace settings.
- Surfaces reuse the frame store's keep-alive idea at the **runtime** level: an
  app's hidden runtime iframe stays warm while any of its surfaces is mounted
  (LRU, same cap).

## Security review checklist

- App code runs only in sandboxed iframes on the bundle origin. Nothing executes
  in the platform origin.
- No credential enters any iframe. All data goes through the host proxy and the
  gateway, so scopes are enforced by external-api.
- The remote tree is data, validated per component. Unknown components or props
  are dropped with a dev-mode warning.
- Event payloads to the app carry only what the component emits (value, row id),
  never host DOM or record data the app did not fetch itself.
- Rate limits: tree updates are batched per animation frame, and the host drops a
  surface that exceeds N updates per second or M nodes.

## Phasing

1. **Manifest + slot scaffolding.** Add the `surfaces` schema, CLI validation,
   `WeldAppSurfaceSlot` with `render: "frame"` and auto-resize, for `record.tab`
   and `dashboard.widget`.
2. **Remote runtime.** Add `@weldsuite/app-sdk/remote`, the host renderer for the
   UI kit component set, the one-runtime-per-app multiplexer, and `record.panel`
   and `record.action`.
3. **Remaining targets.** Add `settings.page`, update the CLI scaffold
   (`weld app init --surface record.tab`), document it in the `weldsuite-app` skill,
   and extend the help docs.
4. **Optional.** Add a remote-rendered full page (`render: "remote"` on the app
   itself) for apps that want exact parity everywhere.

## Open questions

- Should `record.action` be allowed to mutate without a confirm? A proposed
  default: host-rendered `confirm` for any action flagged `destructive`.
- Where do surface settings live (per-workspace toggles to hide a surface)? The
  proposal is the existing app install record, `user_app_installs.settings`
  (schema change, needs approval).
- Mobile: remote trees could render with `@weldsuite/mobile-ui` later. Frames
  cannot, which argues for making remote the default early.
