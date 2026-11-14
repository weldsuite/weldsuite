# Alerts

What each alert means and what to check first. Every rule's `runbook_url`
points at its heading here. A cluster operator's own steps (names, addresses,
who to call) belong in that cluster's runbook, not here. Plan and decisions:
[docs/plans/eu-observability.md](../../../../../docs/plans/eu-observability.md),
ADR OPS-021.

**Severity.** `critical` pages at any hour. `warning` is quiet and muted at
night (21:00–06:00 UTC), and arrives in the morning if it still fires.
`info` only shows in Grafana. A critical alert silences the warnings of the
same namespace. Flux's own failures arrive as warnings.

**Where to look.** Grafana at `https://grafana.<domain>`, folder WeldSuite:
"WeldSuite overview" first (is everything OK: hosts, errors, latency,
alerts, Postgres, backups, nodes, failed cron runs), then "WeldSuite jobs
and consumers", "WeldSuite Postgres and backups", "WeldSuite capacity",
"WeldSuite API" and "WeldSuite public endpoints"
(`dashboards/generate.mjs` writes them). Also the Kubernetes dashboards,
the Components folder (CloudNativePG, Traefik, NATS, probes), and Explore
with Loki for logs (`{cluster="<domain>", namespace="weldsuite"}`). Without
Zitadel: `https://grafana.<domain>/login?disableAutoLogin=true` (or, without
the ingress, `kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana
3000:80` and `http://localhost:3000/login?disableAutoLogin=true`) with the
admin login from the Secret `grafana-admin`.

## Receivers

The Secret `monitoring/alerting-receivers` (examples:
`../../secrets/examples/secrets.example.yaml`):

| Key | Gets |
|---|---|
| `critical-url` | `severity: critical`, with `token` as a bearer token |
| `warning-url` | `severity: warning` and Flux's errors, with `token` |
| `heartbeat-url` | the always-firing `Watchdog`, every minute, no token |
| `token` | the bearer token for the first two |

For an ntfy topic, `../scripts/ntfy-receiver-url.mjs <topic URL> <priority>`
prints the URL: ntfy's message template (`tpl=1`) turns Alertmanager's JSON
into a title (`<cluster>: <alertname>`) and one line per alert (its
summary). The topic's access token is `token`. For the heartbeat, a
dead-man's switch such as a healthchecks.io check (period 1 minute, grace 5)
that notifies on its own when the pings stop.

## Testing the alerts

On a test cluster, once, and after changing a receiver:

- `EndpointDown`, `CoreWorkloadDown`: `kubectl -n weldsuite scale deploy/weldsuite --replicas 0`,
  wait 10 minutes, scale back.
- The heartbeat: `kubectl -n monitoring scale statefulset/alertmanager-kube-prometheus-stack-alertmanager --replicas 0`
  (the operator scales it back; patch the Alertmanager's `spec.replicas` to
  hold it), wait 10 minutes.
- A crash loop: a pod in the weldsuite namespace whose command exits.
- Flux: a HelmRelease value its chart's schema refuses, on a test-only branch.
- Routing only, anywhere (production too): `amtool alert add test severity=critical
  --annotation=summary="routing test" --alertmanager.url=http://localhost:9093`
  through `kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093`.

## Platform

### EndpointDown

The blackbox exporter got no 2xx from a public host (app., api., auth.,
sign.) for 3 minutes, going through public DNS, the load balancer, Traefik
and the certificate. `/readyz` also fails when the server can't reach
Postgres or NATS.

- Which host? All of them: the load balancer, Traefik or DNS
  (`kubectl -n traefik get pods`, the Hetzner console's load balancer
  health). One: that service (`CoreWorkloadDown` usually fires too).
- auth. down means nobody can sign in: Zitadel's pods and its database
  (`zitadel-db`).
- A certificate error shows as a failed probe too: `kubectl get certificates -A`.

### SiteDown

A site probe (`group: site`, e.g. the marketing site) failed for 5 minutes.
Same checks as EndpointDown, for that site's namespace.

### ApiErrorRate

More than 5% of a service's requests (Traefik's counts, per backend service)
answered 5xx for 5 minutes, at more than 6 requests a minute.

- Which service: the alert's `service` label (`<namespace>-<service>-<port>`).
- Logs: Explore, `{namespace="weldsuite"} | json | level=~"ERROR|error"`.
- Which route: the "WeldSuite API" dashboard and `ApiRouteErrors`.
- Just deployed? Roll back by pinning the previous chart (cluster runbook).

### ApiRouteErrors

One route answers more than 10% 5xx for 10 minutes (the server's own
metrics). Usually a bug or a failing dependency of that route; the logs of
that route tell which.

### ApiLatencyHigh

The API's p95 latency is over a second for 10 minutes. Check the database
pools (`DatabasePoolExhausted`), Postgres (CPU on the pg nodes, slow
queries), and the busiest routes on "WeldSuite API".

### DatabasePoolExhausted

A server pod uses 95% or more of a connection pool for 10 minutes: requests
queue for a connection. Look for slow or stuck queries
(`pg_stat_activity` through `kubectl cnpg psql`), and for
`PostgresConnectionsNearLimit`.

### CoreWorkloadDown

A Deployment or StatefulSet in weldsuite, zitadel, traefik or postgres (the
poolers) has had fewer ready replicas than it wants for 10 minutes.

- `kubectl -n <namespace> get pods`, then `describe` and `logs --previous`
  of the ones not ready: crash loop, image pull, scheduling (resources,
  taints), failing readiness.
- Pending for lack of room: `kubectl top nodes`; a node down
  (`NodeNotReady`).

### WorkloadDegraded

The same, for the supporting namespaces (CloudNativePG's operator,
cert-manager, monitoring, logging, the marketing site, LiveKit), after 15
minutes. Not an outage by itself; fix in the day.

### ContainerOOMKilled

A container was killed for using more memory than its limit. Once may be a
spike; again and again means the limit is too low for the load or there is
a leak: raise the limit in the cluster's layers, and look at the memory
graph of the pod.

### MemoryNearLimit

A container has used more than 90% of its memory limit for 15 minutes. It is
likely to be OOM-killed next.

### ConsumerLagGrowing

A JetStream consumer's pending count has grown for 15 minutes and is above
100: `weldsuite consume` falls behind (audit log, search index, webhooks,
workflows run late). Check the consume pods (`kubectl -n weldsuite get pods
-l app.kubernetes.io/component=consume`), their logs, and
`ConsumerErrors`.

### ConsumerErrors

A consumer fails more than 10% of its messages for 15 minutes. Its logs say
why; failed messages are redelivered, so a persistent failure also shows as
growing lag.

## Postgres

### PostgresInstanceDown

A CloudNativePG instance has not been ready for 2 minutes: the platform's
clusters (namespace `postgres`) or Zitadel's (`zitadel-db`, namespace
`zitadel`; down, nobody can sign in). The clusters require a synchronous
replica (`dataDurability: required`), so a two-instance cluster accepts no
writes while either instance is down.

- `kubectl -n postgres get pods`, `kubectl cnpg status <cluster> -n postgres`
  (`-n zitadel` for `zitadel-db`).
- A node down (`NodeNotReady`) takes its instance with it: the instance's
  volume is on that node, so it comes back with the node.
- A full disk (`DiskFillingUp`) stops Postgres.

### PostgresWalArchivingFailing

The last WAL archive attempt failed after the last success, for 10 minutes.
Point-in-time recovery stops at the last archived segment, and WAL piles up
on the instance's disk. Check the backup bucket's credentials
(`postgres-backup-s3`), the object store's status, and the instance's logs
(`barman-cloud-wal-archive`).

### PostgresWalArchivingStale

Nothing archived for over an hour on a primary. With any writes, a segment
is archived at least every 5 minutes (`archive_timeout`). Either the
database is idle, or archiving stopped without failing; check as above.

### PostgresBackupStale

The newest base backup is more than 26 hours old: last night's backup
failed. `kubectl -n postgres get backups`, the ScheduledBackup, and the
plugin's logs. Run one by hand once the cause is fixed (`kubectl cnpg
backup <cluster> -n postgres`).

### PostgresBackupMetricsMissing

No instance reports a backup timestamp, so `PostgresBackupStale` can't fire.
Usually the barman-cloud plugin's metrics changed name: check what the
instances export (`/metrics` on port 9187) and fix the rule.

### PostgresReplicationLag

A replica is more than a minute behind. With a synchronous replica this
mostly means the replica's node is overloaded or its disk is slow.

### PostgresConnectionsNearLimit

An instance uses more than 80% of `max_connections`. The poolers should
keep the count low: look for clients that connect around them, and for
pool sizes that grew.

## Nodes

### NodeNotReady

A node has been NotReady for 5 minutes. With three workload nodes, one more
is an outage. `kubectl describe node`, `talosctl -n <private address>
dmesg` / `services` through the API load balancer, and the Hetzner console
(server status, network).

### DiskFillingUp

A node's disk (per device: Talos's `/var`, where Postgres, Prometheus, NATS
and Valkey keep their data) is above 90% used, or at the current rate will be
full within a day. Find what grows: `kubectl get pvc -A` and the volumes
under `/var/mnt/local-storage` (`talosctl -n <node> usage
/var/mnt/local-storage`), container logs, images. Postgres WAL that isn't
archived (`PostgresWalArchivingFailing`) grows without bound.

### DiskUsageHigh

A node's disk is above 80% used for 30 minutes. Plan room before it
becomes `DiskFillingUp`; "WeldSuite capacity" shows which node and what
grows.

## Certificates

### CertificateExpiring

A certificate expires within 7 days (cert-manager's view, or what a probed
host actually serves). cert-manager renews 30 days ahead, so renewals have
been failing for three weeks. `kubectl describe certificate`, its
CertificateRequest and Order, and cert-manager's logs; usually DNS or the
HTTP-01 path through Traefik.

### CertificateRenewalLate

A certificate expires within 21 days and hasn't renewed. Same checks as
above, without the hurry.

### CertificateNotReady

A Certificate has not been Ready for 30 minutes: a new host's DNS doesn't
resolve yet, or issuance fails.

## Logs

### LogPipelineDropping

Fluent Bit is dropping records or giving up on retries: logs are missing
from Loki. Check Loki first (`LokiRejectingWrites`, its pod, the bucket),
then the Fluent Bit pod named in the alert.

### LokiRejectingWrites

Loki discards lines (rate or size limits, too-old timestamps) or answers
pushes with 5xx. Its logs say which; limits are in
`../logging/values/loki.yaml`.

## From kube-prometheus-stack

The chart's own rules also apply, trimmed (`../monitoring/values/kube-prometheus-stack.yaml`):
among them `KubeJobFailed` (a cron run failed), `KubePodCrashLooping`,
`KubePersistentVolumeFillingUp`, `NodeMemoryHighUtilization`,
`TargetDown`, `PrometheusRuleFailures` and `AlertmanagerFailedToSendAlerts`,
and once etcd is scraped, `etcdNoLeader` and `etcdMembersDown` (critical).
Their runbooks: <https://runbooks.prometheus-operator.dev/>.
