# WeldPanel phase 0: Basin spike

Run on 2026-10-27 against the WeldSuite Cloudflare account, to answer the four
questions in [weldpanel.md](../weldpanel.md) ("Phase 0 spike"). Every resource
was named `panel-spike*` / `panel_spike_*` and deleted afterwards.

## Verdict

**Go for Basin, with four changes to the plan**, and one decision for the
owner: Basin tables cannot sit in an EU-jurisdiction bucket.

1. **EU jurisdiction: not possible.** Basin Catalog cannot be enabled on an
   EU-jurisdiction bucket, and catalog sinks have no jurisdiction setting. The
   spike ran on a normal bucket with location hint `weur` (Western Europe),
   which works end to end. Choose between that and ClickHouse Cloud (EU) for the
   event tables. Recordings are plain R2 objects and keep the EU jurisdiction
   either way.
2. **Speed: within target at this volume, if queries avoid rescanning the
   table.** 6 of 8 query shapes had a median under 5 s on the 5M-event project,
   all of them under 3.2 s on the small one, and none was rejected by the
   memory budget. The two misses: trends with a top-10 subquery (6.7 s), which
   drops to 1.2 s once the top 10 is picked in panel-api, and the funnel with
   identity resolution (5.8 s), which the funnel without the join does in
   3.7 s.
3. **Files mix every project.** Catalog sinks offer no partitioning or sort
   order, so every file holds all projects. A project filter cannot skip
   files; scan size and cost per query grow with the whole platform's traffic,
   not with the customer's own. Fine at launch volumes, the first thing to
   outgrow. Needs a plan before the platform passes a few hundred million
   events a month (below).
4. **One stream per table, not one stream fanned out by `kind`.** Every
   pipeline is billed for all the data it reads, so a fan-out to four tables
   bills the stream four times. Stream ingress is free, so separate streams
   cost nothing extra.

## Setup

| Resource | Value |
|---|---|
| Bucket | `panel-spike`, location hint `weur`, Basin Catalog on, compaction off |
| Stream | `panel_spike_stream`, structured (26 typed fields incl. `ts timestamp`, `cookieless bool`, `x int32`, `properties` JSON string), Worker binding only |
| Sinks | `panel_spike_events_sink` → `panel.events_v1`, `panel_spike_identities_sink` → `panel.identities_v1`; Parquet zstd, roll interval 60 s |
| Pipelines | `panel_spike_events` / `panel_spike_identities`: `INSERT INTO <sink> SELECT … FROM panel_spike_stream WHERE kind = '<event|identity>'` |
| Generator | Worker `panel-spike-generator` with the stream binding, CPU limit 120 s |
| Token | The existing Doppler `test` secret `R2_TOKEN_VLAUE` worked as the catalog token and for Basin SQL. Doppler has no `R2_SQL_API_TOKEN` in any config, although `scripts/secrets/manifest.ts` lists it for three workers. |

Catalog sinks add an `__ingest_ts` column and take no partitioning option; the
API's sink config for `r2_data_catalog` has only bucket, namespace, table,
token and rolling policy.

## Data

- 200 projects over 150 workspaces, 60 days (2026-08-28 … 2026-10-26).
- **49.67M events and 828k identity links**, sent in 660 generator requests
  (one per day per group of projects, day by day, 16 at a time) in 54 minutes
  with no failed request. Rows land 1 to 2 minutes after the send.
- Project `pnp_spike_0000` (big): 5.0M events, 175k visitors. Project
  `pnp_spike_0001` (small): ~20k events (plus 228 duplicated test events on
  its first day). The other 198: ~227k each.
- Visitors are deterministic per project and visitor: 1–7 sessions over the 60
  days, 1–10 pageviews a session with clicks, page leaves with scroll depth,
  2% rage clicks, 1% errors; 30% identified; 25% sign up, then
  add_to_cart 55%, checkout_started 60%, purchase 65%.
- 585 bytes per event as JSON into the stream; **681 MB on R2** for the whole
  table (about 14 bytes per event). Synthetic values repeat a lot; real URLs,
  titles and properties will compress worse.

## Results

Each query ran three times. Times are wall clock from this laptop (Netherlands)
to the Basin SQL REST API, including the round trip. "Scanned" is the API's
`bytes_scanned` metric for one run; it counts the table once per reference, so
a query that reads the table four times reports four times the bytes.

| Query | Project | min / median / max (ms) | Scanned | Rejections |
|---|---|---|---|---|
| Trends: 30 days, daily events + users by country, top 10 by subquery | big | 1,947 / **6,655** / 8,797 | 443 MB | 0 |
| | small | 1,095 / 1,306 / 2,174 | 101 MB | 0 |
| Trends without the top-10 subquery | big | 1,175 / 1,224 / 1,432 | 315 MB | 0 |
| Web dashboard: sessions, visitors, pageviews, bounce rate, duration (30 days) | big | 1,353 / 2,176 / 2,406 | 302 MB | 0 |
| | small | 994 / 1,049 / 1,704 | 67 MB | 0 |
| Funnel, 4 steps, 7-day window, per-step CTEs | big | 2,507 / 3,654 / 3,724 | 2.3 GB | 0 |
| | small | 1,360 / 1,954 / 2,095 | 462 MB | 0 |
| Same funnel with identity resolution (join on `identities_v1`) | big | 5,420 / **5,835** / 7,565 | 2.6 GB | 0 |
| | small | 2,491 / 3,134 / 3,911 | 532 MB | 0 |
| Retention: weekly cohorts from first signup, 60 days | big | 1,476 / 4,019 / 4,770 | 799 MB | 0 |
| | small | 1,322 / 1,404 / 1,537 | 206 MB | 0 |
| Recordings list: last 7 days, per-session aggregates, top 50 | big | 1,270 / 1,466 / 1,838 | 88 MB | 0 |
| | small | 651 / 1,112 / 1,178 | 17 MB | 0 |
| Breakdown by `json_get_str(properties, 'plan')`, 30 days | big | 1,110 / 2,224 / 2,860 | 444 MB | 0 |
| | small | 607 / 957 / 1,030 | 99 MB | 0 |
| Same breakdown by a typed `plan` column | big | 1,005 / 1,665 / 1,870 | 264 MB | 0 |
| | small | 809 / 822 / 1,194 | 58 MB | 0 |

Pruning checks (`COUNT(*)`, three runs each):

| Filter | Median (ms) | Scanned |
|---|---|---|
| big project, 1 day | 997 | 19 MB |
| big project, 30 days | 1,527 | 208 MB |
| no project filter, 30 days | 1,568 | 11 MB (answered from file statistics) |

What the numbers say:

- **Time filters prune.** One day reads a tenth of 30 days. Files follow
  arrival time, and live events arrive close to their own time, so production
  should prune at least as well as this load did.
- **Project filters don't prune files.** The small project, with 0.4% of the
  big one's events, scans 20–25% as many bytes, and both open the same files.
  The cost of a query follows the platform's total volume in the time range.
- **Every extra reference to the table costs a full scan.** The trends
  subquery, the funnel's step CTEs and the identity join each read the table
  again. Funnels are fine because the first CTE narrows to four event names;
  the identity join adds ~2 s on the big project.
- **JSON properties cost about 1.7× a typed column** in bytes and ~30% in time.
  Acceptable for custom properties; standard fields stay typed.
- Variance is real: the same query ranged up to 4× between runs, probably
  cold versus warm file caches (`cache_hits` in the metrics).

## Cost

Rates (Workers Paid, billing enabled since 2026-08-03): stream ingress free;
SQL transforms $0.04/GB of data a pipeline reads; Iceberg sink $0.06/GB of
uncompressed data delivered (50 GB of each included a month, shared with the
existing analytics pipeline); Basin SQL $2.50/TB scanned, 10 MB minimum per
query; Catalog operations and compaction mostly within the included tier; R2
storage $0.015/GB-month.

Assuming 600 bytes per event into the stream and 40 bytes per event stored
(about 3× the spike's compression, for real-world values):

| Monthly | 50M events | 500M events |
|---|---|---|
| Stream ingress (30 / 300 GB) | $0 | $0 |
| Transforms, one stream per table | $0 (within 50 GB) | ~$10 |
| Transforms, one stream fanned out to 4 tables | ~$3 | ~$45 |
| Iceberg sink | $0 (within 50 GB) | ~$15 |
| R2 storage added each month (2 / 20 GB) | ~$0.03 | ~$0.30 (≈ $7.50/month once 25 months are kept) |
| Basin SQL per uncached report | ~$0.001–0.007 | ~$0.01–0.07 (grows with the whole platform, see above) |

Ingest and storage are cheap at any realistic volume. Query scans are the cost
to watch: cache results (the plan's two minutes, longer for dashboards), and
fix the project mixing before the platform is large.

The spike itself: ~29 GB into the stream, ~58 GB through two pipelines,
~29 GB to the sinks, ~60 queries. Under $1 even if none of it fell in the
included usage.

## Changes to the plan

- **Residency (decided 2026-10-27).** Location hint `weur` for the Basin
  bucket (data stored in Western Europe, no jurisdictional guarantee);
  ClickHouse Cloud EU was turned down. Recordings: EU jurisdiction as planned.
- **One stream, sink and pipeline per table** (`events_v1`, `identities_v1`,
  `people_v1`, `replay_chunks_v1`): 4 of each per environment, 8 in all,
  against the account limit of 20 that the existing analytics pipeline and
  EVT-014's per-module tables also draw on. Ask Cloudflare for a higher limit
  early.
- **Query compiler rules:** read the table once where possible; pick top-N
  breakdown values in panel-api from the first result instead of a subquery;
  join identities only when the project has identified users (a flag the
  PanelProject DO can keep); keep standard fields typed, custom ones in JSON.
- **Project mixing, before it hurts.** Track bytes scanned per query from the
  start. Options when it grows: shard the event table by a hash of the
  project into N streams and tables (needs the higher account limit); move
  big projects to their own table; a periodic job that rewrites recent files
  sorted by project (PyIceberg on Containers, the same engine as the erasure
  job); or ClickHouse.
- **`R2_SQL_API_TOKEN`** is in the secrets manifest for three workers but in
  no Doppler config. WeldPanel needs its own read-only Basin SQL token (Basin
  Catalog accepts read-only tokens since 2026-07); the existing analytics
  reader should be checked too.

## Cleanup

Deleted on 2026-10-27 after the measurements: the Worker
`panel-spike-generator`; pipelines `panel_spike_events` and
`panel_spike_identities`; sinks `panel_spike_events_sink` and
`panel_spike_identities_sink`; stream `panel_spike_stream`; the catalog on
`panel-spike`, its 450 objects and the bucket; the EU-jurisdiction test
bucket `panel-spike-eu` (empty, deleted right after the test). No API tokens
or R2 credentials were created. The generator and the queries are not in the
repo; the SQL above is what ran.

## Not tested

- Compaction (binpack): fewer, larger files, probably faster; does not fix the
  project mixing.
- Concurrent queries and rate limits on Basin SQL.
- Latency from a Worker in Cloudflare instead of a laptop (likely lower).
- A table with real URLs, titles and properties.
