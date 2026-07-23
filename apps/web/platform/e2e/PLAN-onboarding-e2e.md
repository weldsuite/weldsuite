# Plan, E2E test: new signup + workspace creation (onboarding)

**Status:** proposed (not yet implemented)
**Decision:** Full end-to-end, including real Neon tenant-DB provisioning, with a new
guarded `/test-fixtures` teardown endpoint for cleanup.

---

## 1. Goal & scope

Cover the path a brand-new user takes, end to end, with no pre-existing session or org:

1. Anonymous visitor → `/auth/register`
2. Custom `useSignUp()` form: first/last name, email, password, confirm
3. Email verification: 6-digit OTP
4. Redirect to `/onboarding`
5. 4-step wizard: **Profile → Organization → Role → Apps**
6. Submit → real workspace provisioning (Clerk org + Neon tenant DB)
7. Provisioning screen polls `/onboarding/database-status` until ready
8. Redirect to `/` (dashboard), assert authenticated landing
9. **Teardown:** delete the Clerk org + drop/deactivate the tenant DB created by the run

This is the only spec that exercises Clerk **sign-up** (existing `auth.setup.ts` only does sign-**in**) and the only one that provisions a workspace from scratch (every other spec assumes the shared `TEST_WORKSPACE_ID`).

---

## 2. Why this needs special handling

| Concern | Detail |
|---|---|
| **Sign-up, not sign-in** | Custom form via `useSignUp()`, not Clerk's `<SignUp>`. Needs `setupClerkTestingToken({ page })` to bypass bot protection (same as `auth.setup.ts`). |
| **Email OTP** | Clerk **test mode** lets us use a `+clerk_test` email and the fixed verification code **`424242`**, no real inbox. This is the linchpin that makes the flow automatable. |
| **Real provisioning** | `handleSubmit()` calls `completeOnboarding()` → creates Clerk org + Neon tenant DB, then polls `/onboarding/database-status` (up to 90× / 2s = 3 min). Test timeout must accommodate this. |
| **Cleanup** | `/test-fixtures/reset` only wipes *entities inside an existing workspace*. It does **not** delete a Clerk org or drop a tenant DB. A new teardown endpoint is required (Part B). |
| **Project placement** | Must run in `chromium-unauth` (no `storageState`) → file goes in `e2e/specs/unauth/`. |
| **Must NOT pollute shared workspace** | The run creates its own throwaway org; it must never touch `TEST_WORKSPACE_ID`. Teardown targets only the org id captured during the run. |

---

## Part A, The teardown endpoint (backend, app-api)

> Build this **first**, the spec's `afterAll` depends on it. New backend work, so it
> belongs in `app-api` per repo rules. Spawn `backend-app-api` for this part.

### A1. Endpoint
- **Route:** `POST /test-fixtures/teardown-workspace`
- **Router file (confirmed):** `apps/workers/app-api/src/routes/_test-fixtures/index.ts`
, add the handler next to the existing `/reset`, `/seed/*`, `/entity/:type/:id`.
- **Guard (confirmed, reuse):** `apps/workers/app-api/src/middleware/test-fixtures-guard.ts`
  already enforces `ENVIRONMENT !== 'production'` + `X-Test-Token` match. The whole
  `_test-fixtures` router is mounted behind it, no new guard wiring needed.
- **Body:** `{ clerkOrgId: string }` (Zod v3, both directions).
- **Extra safety in the handler:** refuse if `clerkOrgId === env.TEST_WORKSPACE_ID`
  (never nuke the shared E2E workspace) → return 400.

### A2. What it does
1. Look up the workspace row in the **master DB** by Clerk org id.
2. Drop / deactivate the associated **Neon tenant DB**. Provisioning lives in
   `apps/workers/workspace-worker/src/routes/onboard.ts` +
   `apps/api-worker/src/services/neon/provisioning.ts`, mirror / reuse the deletion path
   from there (or call workspace-worker via service binding) rather than re-implementing
   the Neon API calls inline.
3. Delete the **Clerk organization** (Clerk backend SDK; helper at
   `apps/workers/workspace-worker/src/lib/clerk.ts` is a reference for server-side Clerk calls).
4. Remove the master-DB workspace/membership rows.
5. Respond `{ data: { ok: true } }` (or 204).

### A3. Notes
- Idempotent: a second call for an already-gone org returns `ok: true`, not 500.
- This is destructive + outward-facing (deletes a Clerk org), keep it strictly behind
  both guards and the `TEST_WORKSPACE_ID` refusal.
- Add a typed method to `e2e/helpers/test-fixtures-client.ts`:
  `teardownWorkspace(clerkOrgId: string)`.

---

## Part B, The spec (frontend, platform)

`backend-app-api` for Part A, then `frontend-platform` for this part.

### B1. File & placement
- **New file:** `apps/web/platform/e2e/specs/unauth/onboarding.spec.ts`
- Runs in `chromium-unauth` (matched by `**/specs/unauth/**/*.spec.ts`, no session).
- Import `{ test, expect }` from `../../fixtures` (gets the auto `consoleErrors` fixture
  + `api` client). Import `isTestFixturesConfigured` and skip in `beforeAll` if env not
  wired (teardown can't run without it).

### B2. Unique per-run identity (no `Date.now()`/`Math.random()` constraint is for
workflow scripts, not specs, specs may use them freely)
```
const stamp = Date.now();
const email = `weldsuite-e2e+clerk_test_${stamp}@example.com`;  // +clerk_test = Clerk test addr
const password = 'E2eTest!' + stamp;                              // meets 8+/upper/lower/number
const orgName = `E2E Onboarding ${stamp}`;
```
Capture the created `clerkOrgId` from the page (read `window.Clerk.organization.id` after
`setActive`, or assert it off the network response) into a spec-scoped variable for
`afterAll` teardown.

### B3. Steps & assertions

**Sign-up (`/auth/register`)**
- `setupClerkTestingToken({ page })`, `goto('/auth/register')`, wait for `Clerk.loaded`.
- Assert heading `Create an account`.
- Fill `#firstName`, `#lastName`, `#email`, `#password`, `#confirmPassword`.
- Assert **Create Account** button enabled only once the form is valid (contract check).
- Click **Create Account**.

**Email verification**
- Assert heading `Verify your email`.
- Type `424242` into the 6-slot OTP (`[data-input-otp]`). Auto-submits at 6 digits;
  fall back to clicking `#verify-btn`.
- Wait for redirect to `/onboarding`.

**Wizard, Step 1 Profile** (indicator `1/4`, heading `Set up your profile`)
- `#firstName` / `#lastName` prefilled from Clerk; `#email` disabled.
- Assert **Continue** disabled when a name is cleared, enabled when both filled.
- Click **Continue**.

**Wizard, Step 2 Organization** (`2/4`, `Set up your workspace`)
- `#organizationName` = `orgName`.
- Country combobox: open, search, pick (e.g. `Netherlands`) → auto-sets region.
- `#region`, `#organizationSize` selects; `#referralSource` free-text.
- Assert **Continue** disabled until all filled. Click **Continue**.

**Wizard, Step 3 Role** (`3/4`, `Tell us about your role`)
- Click a role button (e.g. `Engineering`); assert selected styling.
- Click **Continue**.

**Wizard, Step 4 Apps** (`4/4`, `Choose your apps`)
- Select ≥1 app; assert "N app(s) selected".
- Assert **Get Started** disabled at 0 apps, enabled at ≥1. Click **Get Started**.

**Provisioning → dashboard**
- Assert provisioning screen (`Creating your database` etc.).
- `page.waitForURL('/', { timeout: 200_000 })`, generous, covers the 3-min poll ceiling.
- Capture `clerkOrgId`. Assert an authenticated dashboard marker is visible
  (e.g. `data-testid="app-sidebar"` once a module loads, or the home shell).
- `consoleErrors` fixture auto-asserts no unexpected console errors throughout.

### B4. Teardown
```
test.afterAll(async ({}, testInfo) => {
  if (createdOrgId) await testFixtures.teardownWorkspace(createdOrgId);
});
```
- Best-effort: log on failure rather than throwing (don't mask a real test failure).
- Also handles the Clerk **user**, deleting the org may orphan the user; if Clerk
  doesn't cascade, extend the teardown endpoint to delete the test user by email too.

### B5. Timeouts
- `test.setTimeout(240_000)` for this spec (signup + 3-min provision + margin).
- Keep it out of the default per-test 2-min budget.

---

## 3. Selector reference (from current code)

| Surface | Selector |
|---|---|
| Register heading | `h1` contains `Create an account` |
| Register fields | `#firstName`, `#lastName`, `#email`, `#password`, `#confirmPassword` |
| Register submit | role=button name `Create Account` |
| Verify heading | `h1` contains `Verify your email` |
| OTP | `[data-input-otp]`; submit `#verify-btn` |
| Wizard step indicator | text `1/4` … `4/4` |
| Profile | `#firstName`, `#lastName`, `#email` (disabled); button `Continue` |
| Organization | `#organizationName`, country combobox (`Search country...`), `#region`, `#organizationSize`, `#referralSource` |
| Role | role buttons by label; `Continue` |
| Apps | app buttons by label; `Get Started` |
| Done | `/` + `data-testid="app-sidebar"` |

> Risk: several wizard CTAs are matched by **visible text** (`Continue`, `Get Started`),
> which is locale-fragile (en/nl). **Recommended hardening:** add stable `data-testid`s
> to the wizard's Continue/Get Started buttons and the OTP verify button, per the repo's
> documented `data-testid` convention. Small `frontend-platform` change; makes the spec
> robust against translation + Tailwind drift.

---

## 4. CI / config

- No `playwright.config.ts` change needed, `chromium-unauth` already globs
  `specs/unauth/**`.
- Requires `.env.test` with `CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` (Clerk test
  instance), and the three fixture vars (`TEST_API_URL`, `TEST_FIXTURES_TOKEN`,
  `TEST_WORKSPACE_ID`) so teardown can authenticate.
- Deploy the teardown endpoint's `TEST_FIXTURES_TOKEN` secret to the `test`/`preview`
  app-api envs (already set for existing fixtures, same token).
- Because it provisions real infra and runs ~3 min, consider tagging it `@slow` and
  excluding from the fast PR lane if runtime becomes a problem (optional; the decision was
  full E2E per-run, so default is: it runs with the suite).

---

## 5. Work breakdown

1. **`backend-app-api`**, `POST /test-fixtures/teardown-workspace` (+ Zod schema, guards,
   Clerk org delete, tenant-DB drop, master-row cleanup) + client method.
2. **`frontend-platform`** (optional but recommended), add `data-testid`s to wizard
   Continue / Get Started / OTP verify buttons.
3. **`frontend-platform`**, write `e2e/specs/unauth/onboarding.spec.ts`.
4. Run locally: `pnpm exec playwright test e2e/specs/unauth/onboarding.spec.ts --headed`
   against a Clerk **test** instance; verify the org/DB are gone after the run.
5. Update `e2e/README.md` "What the suite covers" table (unauth row now > 1 file).

---

## 6. Confirmed file map

| Thing | Path |
|---|---|
| test-fixtures router (add endpoint here) | `apps/workers/app-api/src/routes/_test-fixtures/index.ts` |
| test-fixtures guard (already applied) | `apps/workers/app-api/src/middleware/test-fixtures-guard.ts` |
| onboarding submit hook | `apps/web/platform/hooks/use-onboarding.ts` |
| onboarding wizard UI | `apps/web/platform/app/onboarding/components/onboarding-wizard.tsx` |
| wizard option data (countries, regions, roles, sizes) | `apps/web/platform/app/onboarding/types.ts` |
| workspace provisioning | `apps/workers/workspace-worker/src/routes/onboard.ts` |
| Neon DB provisioning service | `apps/api-worker/src/services/neon/provisioning.ts` |
| server-side Clerk helper | `apps/workers/workspace-worker/src/lib/clerk.ts` |
| fixtures client (add `teardownWorkspace`) | `apps/web/platform/e2e/helpers/test-fixtures-client.ts` |
| login setup to mirror for signup | `apps/web/platform/e2e/auth.setup.ts` |

> Note: `app-api` is in the **primary** checkout (`repos\weldsuite\apps\app-api`).

## 7. Open items to confirm at implementation

- Whether `workspace-worker` exposes a reusable DB-deletion path the teardown endpoint can
  call, vs. doing it inline / via service binding.
- Whether deleting the Clerk org cascades the test user, or the endpoint must also delete
  the user by email.
- The precise `completeOnboarding` API route + `/onboarding/database-status` response shape
  (read `use-onboarding.ts`), for an optional network-level assertion; the UI-level
  assertions above don't strictly need it.
