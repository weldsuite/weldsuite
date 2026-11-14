# Mobile apps (`apps/mobile`)

One Expo app per module (Expo 57, React Native 0.86, Expo Router):
`weldagent-app`, `weldbooks-app`, `weldcalendar-app`, `weldchat-app`,
`weldcrm-app`, `welddesk-app`, `weldflow-app`, `weldhr-app`, `weldmail-app`,
`weldmeet-app`, `weldsocial-app`, `weldstash-app`. Read the root `AGENTS.md`
first; this file adds what is specific to the apps.

- `_template/` is the scaffold for a new app: run `pnpm create:mobile-app` from
  the root rather than copying an app by hand. It is not a workspace package.
- `_shared/` is `@weldsuite/mobile-realtime` and the shared eslint pieces.
- Shared UI is `@weldsuite/mobile-ui`.
- Each app has its own translations in `lib/i18n/locales/` (`en.ts`,
  `nl.ts`), not `@weldsuite/i18n`. Every new string goes in both.

## One build serves every edition

Each app is one build for Global, EU and self-hosted (ADR MOB-006): the server
is chosen at sign-in (`EXPO_PUBLIC_SERVER_PICKER`, off in production for now).
Hosts, sign-in and edition flags come from `@weldsuite/mobile-platform`:

- **Read `EXPO_PUBLIC_*` server values only in the app's `lib/server.ts`.**
  Expo inlines them only when written out in full in the app's own code.
- **Call `getMobileRuntime()` inside a function or component, never at module
  level**: the runtime is booted by `<ServerRuntimeGate>` in `app/_layout.tsx`.
- **Sign-in state comes from `@weldsuite/mobile-platform/auth`** (Clerk on
  Global, the server's OIDC provider elsewhere). Importing `@clerk/expo` is a
  lint error (`_shared/eslint/auth-facade.cjs`) except in the Clerk-only files
  an app lists there, which render inside `<ClerkOnly>`.

## API

Use the app-api client in each app's `services/app-api.ts`. It picks the host
per path like the platform does: modules listed in `EXPO_PUBLIC_API_MODULES`
go straight to their `<module>-api` worker, everything else to app-api. The
endpoints are the same ones the platform uses; don't add mobile-only routes.

## Commands

From an app folder (or `pnpm --filter <app> <script>`):

```bash
pnpm start          # expo start --dev-client
pnpm ios | android  # native run
pnpm test           # Jest (also test:watch, test:coverage)
pnpm lint
pnpm test:e2e       # Maestro flows in .maestro/, where the app has them
```

Native builds are the manual `mobile-build.yml` workflow (EAS); JS-only
changes ship as OTA updates from the deploy (`.github/actions/deploy-mobile`).
