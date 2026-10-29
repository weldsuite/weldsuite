# Spikes

Time-boxed experiments that answer a question from the phase plan
(`editions-and-self-hosting-phases.md` in weldsuite-documentation) before code
depends on the answer. Each one records the question, the setup, the numbers,
the verdict and what changed because of it.

The tool for S3 and S4 is `crates/db/examples/tenant_bench` (an example of
`weldsuite-db`, so CI compiles it and the image never contains it).

## Shared setup (S3 and S4, run 2026-10-29)

| | |
|---|---|
| Machine | one desktop: Windows 11, Intel i9-13900K (24 cores, 32 threads), Docker Desktop 29.9.2 (WSL2 VM with 32 CPUs and 31 GiB) |
| Postgres | 17.11 (`postgres:17`), `max_connections=500`, `shared_buffers=1GB`, `fsync=off`, `synchronous_commit=off`, `full_page_writes=off` |
| Pooler | PgBouncer 1.26.1, the image CloudNativePG 1.30.1 uses by default (`ghcr.io/cloudnative-pg/pgbouncer:1.26.1`) |
| Client | sqlx 0.9.0, Rust 1.99.1, release build |

The PgBouncer config copies what CloudNativePG renders for a `Pooler`: a
wildcard `* = host=<cluster>` database entry, `pool_mode = transaction`,
`ignore_startup_parameters = extra_float_digits,options`, and no
`max_prepared_statements` line (so PgBouncer's default applies). It differs in
auth (a userlist with SCRAM instead of `auth_query`) and has no TLS. Each spike
adds the settings named below.

## S3: sqlx prepared statements through PgBouncer in transaction mode

**Question.** Do sqlx prepared statements work through PgBouncer (the
CloudNativePG `Pooler`) in transaction mode? Pass: the query suite runs without
"prepared statement does not exist" errors. If it fails: unnamed statements
only, which costs some query planning time.

**Method.** One sqlx pool of 40 connections (all open) to PgBouncer with
`default_pool_size = 4`, so about ten clients share each server connection and
consecutive statements of one client land on different backends. Each client
runs rounds of:

- `get_member` and `get_role_permissions` from `crates/db/src/permissions.rs`
  (`query_as` with a bind, `fetch_optional`);
- a transaction: insert, read the row back, commit;
- one of 250 distinct `select $1::int8 + K` statements, more than sqlx's
  statement cache (100 per connection) and PgBouncer's
  `max_prepared_statements` (200 per server connection), so both evict.

Every answer is checked, so a statement executed on the wrong backend counts as
wrong even when no error comes back.

**Results** (300 rounds per client where the total is 48,000, 1,000 rounds
where it is 160,000).

| PgBouncer `max_prepared_statements` | sqlx | operations | right | wrong answers | errors |
|---|---|---:|---:|---:|---:|
| (direct to Postgres, control) | defaults | 48,000 | 48,000 | 0 | 0 |
| 0 | defaults (named statements, cache 100) | 48,000 | 17,089 | 3,777 | 27,134 |
| 0 | `statement_cache_capacity(0)` | 48,000 | 1,330 | 269 | 46,401 |
| 0 | `.persistent(false)` (unnamed statements) | 48,000 | 18,337 | 8,824 | 20,839 |
| 200 (the default since 1.24) | defaults | 160,000 | 160,000 | 0 | 0 |
| 200 | defaults, 20 distinct statements (nothing evicted) | 160,000 | 160,000 | 0 | 0 |
| 200 | defaults, 200 clients | 240,000 | 240,000 | 0 | 0 |
| 200 | `statement_cache_capacity(0)` | 160,000 | 160,000 | 0 | 0 |
| 200 | `.persistent(false)` (unnamed statements) | 160,000 | 60,961 | 29,556 | 69,483 |

The errors without pooler support: `prepared statement "sqlx_s_N" does not
exist`, `... already exists`, `bind message supplies N parameters, but prepared
statement requires M`, `unnamed prepared statement does not exist`,
`insufficient data left in message`, `invalid byte sequence for encoding
"UTF8"`, and column decode errors.

Why unnamed statements fail too: sqlx 0.9 prepares in its own round trip
(Parse, Describe, Sync), then binds and executes (Bind, Execute, Sync); see
`prepare()` and `run()` in `sqlx-postgres-0.9.0/src/connection/executor.rs`.
The first Sync ends the transaction as far as PgBouncer can tell, so the server
connection goes back to the pool between Parse and Bind, and the Bind runs
against whatever unnamed statement another client left on the next backend.
PgBouncer's prepared statement support covers named statements only. That is
where the wrong answers come from.

`statement_cache_capacity(0)` is not a "no prepared statements" mode in sqlx
0.9: queries are still prepared under a new name each time, never cached and
never closed (`get_or_prepare`, read from the source, not measured). It passed
through PgBouncer 200 but took 54.7 s against 35.1 s with the defaults for the
same run, and on a direct connection it would leave every statement prepared on
the backend.

**Verdict: pass**, with PgBouncer 1.21 or newer and `max_prepared_statements`
above 0. PgBouncer 1.24 made 200 the default and CloudNativePG does not set
it, so a CloudNativePG `Pooler` passes as shipped. The plan's fallback,
"unnamed statements only", does not work with sqlx: it fails, and worse, it
returns other queries' rows without an error.

**Consequence.**

- No code change: sqlx's defaults (named statements, cache of 100) are the
  passing configuration. The requirement is now stated on `WorkspaceConfig`.
- Never set `max_prepared_statements = 0`, and never use `.persistent(false)`
  or `statement-cache-capacity=0` for anything that goes through a
  transaction-mode pooler. That includes the master pool if it is pooled: its
  workspace lookup binds parameters too.
- A self-hosted install must use PgBouncer 1.21+ with prepared statement
  support (or a session-mode pooler, or none). Another pooler needs the same
  test before it is supported; `s3` is the test.

## S4: one process, thousands of workspace databases

**Question.** Can one process serve thousands of workspace databases? Pass: the
pool manager holds 2,000 workspace databases with 300 active at p99 under
50 ms for a simple query, and stays inside the pooler's connection limit. If
it fails: shard-level pools that switch database per transaction (`SET`-free
design), or route by shard.

**Setup.**

- 2,000 databases `ws_00000` … `ws_01999` from a template with one table
  (`items`, 100 rows); creating them took 6.9 s (`STRATEGY FILE_COPY`, fsync
  off). A master `workspaces` table with the columns `Workspaces` reads (as in
  `crates/db/tests/postgres.rs`), each `database_url` pointing at its database
  through PgBouncer.
- The bench runs in a container on the same Docker network. (The first runs,
  from the Windows host through published ports, are marked "host"; the
  Windows port proxy runs out of ephemeral ports sooner.)
- 300 concurrent loops, each: pick a workspace, `Workspaces::tenant(ref)`, then
  `select id, name from items where id = $1` with `fetch_optional`; then sleep
  0 to 200 ms (100 ms mean). Healthy, that is about 2,900 requests/s, about
  10/s per active workspace. With probability *cold* (1% or 5%) the pick is any
  of the 2,000; otherwise it falls in a window of 300 workspaces (uniform, or
  Zipf with s = 1) that slides through all 2,000 at 5 workspaces/s.
- Latency is measured around `tenant()` plus the query, for 60 s after a 15 s
  warm-up (90 s in runs 1, 2 and 6). Once a second the bench reads
  PgBouncer's `SHOW LISTS` and `SHOW POOLS` and counts `pg_stat_activity`
  backends on the `ws_` databases. "Pools held" comes from a copy of the LRU in
  the bench; it matched PgBouncer's pool count within one in every run.
- Pooler limits: `max_client_conn = 10000` (CloudNativePG leaves PgBouncer's
  default of 100, which one pod alone exceeds). The server budget is
  `max_user_connections`: all tenant databases use one role, so it caps total
  server connections under Postgres's 500 and lets PgBouncer close an idle
  server connection of one database to serve another. Run 1 has no budget
  (CloudNativePG's defaults).

**Results.** Pool settings are `tenant_max_connections` / `max_tenant_pools` /
`idle_timeout`; *budget* is the pooler's server connection cap; latency in ms;
connections are peaks.

| # | pools | budget | load | req/s | errors | p50 | p99 | p99.9 | client conns | server conns | |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 5 / 200 / 300 s (old default) | none | uniform, 5% cold (host) | 20 | 5,268 pool timeouts | 1.4 | 15.7 | 23.3 | 1,025 | 490 | fail |
| 2 | 5 / 200 / 300 s (old default) | 400 | uniform, 5% cold | 656 | 64,687 no free port | 229 | 571 | 632 | 477 | 403 | fail |
| 3 | 5 / 200 / 300 s (old default) | 400 | uniform, 1% cold | 788 | 83,457 no free port | 77 | 386 | 517 | 463 | 407 | fail |
| 4 | 5 / 2,000 / 300 s | 400 | uniform, 1% cold | 803 | 0 | 220 | 739 | 937 | 3,423 | 402 | fail |
| 5 | 5 / 2,000 / 300 s, PgBouncer `default_pool_size = 2` | 400 | uniform, 1% cold | 1,152 | 0 | 130 | 476 | 613 | 3,524 | 402 | fail |
| 6 | 2 / 2,000 / 60 s | 400 | uniform, 5% cold | 951 | 0 | 165 | 692 | 1,431 | 2,749 | 406 | fail |
| 7 | 2 / 2,000 / 60 s | 400 | uniform, 1% cold | 2,933 | 0 | 0.38 | 10.6 | 109 | 2,193 | 401 | pass |
| 7b | same, repeated | 400 | uniform, 1% cold | 1,966 | 0 | 2.9 | 336 | 625 | ~1,880 | ~400 | fail |
| 7c | same, repeated | 400 | uniform, 1% cold | 2,863 | 0 | 0.39 | 87.8 | 197 | ~2,110 | ~400 | fail |
| 8 | 2 / 2,000 / 300 s (3 runs) | 400 | uniform, 1% cold | 2,454 / 2,938 / 2,933 | 0 | 0.4 | 296 / 10.2 / 10.5 | 486 / 58 / 106 | 2,134 | 402 | 2 of 3 pass |
| 9 | 2 / 2,000 / 60 s | 400 | Zipf, 1% cold | 2,914 | 0 | 0.46 | 24.1 | 214 | 2,037 | 400 | pass |
| 10 | 2 / 2,000 / 60 s | 480 | uniform, 1% cold | 2,944 | 0 | 0.38 | 7.1 | 19.2 | 2,194 | 480 | pass |
| 11 | 2 / 2,000 / 300 s | 480 | Zipf, 1% cold | 2,946 | 0 | 0.36 | 7.5 | 21.0 | 2,039 | 480 | pass |
| 12 | 2 / 2,000 / 60 s | 480 | uniform, 5% cold | 2,829 | 0 | 1.7 | 43.5 | 83.4 | 2,659 | 481 | pass |
| 12b | 2 / 2,000 / 300 s | 480 | uniform, 5% cold | 2,579 | 0 | 3.4 | 141 | 269 | 2,653 | 481 | fail |
| 13 | **1 / 2,000 / 300 s (new default)** | 400 | uniform, 1% cold | 2,951 | 0 | 0.33 | 5.7 | 11.4 | 1,574 | 400 | pass |
| 14 | **new default** (2 runs) | 400 | uniform, 5% cold | 2,886 / 2,910 | 0 | 0.91 / 0.65 | 23.2 / 14.8 | 56.6 / 28.1 | ~1,990 | 400 | pass |
| 15 | **new default** | 400 | Zipf, 1% cold | 2,951 | 0 | 0.34 | 6.0 | 11.7 | ~1,530 | 400 | pass |
| 16 | 1 / 2,000 / 60 s | 400 | uniform, 1% cold | 2,950 | 0 | 0.34 | 5.9 | 11.6 | 1,573 | 401 | pass |
| 17 | 1 / 2,000 / 60 s | 400 | uniform, 5% cold | 2,915 | 0 | 0.58 | 14.0 | 26.4 | 1,992 | 401 | pass |
| 18 | 1 / 2,000 / 60 s | 400 | Zipf, 1% cold | 2,951 | 0 | 0.32 | 5.7 | 11.3 | 1,578 | 400 | pass |
| 19 | 1 / 2,000 / 60 s | 400 | uniform, 1% cold, 20 ms think | 10,495 | 0 | 6.0 | 34.4 | 53.5 | 1,988 | 400 | pass |
| 20 | 1 / 2,000 / 60 s | 250 | uniform, 1% cold | 1,484 | 0 | 83 | 331 | 477 | 1,262 | 253 | fail |
| 21 | **new default** | 400 | Zipf, 5% cold, 20 ms think | 3,923 | 0 | 13.0 | 425 | 583 | 1,998 | 401 | fail |
| 22 | 2 / 2,000 / 300 s | 480 | Zipf, 5% cold, 20 ms think | 3,559 | 0 | 16.8 | 473 | 716 | 2,650 | 480 | fail |

Requests that opened a pool (a workspace's first request, or one after
eviction) took p50 10 to 15 ms and p99 16 to 51 ms in the runs with the new
defaults (up to 114 ms in passing runs with 2 connections): a pooler login,
and often a new Postgres backend.

**What the runs show.**

1. **The old pool cap thrashes.** With `max_tenant_pools` 200 and 300 active
   workspaces, the LRU evicts pools that are in use; the next request opens a
   new pool and new TCP connections (14,451 pool opens in 60 s in run 3). The
   bench ran out of local ports (`EADDRNOTAVAIL`): Linux's default range
   (32768 to 60999) with 60 s of `TIME_WAIT` allows about 470 new connections
   a second to one pooler address, and a pod would hit the same wall.
2. **A pooler without a server budget stalls.** With CloudNativePG's defaults
   (`default_pool_size` 20, no `max_user_connections`, `server_idle_timeout`
   600 s), PgBouncer filled Postgres's 500 connections within 10 s with server
   connections of databases nobody was using any more, and did not close them
   for other databases' clients: 887 clients waiting, 5,268 timeouts in run 1.
   A `max_user_connections` cap below Postgres's limit makes PgBouncer close an
   idle server connection elsewhere instead.
3. **Server connections per database decide the outcome.** PgBouncer parks
   server connections per database. Once active databases times the server
   connections each holds exceeds the budget, a request for a database without
   a parked connection waits for PgBouncer to close one elsewhere and log in a
   new one (a Postgres backend start plus SCRAM, about 10 ms here, more with
   TLS). Waiting raises concurrency, which raises the demand for server
   connections: throughput fell from about 2,900 to as low as 800 requests/s
   and p99 went to 0.1 to 0.8 s. At 5 connections per pool it collapsed every
   time, even with the pool cap fixed (run 4) and with PgBouncer limiting each
   database to 2 server connections (run 5). At 2 it was bimodal with a budget
   of 400 (3 of the 6 uniform runs at 1% cold passed) and passed 3 of 4 runs
   with 480. At 1 it passed every run with 400, a budget of 1.33 times the
   active workspaces, except the hot-workspace run in point 4. With a budget
   below the active workspaces it fails at 1 too (run 20).
4. **The cost of one connection per pool.** A workspace's queries queue on its
   one connection within a pod. With Zipf and 20 ms think time the busiest
   workspace asks one pod for well over 1,000 queries a second, more than one
   connection serves here; it failed at 1 and at 2 connections alike (runs 21,
   22). The same queueing means one slow query delays the next requests of the
   same workspace on that pod.
5. **Client connections to the pooler.** With one connection per pool, a pod
   holds one client connection per workspace it served within the idle timeout:
   about 2,000 here. Idle client connections are cheap for PgBouncer (24 MiB of
   memory at about 2,200), but `max_client_conn` must cover every pod. The runs are
   shorter than the 300 s idle timeout, so how far the count drops in a quieter
   hour was not measured; 60 s and 300 s gave the same latencies.

**Verdict: pass with changed defaults; fail with the old ones.** With
`tenant_max_connections` 1 and `max_tenant_pools` 2,000, one process held
2,000 workspace databases with 300 active at p99 6 to 23 ms (about 2,900
requests/s; 34 ms at 10,500 requests/s), with no errors, inside a pooler budget
of 400 server connections and about 2,000 client connections. The old defaults
(5 / 200) failed every run. Not covered: a single workspace that needs more
than about one connection's throughput from one pod (run 21).

**Consequence.**

- `WorkspaceConfig::default()` in `crates/db` changed:
  `tenant_max_connections` 5 → 1 and `max_tenant_pools` 200 → 2,000;
  `idle_timeout` stays 300 s (no evidence either way). A test pins the values
  to this spike.
- **Not changed in this branch:** `bins/weldsuite/src/config.rs` has its own
  defaults for `TENANT_POOL_MAX_CONNECTIONS` (5) and `TENANT_POOLS_MAX` (200),
  and the Helm chart sets `tenantPoolMaxConnections: 5` and
  `tenantPoolsMax: 200`. Those override the crate defaults, so the server runs
  the failing configuration until both follow (1 and 2,000).
- The Pooler needs, beyond CloudNativePG's defaults: `max_client_conn` of at
  least pods × `max_tenant_pools` × `tenant_max_connections` plus headroom;
  `max_user_connections` (one tenant role) a little under Postgres's
  `max_connections` minus reserved slots, sized to at least 1.33 times the
  workspaces active at once; `max_prepared_statements` left at its default
  (S3). With several pods one workspace can hold a server connection per pod,
  so size the budget against active workspaces times the pods that serve them,
  and re-measure.
- The fallback (shard-level pools that switch database per transaction) is not
  needed for this target and was not built. It is the answer if one workspace
  needs more than a connection or two per pod, or if the active workspaces
  approach the server budget, because it shares server connections across
  databases instead of parking them per database.

## What a local run proves

- **S3 is a protocol result** and holds on any hardware: which client and
  pooler settings keep statements on the right backend does not depend on
  speed. Only PgBouncer 1.26.1 was tested.
- **S4's mechanisms are structural**: LRU thrash, port exhaustion, the stall
  without a server budget, and the collapse when per-database server
  connections outgrow the budget follow from how sqlx and PgBouncer pool, not
  from this machine.
- **S4's numbers are not production numbers.** Bench, pooler and Postgres
  shared one machine and a Docker bridge (sub-millisecond round trips; a
  cluster adds network hops). No TLS on either leg (CloudNativePG uses it on
  both, which makes each pooler login dearer and the collapse in point 3
  likelier). One process, not several pods. Runs of 60 to 90 s, so nothing on
  the scale of the 300 s idle timeout, PgBouncer's 3,600 s `server_lifetime` or
  memory growth. One indexed lookup on a one-table database. Near the threshold
  the variance between identical runs is large (runs 7 to 8). Re-run `s4` on
  the target cluster before sizing it.

## Re-running

```bash
cargo build --release -p weldsuite-db --example tenant_bench
B=target/release/examples/tenant_bench

# S3: --direct for setup, --pooled through PgBouncer (set default_pool_size low)
$B s3 --direct=postgres://app:secret@pg:5432/master --pooled=postgres://app:secret@pgbouncer:5432/master
$B s3 ... --cache=0
$B s3 ... --persistent=false

# S4: create the databases and the master table once, then run
$B s4-setup --direct=postgres://app:secret@pg:5432/master --pooled-base=postgres://app:secret@pgbouncer:5432/ --tenants=2000
$B s4 --master=postgres://app:secret@pg:5432/master --admin=postgres://app:secret@pgbouncer:5432/pgbouncer \
      --cold=0.05 --dist=uniform --tenant-max-connections=1 --max-tenant-pools=2000
```

The `--admin` user must be in PgBouncer's `admin_users` or `stats_users`.
