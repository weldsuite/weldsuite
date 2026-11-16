# Platform SPA (`apps/web/platform`)

The main WeldSuite web app: every module's UI. Read the root `AGENTS.md`
first; this file adds what is specific to the platform.

## It is a Vite SPA, not Next.js

No server components, server actions, `middleware.ts` or server rendering. All
data is fetched in the browser.

- **Routing** is TanStack Router, file-based. `src/routes/` holds thin route
  files, one folder per module (`src/routes/weldcrm/`, …); the components live
  in `app/<module>/`:

  ```tsx
  // src/routes/weldcrm/index.tsx
  import PageComponent from '@/app/weldcrm/page';
  export const Route = createFileRoute('/weldcrm/')({ component: PageComponent });
  ```

- **`src/routeTree.gen.ts` is generated. Never edit it.**
- `@` is the platform root (`@/app/…`, `@/hooks/…`, `@/lib/…`). Env vars are
  `VITE_*`.
- **Boot** (`src/main.tsx` → `@boot`): `VITE_RUNTIME_CONFIG` picks
  `src/boot/global.tsx` (Global, renders straight away) or
  `src/boot/runtime.tsx` (Kubernetes editions, reads `/config.json` first).
- **Editions**: `lib/edition.ts` says which modules and features this
  deployment offers. On EU and self-hosted, modules the Rust backend doesn't
  serve are hidden; check there before assuming a module or feature exists.

## Auth goes through the facade

Sign-in is Clerk on Global and OIDC (Zitadel) on the Kubernetes editions.
**Only `lib/auth/` may import `@clerk/*`**;
`lib/auth/no-direct-clerk-imports.test.ts` fails CI otherwise. Use the facade:

```ts
import { useAuth, useUser, useOrganization, getAuthToken } from '@/lib/auth';
```

Tests may still `vi.mock('@clerk/clerk-react')`.

## Data

- **API calls use the app-api client**: `useAppApi()`
  (`lib/api/use-app-api.ts`). It picks the host per path: modules listed in
  `VITE_API_MODULES` go straight to their `<module>-api` worker, everything else
  to app-api, which forwards. Leave it empty locally with `pnpm dev:api`.
- Query hooks live in `hooks/queries/use-<entity>-queries.ts` (TanStack Query).
  Client state is Jotai; forms are React Hook Form with the Zod resolver.
- Polls mounted on every page (badges, counters) use
  `useIdleAwareRefetchInterval` (`hooks/use-user-idle.ts`), never a plain
  `refetchInterval`.

## UI

Take every generic piece from `@weldsuite/ui`, imported by path. Don't build
dialogs, loaders, empty states, badges, page shells or filters inside a module
folder: add or extend the library component and its story instead.
`components/ui/` only re-exports two library files for old import paths;
don't add to it. Don't import `@radix-ui/*` here (three note dialogs still do,
for positioning the library `Dialog` can't do yet).

Text a library component renders on its own (Back, Cancel, Loading…) comes
from `UiLabelsProvider`, filled in `components/layout/accessibility-bridge.tsx`
from `@weldsuite/i18n`: add a label there, in `en` and `nl`.

| Need | From `@weldsuite/ui/components/…` |
|---|---|
| Confirm before a destructive action | `confirm-dialog` (`ConfirmDialog`) |
| Page or inline loading | `page-loader` (`PageLoader`, `InlineSpinner`) |
| Empty list, failed load | `empty-state` (`EmptyState`, `EmptyText`), `error-banner` (`ErrorBanner`, `ErrorState`, `InlineError`) |
| Notice, warning, tip | `info-banner` (`InfoBanner`) |
| Status pill | `soft-badge` (`SoftBadge`), `badge` |
| Stat tiles | `kpi-card` (`KpiGrid`, `KpiCard`); a tile that links: `@/components/kpi-card-link` |
| Page shells | `page-layout` (`DashboardPage`, `DetailPage`, `DetailHeader`, `TabBody`), `settings-layout` (`SettingsPage`, `SettingsSection`, `SettingRow`), `section-card`, `list-detail-layout`, `page-tabs` |
| Lists and detail panels | `list-table`, `entity-detail-panel` |
| Read-only label/value grid | `field-grid` (`FieldGrid`) |
| "All …" filter dropdown | `filter-select` (`FilterSelect`) |
| Number field | `number-input` (`NumberInput`) |
| Icon by name, activity history | `lucide-dynamic-icon`, `audit-timeline` |

New shadcn components go into the library:
`pnpm dlx shadcn@latest add <component> -c packages/design/ui`.

## Checks

```bash
pnpm --filter platform lint
pnpm --filter platform test            # Vitest + jsdom
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter platform type-check
pnpm --filter platform build           # Vite build + dist integrity check
```

## E2E (Playwright)

```bash
pnpm --filter platform test:e2e        # all specs; also :ui, :headed, :debug, :report
pnpm --filter platform exec playwright test e2e/specs/<area>/<file>.spec.ts
```

Needs the platform on 3000, the API running locally (`pnpm dev:api`) and
`.env.test` (copy `.env.test.example`; `TEST_USER_EMAIL`,
`TEST_USER_PASSWORD`, …). Chromium only.

The sign-in page is a custom React Hook Form (`#email`, `#password`), not
Clerk's `<SignIn>`. `page.fill()` does not update the form state, so the submit
sends an empty identifier; type per character instead
(`locator.pressSequentially(value, { delay })`).

## Help docs screenshots

Guide images in `apps/web/docs` are screenshots of preview scenes at
`/preview/help-docs?scene=…` (`app/preview/help-docs/`). When you change a
documented screen: update the Markdoc copy in `apps/web/docs/src/app/`, adjust
the scene if needed, run `pnpm --filter docs capture-screenshots:all` and
commit the PNGs with the UI change (skill `help-docs`).
