# WeldHR

The WeldHR mobile app: **My HR for every employee, plus a Team tab for managers and HR**. One app, not two: most people who approve requests also make them, and approving a request belongs next to the notification that it was sent. Payroll runs, settings and other HR administration stay on the web.

It talks to the same `/api/weldhr/*` endpoints as the platform's WeldHR module (hr-api), through `@weldsuite/app-api-client` (`weldhr` + `weldhr-payroll` domains).

## What it does

| Tab | Who | What |
| --- | --- | --- |
| Home | everyone with My HR | Greeting, clock in/out, sick banner, next shift, leave balances, to-dos, quick actions |
| Time off | My HR | Balances, requests with status, request leave (allowance check), cancel |
| Expenses | My HR | Open totals, claims with status, new claim with receipt photo, withdraw, view receipt |
| Pay | My HR, when payroll is on | Payslips (PDF) and annual statements (jaaropgaaf / W-2) |
| Team | members with team permissions | Who is in, on leave or sick today; approve or decline leave and expenses; directory |
| Me | everyone | Profile, schedule & hours, onboarding tasks, reviews & coaching, sick leave, settings |

Settings: language (en/nl), appearance (system/light/dark), Face ID / fingerprint lock, sign out.

## Who sees what

Same model as `apps/web/platform/app/weldhr/access.ts`, resolved in `lib/access.ts` from `GET /api/me/permissions` (requests carry `X-Weld-App: weldhr`, so per-app grants apply):

- **My HR** needs `employees:self` and an employee record linked to the member. Without either, the screens say so instead of showing empty lists.
- **Team** shows when the member has any of: `leave:read` + `leave:approve`, `declarations:read` + `declarations:approve`, a dashboard permission (`employees|attendance|leave|coaching|evaluations:read`), `absences:read` or `employees:read`. Each section shows only what its permission allows.
- **Pay** shows when `GET /api/weldhr/me/payslips` answers (it is a 404 while the `weldhr-payroll` flag is off).
- Self clock-in, leave requests and declarations follow the workspace's portal switches (`features` on `GET /api/weldhr/me`). Reporting sick is always available.

The server checks everything again; the app only hides what would fail.

## Notes

- **Documents** (payslips, statements, receipts) have no public URL. They are downloaded with the member's session into the cache and handed to the OS (`utils/open-document.ts`), like WeldMail attachments.
- **Receipts** upload as multipart `file` after the claim is created; if only the upload fails, the claim stands and the member is told to hand the receipt in.
- **Realtime**: every `hr_*` topic refreshes the WeldHR queries (`lib/sync-map.ts`), so an approval shows up on the requester's phone straight away.
- **App lock** (`contexts/AppLockContext.tsx`) is off by default and asks again after a minute in the background.

## Run

```bash
pnpm install
pnpm --filter weldhr-app start      # dev client
pnpm --filter weldhr-app web        # browser preview on :3202 (sign in with a test-workspace account)
```

Tests (Jest is hoisted to the repo root on some machines; run it from there if `pnpm test` cannot find it):

```bash
cd apps/mobile/weldhr-app && node ../../../node_modules/jest/bin/jest.js
```

Fill in `apps/mobile/weldhr-app/.env` (`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_APP_API_URL`, `EXPO_PUBLIC_API_MODULES=all`).

## Before the first build

1. `pnpm --filter weldhr-app exec eas init` for the EAS project id (the placeholder blocks release builds on purpose).
2. Set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` for the EAS profiles.
3. Icons come from the platform's WeldHR mark: `pnpm --filter weldhr-app generate-icons`.
