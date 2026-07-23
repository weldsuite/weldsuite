# WeldSocial Mobile

Expo / React Native app for **WeldSocial**, social publishing on the go. Scaffolded from `apps/mobile/_template` and wired to the unified **app-api** (`/api/social-*` routes) via `@weldsuite/app-api-client`.

## Features

- **Home**, dashboard stats (scheduled, published this week, pending approval, connected accounts) + upcoming posts
- **Queue**, scheduled / drafts / sent posts, segmented
- **Calendar**, month view with per-day post list
- **Composer**, create/edit posts, pick target accounts, attach media from the library (or add by URL), save draft / schedule / publish now (PostPeer-backed)
- **Approvals**, review pending posts, approve/reject with decision notes
- **Analytics**, impressions, reach, engagement, clicks + per-platform stats (read-only)
- **Accounts**, connected social accounts, start PostPeer hosted OAuth, sync channels
- **Campaigns**, list + create campaigns
- **Push notifications**, Expo push tokens registered against app-api `/api/push-tokens` (`appCode: weldsocial`); notification taps deep-link via `data.route`

## Architecture

- **Auth**: Clerk (`@clerk/expo`). The session JWT carries the active organization; app-api resolves the tenant DB from it.
- **API**: `services/app-api.ts` builds a `createClientApi` client (base URL from `EXPO_PUBLIC_APP_API_URL`) and exposes the `social`, `pushTokens`, `workspaces`, and `me` domain clients.
- **Data fetching**: `hooks/use-async-data.ts`, focus-aware loads + pull-to-refresh (no react-query).
- **UI**: `@weldsuite/mobile-ui` primitives + theme.

## Setup

1. Fill in `.env` (copied from `.env.example`): Clerk publishable key, `EXPO_PUBLIC_APP_API_URL`, `EXPO_PUBLIC_REALTIME_URL`.
2. Run `eas init` inside this folder to get a real EAS project id; paste it into `app.json` (`expo.extra.eas.projectId` + `expo.updates.url`) and `.env` (`EXPO_PUBLIC_EAS_PROJECT_ID`). Push notifications need a real project id.
3. Replace `assets/images/*.png` with branded art.
4. `pnpm install` from the repo root.
5. `pnpm --filter weldsocial-app start` to run Expo (dev build required for push notifications, not Expo Go).
