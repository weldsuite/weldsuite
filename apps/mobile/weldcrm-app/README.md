# Mobile App Template

This folder is **not a real app**. It's the scaffold that `pnpm create:mobile-app` copies when spinning up a new Expo mobile app inside `apps/mobile/`.

It is excluded from the pnpm workspace (see `pnpm-workspace.yaml`) so the `{{PLACEHOLDERS}}` in its files never cause `pnpm install` to choke.

## Creating a new app

From the repo root:

```bash
pnpm create:mobile-app --name "WeldFoo" --code weldfoo --subtitle "Foo for your team"
```

Flags:

| Flag          | Example                    | Default                             |
| ------------- | -------------------------- | ----------------------------------- |
| `--name`      | `"WeldFoo"`                | *required*, human display name     |
| `--code`      | `weldfoo`                  | *required*, one-word lowercase id  |
| `--slug`      | `weldfoo-app`              | `<code>-app`                        |
| `--bundle`    | `com.weldsuite.weldfoo`    | `com.weldsuite.<code>`              |
| `--subtitle`  | `"Foo for your team"`      | `""`                                |
| `--color`     | `#3B82F6`                  | `#3B82F6`                           |
| `--eas-id`    | `<uuid>`                   | `00000000-0000-0000-0000-000000000000` (placeholder) |
| `--eas-init`  | (boolean)                  | off, pass it to run `eas init --force` in the new app folder |

The scaffolder writes to `apps/mobile/<slug>/`, substitutes all placeholders, and copies the placeholder PNGs in `assets/images/` (replace these with real art before shipping).

Pass `--eas-init` to have the scaffolder run `eas init --force` in the new app folder and sync the resulting project id into both `app.json` (`expo.extra.eas.projectId` + `expo.updates.url`) and `.env` (`EXPO_PUBLIC_EAS_PROJECT_ID`). Requires `eas-cli` installed globally and an Expo login with access to the `weldsuite` organization.

## After scaffolding

1. `.env` is copied from `.env.example`, fill in the Clerk publishable key.
2. If you didn't use `--eas-init`, run `eas init` inside the new app to get a real EAS project id, then paste it into `app.json` (`expo.extra.eas.projectId` + `expo.updates.url`) and into `.env` (`EXPO_PUBLIC_EAS_PROJECT_ID`).
3. Replace `assets/images/*.png` with branded art (icon 1024×1024, splash 200×200, notification 96×96, logo as needed).
4. Add the new app's path to each other mobile app's `.easignore` so sibling builds skip it.
5. `pnpm install` from the repo root.
6. `pnpm --filter <slug> dev` to start Expo.

## Placeholders used by the scaffolder

All occur as literal text inside files; the scaffolder does a plain string replace:

- `WeldCRM`, display name (e.g. `WeldFoo`)
- `weldcrm-app`, workspace + folder name (e.g. `weldfoo-app`)
- `weldcrm`, lowercase one-word id, used for scheme, bundle suffix, notification `APP_CODE` (e.g. `weldfoo`)
- `Your CRM on the go`, tagline shown on the login screen
- `com.weldsuite.weldcrm`, iOS bundle id / Android package (e.g. `com.weldsuite.weldfoo`)
- `#7C3AED`, hex color for brand accents, splash, notification icon
- `00000000-0000-0000-0000-000000000000`, EAS project UUID

## What's included

- Clerk auth (`@clerk/expo`) with `LoginScreen` from `@weldsuite/mobile-ui`
- AuthGuard + auto-select-first-org
- `no-workspace` screen for users without a Clerk org
- Bottom tabs (Home + Settings)
- `services/app-api.ts` (app-api client via `@weldsuite/api-client` + domain clients) and `services/api.ts` (CRM data layer over app-api)
- Realtime WebSocket provider (`@weldsuite/realtime/react`)
- Push notifications (`expo-notifications`) scaffolding
- EAS build config (development/preview/production channels)
- Android manifest fixes for OAuth redirect + OSGI META-INF duplicate resources
