# WeldSuite pressure tests

k6 load tests that measure how much traffic WeldSuite can take. They point at the **test environment** by default. They cover two surfaces:

- **`platform`**: the first-party API that the platform SPA and the mobile apps call. That is the module workers (`crm-api`, `desk-api`, `flow-api`, `commerce-api`) plus `app-api`. The test signs in as a real member through Clerk.
- **`public`**: the third-party API (`external-api`, `api-test.weldsuite.org`). The test signs in with a `wsk_` key.

Each virtual user acts like a busy member. It mostly reads: lists, search, pagination and notifications. A share of the time (20% by default) it runs a full write flow: create → read → update → delete for a person, company, ticket or task. Every record it creates is named `loadtest …`, gets an `@example.com` address and is deleted again in the same iteration. A sweep after each run removes anything left behind.

## One-time setup

1. Install k6: `winget install GrafanaLabs.k6` (macOS: `brew install k6`). Open a new terminal afterwards.
2. Use a **dedicated test workspace**. Don't run this in a workspace people work in. Turn off any WeldConnect automations or helpdesk workflows there that react to new tickets, people or tasks. If you leave them on, every write fans out into emails and jobs.
3. `cp scripts/load-test/.env.example scripts/load-test/.env` and fill it in:
   - **`CLERK_SECRET_KEY`**: the secret key of the Clerk instance that `app-test.weldsuite.org` uses.
   - **`CLERK_SESSION_ID`**: sign in to `app-test.weldsuite.org` as the test user and switch to the test workspace. Then run `Clerk.session.id` in the browser console. The test mints fresh tokens from this session, so it stays valid until you sign out. If you sign out, copy a new one.
   - **`WELD_API_KEY`**: a `wsk_` key of the test workspace, only needed for `public`. To test the workers rather than the rate limiter, the workspace should be on the **enterprise** tier (5,000 requests/min). Lower tiers cap at 60, 300 or 1,000 requests/min.

## Running

```bash
pnpm load-test platform smoke        # 1 user, 30s: check that everything works first
pnpm load-test platform load         # 50 users for 5 min: a normal busy day
pnpm load-test platform stress       # 50 → 100 → 200 → 400 users: where it starts to hurt
pnpm load-test platform spike        # 10 → 500 users in 10 seconds
pnpm load-test platform soak         # 50 users for 30 min: leaks and slow drift
pnpm load-test platform breakpoint   # keeps raising the rate until it breaks, then stops
pnpm load-test public load           # same profiles against the public API
pnpm load-test all stress            # platform, then public
pnpm load-test cleanup               # delete leftover loadtest records by hand
```

Options:

| Option | Effect |
|---|---|
| `--scale 0.2` | Multiplies every user count or request rate. Start low and work up. |
| `--writes 0` | Read-only run. `--writes 0.5` makes half the iterations write. |
| `--duration 10m` | Hold time for `load`/`soak`, ramp time for `breakpoint`. |
| `--via-app-api` | Sends everything through app-api's forwarder instead of straight to the module workers. Compare the two to see the cost of the extra hop. |
| `--no-dashboard` | Skips the live dashboard and HTML report. |
| `--no-cleanup` | Skips the sweep after the run. |

Every setting can also go in `.env`, for example `THINK=0` to remove the pause between a user's actions, or `P95_READ_MS` to change a pass/fail limit. See `.env.example`.

## Reading the results

- During the run, a live dashboard is at http://localhost:5665.
- At the end, the terminal prints the verdict and a per-endpoint table: request count, median, p95, p99, max and error rate.
- Everything is saved in `scripts/load-test/results/` (git-ignored):
  - `<run>-<api>-<profile>.md`: the same report as the terminal.
  - `.html`: the full dashboard with charts over time. Open it in a browser.
  - `.json`: the raw k6 summary, for comparing runs.

**Pass/fail.** A run passes when all of these hold:

- Under 1% of requests fail.
- p95 for reads is under 800 ms.
- p95 for writes is under 1.5 s.
- Over 98% of checks pass.

k6 exits with code 99 when a limit is crossed.

**Breakpoint.** The `breakpoint` profile raises the request rate steadily, by default to 1,000 iterations/s over 15 minutes. It stops itself once more than 5% of requests fail or p95 goes above 3 s. The report gives the rate it reached at that moment, which is the practical ceiling. To find where a stage starts to suffer, look at the HTML dashboard's latency chart, and at the Neon and Cloudflare dashboards for the same time window.

**429 responses.** These are counted separately (`Rate limited`) and are not counted as failures. On the public API, a 429 means the per-workspace limiter is working.

## Good to know

- The test's own machine and network can become the bottleneck before WeldSuite does. As a rough guide, one laptop handles a few hundred users. If the k6 process is near 100% CPU, the numbers stop meaning anything. To go bigger, run it from several machines, or from a cloud VM close to Cloudflare's EU edge.
- Every write publishes entity events. A heavy run therefore also loads the queues (audit, analytics, search index, realtime). That load is part of the real picture, but check those consumers' backlogs afterwards.
- Creating a task can also auto-schedule a calendar event and trigger notifications. Keep the test user's calendar sync off.
- Never point this at production without agreeing a window first. The runner refuses unless you pass `--env production` **and** set `ALLOW_PRODUCTION=yes`.
- Local runs work too: start `pnpm dev:api`, set `BASE_URL=http://localhost:8789` and `PUBLIC_API_URL` to the local external-api. These mostly measure `wrangler dev` on your machine.

## Files

| File | What it does |
|---|---|
| `run.mjs` | The runner: reads `.env`, picks the profile, starts k6, writes reports, runs the sweep. |
| `scenarios/platform.js` | First-party API mix: weights, endpoints and write flows. |
| `scenarios/public-api.js` | Public API mix. |
| `scenarios/cleanup.js` | Deletes leftover `loadtest` records. |
| `lib/config.js` | Hosts, profiles, thresholds and the production guard. |
| `lib/auth.js` | Mints and renews Clerk session tokens. |
| `lib/http.js` | Tagged requests and per-endpoint metrics. |
| `lib/summary.js` | The end-of-run report. |

To add an endpoint, give it a key in `endpointMetrics([...])` and a weighted entry in `READS` or `WRITES` of the scenario.
