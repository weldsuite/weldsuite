# Alerts, monitoring and logging on the EU clusters

Status: built, not yet running (2026-11-12). Layers, Talos config and docs:
weldsuite/weldsuite#1552; test cluster weldsuite-deploy#16, production
weldsuite-deploy#17 (draft, after the week on test). The Rust server's
`/metrics` and the request-span fix follow in their own PR. Item 5.5 of the editions plan ("Observability")
in `weldsuite-documentation` (`design/platform/editions-and-self-hosting-phases.md`).
Decision record: ADR OPS-021 (Proposed). Built on the test cluster first,
then production.

Decided (2026-11-12):

- **Each cluster monitors itself.** The test cluster and production
  (`weldsuite-eu`) each run their own metrics, logs, Grafana and alerting,
  from the same Flux layers. No separate ops server.
- **One outside check** watches each cluster from outside: a dead-man's
  switch at healthchecks.io. A dead cluster, a dead Prometheus or a cut
  network stops its heartbeat, and healthchecks.io raises the alarm.
- **Alerts go to the operator's phone through ntfy** (ntfy.sh, private
  topics). Critical alerts are urgent pushes, warnings quiet ones, the test
  cluster's alerts the quietest.
- **Logs are kept 30 days on production**, 7 on test. They hold IP
  addresses, email addresses and user ids, so 30 days is the GDPR retention.
- **App metrics now, traces later.** The Rust server gets a Prometheus
  endpoint in this round. It already exports traces over OTLP; a trace store
  comes in a later round.
- **Grafana behind Zitadel.** `grafana.${DOMAIN}` signs in with the WeldSuite
  Staff org (MFA), like the admin console. No IP allowlist.
- **No public status page yet.** It comes once there are EU customers.

Out of scope: Global on Cloudflare (Workers observability stays as it is).
Global on GKE (OPS-015) would take the same layers when it comes.

## Where we are

- **Test cluster:** a small Prometheus for Lens's charts
  (`rust/deploy/flux/infrastructure/monitoring`, kube-prometheus-stack
  92.3.1): kubelet, node exporter and kube-state-metrics, kept 3 days. No
  alert rules, no Alertmanager, no Grafana.
- **Production:** metrics-server only (for the autoscaler). Nothing alerts.
- **Logs:** the Rust server writes JSON to stdout
  (`rust/bins/weldsuite/src/telemetry.rs`); the other services log in their
  own formats. Logs are only readable with `kubectl logs` and are gone when a
  pod is replaced.
- **Health:** every role answers `/livez`, `/readyz` and `/health`; the
  probes in the chart use them. Nothing checks them from outside.
- **App metrics:** none. The design doc says "Prometheus metrics" but the
  server has no `/metrics` endpoint.
- **Traces:** exported over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set;
  nothing receives them.
- **Request logging:** the HTTP span records the full request URI
  (`DefaultMakeSpan` in `rust/bins/weldsuite/src/server.rs`), query string
  included. Sign links, invite links and OAuth callbacks carry tokens in the
  query string, so once logs are stored, those tokens are stored with them.
- **Production headroom (2026-11-12):** the three control-plane nodes use
  2.2–2.9 GB of 7.1 GB memory and 8–34% CPU; memory requests are 20–56% of
  allocatable. The Postgres nodes are tainted and stay out of this.

## What each cluster runs

```
           ┌────────────────────────── cluster ──────────────────────────┐
 targets → │ Prometheus ── rules ──> Alertmanager ──> ntfy bridge ──────────> ntfy.sh ──> phone
           │     ▲                        │                               │
           │ blackbox probes              └── Watchdog every minute ────────> healthchecks.io
           │ (app., api., auth., sign.          (stops = cluster or        │      │ no ping 5 min
           │  through the public LB)             monitoring is gone)       │      └──────> ntfy.sh
           │                                                              │
 pod logs, │ Fluent Bit (every node) ──> Loki ──> S3 bucket (30 days)     │
 events,   │                                                              │
 Talos     │ Grafana (grafana.${DOMAIN}, Zitadel Staff sign-in):          │
           │   Prometheus + Loki + Alertmanager                           │
           └──────────────────────────────────────────────────────────────┘
```

### Metrics

kube-prometheus-stack, as today, grown into the full stack:

- **Prometheus**, one replica, 30 s scrape. Production keeps 30 days
  (`retentionSize` as the cap), test 7. Volume on `openebs-hostpath`. Every
  series carries `cluster` (`weldsuite-eu`, `weldsuite-eu-test`) as an
  external label, so a message always names its cluster.
- **What it scrapes** (ServiceMonitors and PodMonitors, all in the
  monitoring layer, see "Layer order" below):
  - kubelet / cAdvisor, node exporter, kube-state-metrics (today's set);
  - CloudNativePG: each instance's exporter (port 9187, with CNPG's default
    queries: replication, WAL archiving, connections), and the operator;
  - Traefik: requests, errors and latency per router (so per host) from day
    one, before the server has its own metrics;
  - cert-manager: certificate expiry;
  - Flux: controller metrics for the dashboard (alerts come from Flux
    events, below);
  - NATS (JetStream exporter: streams, consumer pending), Valkey, Restate
    (`:5122/metrics`), Zitadel (`/debug/metrics`), LiveKit on test;
  - the weldsuite roles' new `/metrics` (phase 2);
  - etcd on the three control-plane nodes (phase 2: Talos binds its metrics
    to localhost today).
- **Blackbox exporter** probes `https://app.`, `api.`, `auth.` and `sign.`
  `${DOMAIN}` (and the marketing hosts) every 30 s. It resolves the public
  names and goes through the Hetzner load balancer, so it tests DNS, the load
  balancer, Traefik, the certificate and the app together. It does not see
  the cluster from another network; the dead-man's switch covers that case.
- Not scraped: the API server, controller manager, scheduler and kube-proxy
  (Talos binds them to localhost; their series would be most of the cost).

### Alerts

- **Rules are code.** PrometheusRule objects in the monitoring layer, from
  kube-prometheus-stack's default rules (trimmed, below) and WeldSuite's own
  (`rules/`). Grafana's own alerting stays off: one alert path.
- **Alertmanager**, one replica. Routes by `severity`:

  | Severity | Production | Test |
  |---|---|---|
  | `critical` | ntfy, urgent priority, any hour | ntfy test topic, low priority |
  | `warning` | ntfy, default priority; muted 22:00–07:00 Europe/Amsterdam and sent in the morning if still firing | ntfy test topic, low priority |
  | `info` | Grafana only | Grafana only |
  | `Watchdog` | healthchecks.io ping, every minute | the same, test's own check |

  A critical alert inhibits the warnings of the same target. Silences for
  planned work are set in Grafana or with `amtool`.
- **ntfy delivery, no bridge.** ntfy (2.10+) applies a message template from
  the URL (`tpl=1`) to Alertmanager's webhook JSON: a title
  (`<cluster>: <alertname>`), one line per alert (its summary) and a fixed
  priority per receiver URL. `rust/deploy/flux/scripts/ntfy-receiver-url.mjs`
  prints the URL. Messages carry the alert name, the cluster, the object
  (namespace, pod, database, host) and the summary, never log lines or
  user data.
- **The base layer is vendor-neutral.** It defines three receivers by role
  (`critical`, `warning`, `heartbeat`) whose URLs and tokens come from the
  cluster's Secret `alerting-receivers`. ntfy and healthchecks.io are
  production's and test's choice in weldsuite-deploy; a self-hosted install
  can point the same receivers at its own webhook, ntfy or Slack.
- **Flux failures** reach Alertmanager from Flux itself: a notification
  `Provider` of type `alertmanager` and an `Alert` for error events of the
  Kustomizations, HelmReleases and sources. They arrive as `warning`.
- **Every rule has a `runbook_url`**: a public page next to the rules
  (`rust/deploy/flux/infrastructure/monitoring/ALERTS.md`: what it means,
  first checks) for every install, and production's own steps in
  weldsuite-deploy `eu/runbooks/PRODUCTION.md`, "Alerts".

### The first rule set

Critical (wakes the operator on production):

| Alert | Fires when | Why |
|---|---|---|
| Heartbeat missing (healthchecks.io) | no Watchdog ping for 5 min | the cluster, its network or its monitoring is gone |
| `EndpointDown` | a probe of app., api., auth. or sign. fails for 3 min | customers can't use it, or can't sign in (auth.) |
| `ApiErrorRate` | 5xx above 5% of requests for 5 min (Traefik's per-router counts until phase 2, then the server's) | broken while still "up" |
| `PostgresInstanceDown` | any CNPG instance not ready for 2 min (from kube-state-metrics, so it fires when the instance can't be scraped) | the clusters set `dataDurability: required`, so commits wait for a replica: either instance of a two-instance cluster down stops writes |
| `PostgresWalArchivingFailing` | WAL archiving fails, or nothing archived for 15 min while there are writes | point-in-time recovery is broken from here on |
| `PostgresBackupStale` | last successful base backup older than 26 h | the nightly backup failed |
| `DiskFillingUp` | a node filesystem or PVC is predicted full within 24 h, or below 10% free | Postgres and Prometheus stop when full |
| `NodeNotReady` | a node is NotReady for 5 min | with three workload nodes, one more is an outage |
| `CertificateExpiring` | a certificate expires within 7 days | renewal has been failing for three weeks |
| `CoreWorkloadDown` | a Deployment or StatefulSet in weldsuite, zitadel, nats, restate, valkey or traefik has fewer ready replicas than wanted for 10 min, or a pod there crash-loops | the platform is degraded |
| `etcdNoLeader` / `etcdMembersDown` | kube-prometheus-stack's etcd rules, on once etcd is scraped | the control plane is losing quorum |

Warning (quiet push, daytime):

| Alert | Fires when |
|---|---|
| Flux reconcile failed | a Kustomization, HelmRelease or source reports an error (Flux events) |
| `CertificateRenewalLate` | a certificate expires within 21 days |
| `DiskUsageHigh` | a filesystem or PVC above 80% |
| `MemoryNearLimit` / `OOMKilled` | a container above 90% of its memory limit for 15 min, or killed for memory |
| `NodeMemoryHighUtilization` | node memory above 90% for 15 min (kube-prometheus-stack's rule) |
| `KubeJobFailed` | a CronJob run failed (kube-prometheus-stack's rule) |
| `ConsumerLagGrowing` | a JetStream consumer's pending count grows for 15 min (`weldsuite consume` falls behind) |
| `ApiLatencyHigh` | p95 above 1 s for 10 min (phase 2) |
| `PostgresReplicationLag` | replica lag above 60 s for 5 min |
| `SiteDown` | a probe of a cluster's own sites (www., weldsuite.nl) fails for 5 min |
| `LogPipelineDropping` / `LokiRejectingWrites` | Fluent Bit drops records, or Loki discards lines or fails pushes, for 15 min |
| `PostgresBackupMetricsMissing` | no instance reports a backup timestamp, so backup age isn't watched |
| Monitoring self-checks | kube-prometheus-stack's Prometheus and Alertmanager rules (failed rule evaluation, failed notifications) |

Dropped from the defaults: the controller manager, scheduler, kube-proxy and
etcd groups until those are scraped, `CPUThrottlingHigh` (noise on small
nodes), and the overcommit alerts as `info` (production's limits are
overcommitted on purpose).

### Logs

- **Fluent Bit**, a DaemonSet on every node (it tolerates the Postgres
  taint). Inputs:
  - container logs from `/var/log/pods`;
  - Kubernetes events, from one Fluent Bit pod of their own (from every
    node each event would arrive five times), kept as log lines so "why did
    that pod restart" has an answer after the event expires;
  - Talos's own logs (kubelet, etcd, machined, kernel), sent by Talos to the
    Fluent Bit on the same node (`machine.logging.destinations`, JSON lines
    to 127.0.0.1). This is a machine-config change, so it comes in phase 2
    with the etcd metrics.
- **Loki**, single binary, one replica, chunks in an S3 bucket per cluster
  (Hetzner Object Storage, next to the cluster), a small local volume for
  its write-ahead log. The compactor deletes after 30 days on production and
  7 on test; a lifecycle rule on the bucket deletes after one more day as a
  backstop.
- **Labels stay few:** `cluster`, `namespace`, `app`, `container`, `node`,
  `level`. Workspace id, request id, trace id and user id stay in the line
  (or Loki's structured metadata), so they are searchable without making
  every stream unique.
- **Dropped before storage:** `/livez` and `/readyz` probe lines, debug
  level.
- **Traefik access logs stay off.** They would store every client IP and
  full URL, tokens included. Traefik's metrics cover request rates and
  errors.
- **Who reads them:** staff, through Grafana. Logs are personal data under
  the GDPR: 30 days, access through the Staff org with MFA, and an entry in
  the processing register.

### Grafana

- Part of kube-prometheus-stack. Data sources: Prometheus, Loki,
  Alertmanager. No database of its own worth keeping: dashboards are JSON in
  the monitoring layer (ConfigMaps the sidecar loads), data sources are
  provisioned.
- **Sign-in:** Zitadel OIDC against `auth.${DOMAIN}`, limited to the
  WeldSuite Staff org (its primary-domain scope, `ZITADEL_STAFF_ORG_DOMAIN`), roles from the project's role claim:
  `grafana-admin` → Admin, anyone else in the Staff org → Viewer, nobody else
  in. Login form and basic auth off.
- **Break-glass:** when Zitadel itself is down, the admin login from the
  cluster's SOPS secret at `/login?disableAutoLogin=true` (everyone else is
  sent to Zitadel; the form holds no other accounts).
- **Dashboards to start:** cluster and nodes, workloads, CloudNativePG,
  Traefik (per host), NATS JetStream, Flux, Loki and Fluent Bit, and
  "WeldSuite API" (requests, errors and latency per route, from phase 2).

### App metrics (the Rust server)

- `/metrics` on its own port (not the API port, never behind the ingress),
  on `serve`, `consume`, the sign portal and the MTA. The chart gets a
  `metrics` port on each Service, a ServiceMonitor template
  (`metrics.serviceMonitor.enabled`, default off; the base layer turns it
  on), and, for installs that turn `networkPolicy.enabled` on, a rule that
  lets the monitoring namespace in.
- Series to start:
  - HTTP: requests by method, **route template** (axum's `MatchedPath`, never
    the raw path) and status class; a latency histogram by route; in-flight
    requests;
  - database pools: size, idle, waiting, acquire time;
  - NATS: published and consumed messages, failures and redeliveries per
    stream;
  - jobs: runs and failures per cron job and per consumer;
  - outbound calls (Mistral, Mollie, S3, SMTP): count, errors, latency per
    service.
- No workspace, user or tenant id as a label (cardinality, and personal
  data). A per-workspace view is a log query, not a metric.
- The `metrics` crate with its Prometheus exporter. Not an API route, so no
  conformance suite change.

## Where the pieces live

| What | Repo, path |
|---|---|
| Layers, chart values, rules, dashboards, `ALERTS.md`, the secret examples | weldsuite/weldsuite `rust/deploy/flux/infrastructure/monitoring` (grows), `…/monitoring-config` (new: monitors, probes, rules, dashboards) and `…/logging` (new); the `monitoring` and `logging` namespaces in `…/controllers`, since the secrets layer fills them first; `rust/deploy/flux/secrets/examples/secrets.example.yaml`; chart pins in `rust/deploy/validate.sh` |
| `/metrics`, the request-span fix, the ServiceMonitor template | weldsuite/weldsuite `rust/bins/weldsuite`, `rust/deploy/helm/weldsuite` |
| Talos log destinations, etcd metrics address | weldsuite/weldsuite `rust/deploy/hetzner/talos` |
| Which cluster runs which layer, retention and size patches, cluster label | weldsuite-deploy `eu/clusters/{test,eu}/layers.yaml`, `cluster-settings.yaml` |
| ntfy topics and token, healthchecks.io ping URLs, Grafana's OIDC client secret and admin password, Loki's S3 keys | weldsuite-deploy `eu/secrets/{test,eu}` (SOPS) |
| What to do per alert on production | weldsuite-deploy `eu/runbooks/PRODUCTION.md`, "Alerts" |

**Layer order.** The ServiceMonitors and PodMonitors need the Prometheus
Operator's CRDs, which come with the monitoring layer, and the monitoring
layer comes after controllers. So every monitor lives in the monitoring layer
and selects its targets in their own namespaces; the other layers only open
the metrics ports in their charts' values (no CRDs needed). `logging` depends
on `monitoring` (its own monitors) and on `secrets` (the S3 keys). The drill
leaves both out.

Every new chart and image (Loki, Fluent Bit, the blackbox exporter, the ntfy
bridge) is pinned to a release at least two weeks old, in `validate.sh` too.

## Sizing

Memory requests on production, roughly (limits about double):

| Component | Requests |
|---|---|
| Prometheus (30 days, 30 Gi volume) | 500m CPU, 1.5 Gi |
| Alertmanager, ntfy bridge, blackbox exporter | 0.15 Gi |
| Grafana | 0.2 Gi |
| Operator, kube-state-metrics, node exporters (×5) | 0.4 Gi |
| Loki (10 Gi local volume) | 250m CPU, 0.5 Gi |
| Fluent Bit (×5) | 0.3 Gi |
| **Total** | **≈ 1.3 CPU, 3 Gi** |

That takes the control-plane nodes from about 37% to about 50% of
allocatable memory in requests. Test takes 7 days and smaller volumes;
check its headroom (`kubectl top nodes`) before phase 1, since its workers
are CX23s.

Running cost: no servers. ntfy.sh's paid tier for reserved topics and a token
(a few euros a month); healthchecks.io's free tier (two checks); the log
buckets fall inside the Object Storage already paid for.

## Phases

### Phase 0: accounts and secrets (the operator)

1. ntfy.sh account on a paid tier; reserve three topics (production
   critical, production warning, test), make an access token for the bridge,
   subscribe the phone app. Test a push.
2. healthchecks.io account; two checks (`weldsuite-eu`, `weldsuite-eu-test`),
   period 1 min, grace 5 min, notifying the production critical topic
   (test's check at low priority) through its ntfy integration.
3. Zitadel, per cluster: an OIDC web app "Grafana" in the WeldSuite Staff project (next to the
   admin console's app)
   (redirect `https://grafana.${DOMAIN}/login/generic_oauth`), the project
   role `grafana-admin`, granted to the operator in the Staff org. Can be
   scripted with the `weldsuite-api` PAT; the operator runs it for production.
4. Object Storage: a logs bucket per cluster (`weldsuite-eu-test-logs`,
   `weldsuite-eu-logs`), a key pair limited to it, the lifecycle rule. New
   keys are refused object writes for about an hour (OPS-019): make them
   before the layer goes in.
5. DNS: `grafana.test.weldsuite.eu` and `grafana.weldsuite.eu` to the
   ingress load balancer.
6. The values into `eu/secrets/{test,eu}` (SOPS), as the updated
   `secrets.example.yaml` lists them.

### Phase 1: the test cluster

1. Monitoring layer: Alertmanager, Grafana with its ingress and Zitadel
   sign-in, the trimmed default rules, the WeldSuite rules that phase 1 can
   feed (everything but the app-metric and etcd ones), the monitors, the
   blackbox exporter and its probes, the ntfy bridge, the Flux provider and
   alert, the dashboards, `ALERTS.md`. Production-shaped defaults (30 days,
   one replica); test patches them down in its layers.
2. Logging layer: Loki on S3 and Fluent Bit (pods and events).
3. weldsuite-deploy: test's monitoring layer gets `postBuild` substitution
   and the retention patches; the logging layer joins test's layers.
4. **Fire every alert once on purpose**, and see the push arrive:
   scale weldsuite to zero (`EndpointDown`, `CoreWorkloadDown`), a pod that
   crash-loops, a temporary low threshold for disk and backups, a bad value
   in a test-only HelmRelease (Flux), Alertmanager scaled to zero for ten
   minutes (heartbeat).
5. **A week of living with it.** Every alert that fired either needed doing
   something, or its rule changes. Note what Prometheus and Loki use, and set
   production's sizes from it.

Done when: every critical alert has fired on test and reached the phone,
the heartbeat alarm works, Grafana lets a Staff account in and refuses any
other, a request can be followed through Loki by its request id, and the
week passed with no alert that nobody acted on.

### Phase 2: the server and the nodes (code, through main like any change)

1. `/metrics` in the Rust server (above), the chart's metrics port,
   ServiceMonitor and NetworkPolicy rule. The "WeldSuite API" dashboard.
   `ApiErrorRate` moves from Traefik's counts to the server's, and
   `ApiLatencyHigh`, `ConsumerLagGrowing` (if not already from NATS) and
   `CronJobFailed` per job come in.
2. **Request-span fix:** the HTTP span records the route template and the
   path without its query string, never the raw URI. A test checks that a
   token in a query string doesn't reach the log output. This is a gate for
   production's logs.
3. Talos: `machine.logging.destinations` to the node's Fluent Bit, etcd's
   metrics listener on the node's private address, both in
   `rust/deploy/hetzner/talos`. Test first; production's apply is the
   operator's (`tofu apply` in a terminal, OPS-019 runbook). Then the etcd
   rules and dashboard.

### Phase 3: production

1. Size patches from what test measured; production's ntfy topics and
   heartbeat in its secrets.
2. weldsuite-deploy: add the `monitoring` and `logging` layers to
   `eu/clusters/eu/layers.yaml`. Production takes the base layers from the
   main build it runs (OPS-020), so phases 1 and 2 must be in that build.
3. Check, without breaking anything: a synthetic alert per severity through
   `amtool` (routing and priority), Alertmanager scaled to zero for ten
   minutes (heartbeat), a Grafana sign-in.
4. `eu/runbooks/PRODUCTION.md`, "Alerts": per critical alert, what to check
   and what to do on this cluster.
5. Accept ADR OPS-021; update the editions design doc and item 5.5.

Done when: production has run a week with alerts on, each critical alert
has a runbook entry, and nothing fired that nobody acted on.

### Later

- **Traces:** Tempo with S3 storage and an OpenTelemetry Collector;
  `OTEL_EXPORTER_OTLP_ENDPOINT` in the chart's values; trace ids in the logs
  link to the trace in Grafana.
- **Alerts from logs:** Loki's ruler for patterns metrics don't show
  (panics, repeated auth failures, mail rejections).
- **An outside prober and the public status page** (5.5's EU-hosted status
  page), when there are EU customers: probes from another network, and a
  page fed by them. The always-on EU machine of item 5.6 (the drill runner)
  is the natural home, together with a self-hosted ntfy, which then replaces
  ntfy.sh.
- **SLOs** per endpoint (availability, latency) with error-budget alerts
  instead of fixed thresholds.
- **Longer metric history** (VictoriaMetrics or Thanos on S3) if 30 days
  turns out too short for capacity planning.
- **Mail:** queue and delivery alerts once the MTA and Haraka run on
  production.

## Risks

- **ntfy.sh's hosting location isn't stated as EU.** The messages hold only
  alert names, clusters and object names, no personal data. The plan moves
  to a self-hosted ntfy on the 5.6 machine later.
- **One Prometheus on a node-local volume.** If its node dies, Prometheus
  waits for the node (its volume is there) and the heartbeat stops, so the
  operator hears of it. History on that node is lost if the node is.
- **Grafana depends on Zitadel.** The break-glass path is the admin
  login at `/login?disableAutoLogin=true`, or `kubectl port-forward` without
  the ingress, and the API addresses are limited to
  `admin_cidrs`, which go stale with the operator's dynamic address.
- **Self-monitoring shares the cluster's fate.** Covered by the heartbeat,
  not by a second monitoring system.
- **Noise.** A solo operator stops reading a noisy channel. The week on test
  and the "nothing nobody acted on" exit criterion are there for that.
