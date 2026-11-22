# WeldSuite pressure tests

k6 load tests that measure how much traffic WeldSuite can take. They point at a **test environment** by default, on one of two installs (`--target`):

- **`global`** (the default): WeldSuite Global, Hono workers on Cloudflare. A host per module worker (`crm-api-test.weldsuite.org`, …) plus `app-api`, Clerk sign-in, the public API on `api-test.weldsuite.org`.
- **`eu`**: the EU install, one Rust server on Kubernetes for every module. Everything on `api.test.weldsuite.eu`, the public API at `/v1` on that same host, WeldID sign-in.

On either, they cover two surfaces:

- **`platform`**: the first-party API that the platform SPA and the mobile apps call. The test signs in as a real member (Clerk on Global, WeldID on EU).
- **`public`**: the third-party API. The test signs in with a `wsk_` key.

Each virtual user acts like a busy member. It mostly reads: lists, search, pagination and notifications. A share of the time (20% by default) it runs a full write flow: create → read → update → delete for a person, company, ticket or task. Every record it creates is named `loadtest …`, gets an `@example.com` address and is deleted again in the same iteration. A sweep after each run removes anything left behind.

The EU server serves the same `/api/<object>` and `/v1/<object>` paths as Global's workers, so both targets run the same mix. The product list reads `/api/products`, which WeldStash owns while WeldCommerce is rebuilt. The public API no longer has `/v1/products` on either install, so the public mix leaves it out.

## One-time setup

1. Install k6: `winget install GrafanaLabs.k6` (macOS: `brew install k6`). Open a new terminal afterwards.
2. Use a **dedicated test workspace**. Don't run this in a workspace people work in. Turn off any WeldConnect automations or helpdesk workflows there that react to new tickets, people or tasks. If you leave them on, every write fans out into emails and jobs.
3. `cp scripts/load-test/.env.example scripts/load-test/.env` and fill in the part for your target below.

### Global (Clerk)

- **`CLERK_SECRET_KEY`**: the secret key of the Clerk instance that `app-test.weldsuite.org` uses.
- **`CLERK_SESSION_ID`**: sign in to `app-test.weldsuite.org` as the test user and switch to the test workspace. Then run `Clerk.session.id` in the browser console. The test mints fresh tokens from this session, so it stays valid until you sign out. If you sign out, copy a new one.
- **`WELD_API_KEY`**: a `wsk_` key of the test workspace, only needed for `public`. To test the workers rather than the rate limiter, the workspace should be on the **enterprise** tier (5,000 requests/min). Lower tiers cap at 60, 300 or 1,000 requests/min.

### EU (WeldID)

1. **A test member and workspace** on `app.test.weldsuite.eu`. Make an account for the test (its own address, not yours), create a workspace for it (e.g. "Load test"), and make the member an admin there. Not a partner-managed workspace: those only open the modules in their licence. To measure the cluster rather than one workspace, make several such workspaces with the same member in each (see [Capacity of the EU install](#capacity-of-the-eu-install)).
2. **Sign in once:**

   ```bash
   pnpm load-test login --target eu
   ```

   This opens WeldID (`auth.test.weldsuite.eu`) in your browser. **Sign in as the test member**: a private window is easiest if your browser is signed in as you. Afterwards close the window, but don't sign out there: that ends the test's session too. The command then lists the member's workspaces.
3. **`WELD_WORKSPACE`**: the test workspace's id (`ws_…`) from that list, or its slug. Several, comma separated, spread the virtual users over them. `--workspace` on the command line does the same.
4. **`WELD_API_KEY`**, for `public` only: a `wsk_` key made in the test workspace's settings, with the scopes `people`, `companies` and `tasks` (read and write) and `tickets:read`. One key per workspace, comma separated, when you spread the load. The same plan tiers apply as on Global.

How the EU sign-in works, and why: the login uses the authorization code flow with PKCE and a loopback redirect, through the install's desktop client (`weldsuite-desktop`, read from `api.test.weldsuite.eu/config.json`), the way the desktop app signs in. WeldID has no password grant, and its `client_credentials` tokens belong to a client, not to a member, so a browser sign-in is the only way to act as one. WeldID's access tokens live 10 minutes, and its refresh tokens rotate: a refresh token used twice revokes the whole sign-in. So the virtual users never refresh themselves. The runner keeps the refresh token in `scripts/load-test/.weldid/api.test.weldsuite.eu.json` (git-ignored, readable by you only), refreshes once for everyone, and hands the current access token to k6 through a small server on 127.0.0.1. Each run's refresh keeps the sign-in alive. It ends after 7 days without a run, after 30 days at the latest, or when someone signs out of it in WeldID: run `login` again then. `pnpm load-test logout --target eu` revokes it and deletes the file.

Requests name their workspace in the `X-Weld-Workspace` header, as the platform does in this mode. The server checks the member belongs to it; the pre-flight check stops the run with a 403 if not.

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

pnpm load-test platform smoke --target eu    # the same against the EU test install
pnpm load-test cleanup --target eu
```

Put `WELD_TARGET=eu` in `.env` to make EU the default.

Options:

| Option | Effect |
|---|---|
| `--target eu` | The EU install (Rust server, WeldID). Default `global`. |
| `--env production` | Production instead of test. Also needs `ALLOW_PRODUCTION=yes` (see below). |
| `--workspace ws_…` | EU: the test workspace(s), as `WELD_WORKSPACE`. |
| `--scale 0.2` | Multiplies every user count or request rate. Start low and work up. |
| `--writes 0` | Read-only run. `--writes 0.5` makes half the iterations write. |
| `--duration 10m` | Hold time for `load`/`soak`, ramp time for `breakpoint`. |
| `--via-app-api` | Global only: sends everything through app-api's forwarder instead of straight to the module workers. Compare the two to see the cost of the extra hop. |
| `--no-dashboard` | Skips the live dashboard and HTML report. |
| `--no-cleanup` | Skips the sweep after the run. |
| `--no-browser` | `login`: prints the sign-in link instead of opening a browser. |

Every setting can also go in `.env`, for example `THINK=0` to remove the pause between a user's actions, or `P95_READ_MS` to change a pass/fail limit. See `.env.example`.

Ctrl+C stops the run gracefully: k6 writes its report and the sweep still runs. A second Ctrl+C quits at once.

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

**Breakpoint.** The `breakpoint` profile raises the request rate steadily, by default to 1,000 iterations/s over 15 minutes. It stops itself once more than 5% of requests fail or p95 goes above 3 s. The report gives the rate it reached at that moment, which is the practical ceiling. To find where a stage starts to suffer, look at the HTML dashboard's latency chart, and at the dashboards of the install for the same time window (Neon and Cloudflare for Global; Grafana for EU, below).

**429 responses.** These are counted separately (`Rate limited`) and are not counted as failures of an endpoint. On the public API, a 429 means the per-workspace limiter is working. The report also says how many came from the proxy in front rather than from WeldSuite (a 429 without a JSON body): those mean this machine's address hit its limit, not the server (next section).

## Capacity of the EU install

The question a run on EU answers: how much traffic the cluster takes before Global's workspaces move in, and what runs out first. Read the k6 report together with the cluster's own view of the same minutes.

**What is in the way.** The EU server is the `weldsuite` Deployment in the `weldsuite` namespace. It scales itself between 2 and 6 replicas when the pods' average CPU passes 70% of what they request (250m each). Every write publishes an entity event to NATS JetStream, which the `weldsuite-consume` pods (two) work off for the audit log, webhooks, realtime and search. Data lives in CloudNativePG: the `master` cluster and the `tenants-1` shard that holds the workspace databases, each behind PgBouncer (`master-pooler`, `tenants-1-pooler`, namespace `postgres`). Traefik is in front of it all.

Three limits shape what a test from one machine can show:

- **Traefik limits each client address** to 100 requests/s (bursts of 400) and 400 open requests, per Traefik pod (`rust/deploy/flux/infrastructure/controllers/values/traefik.yaml`). One machine therefore tops out at roughly 100 to 200 requests/s whatever the server can do. The report flags these 429s. Past that, run k6 from several machines with their own addresses (each with its own `.env`, and its own `login`: two machines must never share a refresh token), or agree a window to lift the limit for the test's addresses.
- **Each server pod holds one connection per workspace database** (the chart's `config.tenantPoolMaxConnections: 1`), and PgBouncer gives each workspace database 4 server connections (`tenants-1-pooler`). A run in one workspace measures what one very busy workspace gets: its queries queue, which shows as latency while Postgres stays idle. Real traffic spreads over many workspaces. To measure the cluster, put 5 to 10 test workspaces in `WELD_WORKSPACE` (and one key each in `WELD_API_KEY`); the virtual users spread evenly over them. Do one run of each kind, single and spread, and keep both numbers.
- **The test cluster is smaller than production.** Its workers are CX23 nodes, production's CX33, so whatever the test cluster takes is a lower bound for production. Note the node type and count next to every result.

**Where to look while it runs** (pin the time window to the run):

- **Grafana** at `grafana.test.weldsuite.eu` (`grafana.<domain>`; sign in with a staff account):
  - *WeldSuite API*: requests/s, 5xx share, p95 latency per route, requests in flight, **database pools in use** (a pool at its maximum is a queue), consumer throughput.
  - *WeldSuite capacity*: CPU and memory requested and used per node and namespace. The node that fills first is where the next pod can't go.
  - *WeldSuite Postgres and backups*: connections per instance against `max_connections`, the server's connection pools, transactions, replication lag.
  - *WeldSuite jobs and consumers*: **pending and awaiting-ack messages per consumer** (NATS consumer lag). Lag that keeps growing after the run means the consumers can't keep up with the write rate, even when the API looked fine.
- **kubectl**, read-only, with the test cluster's context:

  ```bash
  kubectl --context admin@weldsuite-eu-test -n weldsuite get hpa weldsuite -w   # replicas 2 → 6, CPU against the 70% target
  kubectl --context admin@weldsuite-eu-test top nodes
  kubectl --context admin@weldsuite-eu-test -n weldsuite top pods
  kubectl --context admin@weldsuite-eu-test -n postgres top pods                # Postgres and PgBouncer
  kubectl --context admin@weldsuite-eu-test -n weldsuite get pods -w            # restarts, OOMKilled, Pending pods
  ```

  A `Pending` server pod while the HPA wants more replicas means the nodes are full, not the server.

**What to record** for every run, next to the k6 report:

- The target and size: install, node type and count, how many workspaces the load spread over, how many machines and addresses drove it.
- The rate reached: for `breakpoint`, the iterations/s and requests/s at the moment it stopped; otherwise the steady requests/s and how many 429s came from Traefik.
- p95 (and p99) per endpoint at that rate, from the report's table.
- Which resource ran out first, and when: server CPU with the HPA at 6 replicas, a node's CPU or memory (pods `Pending`), a server database pool or PgBouncer, Postgres CPU or connections, NATS consumer lag, Traefik's per-address limit. The first one to give is the answer; the rest is how much headroom the others have.
- How replicas moved: when the HPA scaled out, and whether p95 recovered after.

Compare that ceiling with the traffic Global's workspaces make today (their busiest hour, in requests/s, from Cloudflare's analytics) to see the headroom, and which resource to add first.

## Good to know

- The test's own machine and network can become the bottleneck before WeldSuite does. As a rough guide, one laptop handles a few hundred users. If the k6 process is near 100% CPU, the numbers stop meaning anything. To go bigger, run it from several machines, or from a cloud VM close to the install (Cloudflare's EU edge for Global, the cluster's region for EU).
- Every write publishes entity events. A heavy run therefore also loads the queues (audit, analytics, search index, realtime): Cloudflare Queues on Global, NATS JetStream on EU. That load is part of the real picture, but check those consumers' backlogs afterwards.
- Creating a task can also auto-schedule a calendar event and trigger notifications. Keep the test user's calendar sync off.
- Never point this at production without agreeing a window first. The runner refuses unless you pass `--env production` **and** set `ALLOW_PRODUCTION=yes`. It also refuses a `BASE_URL`, `PUBLIC_API_URL` or `EU_DOMAIN` that names a production host (`api.weldsuite.eu`, `crm-api.weldsuite.org`, …) without those two. EU production needs its own sign-in: `login --target eu --env production`, with `ALLOW_PRODUCTION=yes`.
- Local runs work too. Global: start `pnpm dev:api`, set `BASE_URL=http://localhost:8789` and `PUBLIC_API_URL` to the local external-api. These mostly measure `wrangler dev` on your machine. EU: `BASE_URL` pointing at a local Rust server with OIDC in header mode.

## Files

| File | What it does |
|---|---|
| `run.mjs` | The runner: reads `.env`, picks the target and profile, starts k6, writes reports, runs the sweep. On EU it also signs in (`login`) and runs the token broker. |
| `scenarios/platform.js` | First-party API mix: weights, endpoints and write flows. |
| `scenarios/public-api.js` | Public API mix. |
| `scenarios/cleanup.js` | Deletes leftover `loadtest` records. |
| `lib/targets.mjs` | Hosts per target and environment, and the production guard (shared by k6 and the runner). |
| `lib/config.js` | Profiles, thresholds and the workspace header. |
| `lib/auth.js` | Session tokens in k6: Clerk tokens on Global, the broker's WeldID tokens on EU. |
| `lib/weldid.mjs` | The WeldID sign-in and the token broker (Node). |
| `lib/http.js` | Tagged requests and per-endpoint metrics. |
| `lib/summary.js` | The end-of-run report. |

To add an endpoint, give it a key in `endpointMetrics([...])` and a weighted entry in `READS` or `WRITES` of the scenario. For EU, check that the Rust server serves the path too (`rust/modules/*`).
