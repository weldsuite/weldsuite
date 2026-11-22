# Alerts

What each alert means and what to check first. Every rule's `runbook_url`
points at its heading here. A cluster operator's own steps (names, addresses,
who to call) belong in that cluster's runbook, not here. Plan and decisions:
[weldsuite-documentation/plans/eu-observability.md](https://github.com/weldsuite/weldsuite-documentation/blob/main/plans/eu-observability.md),
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

The Secret `monitoring/alerting-receivers`, from the store's
`weldsuite/alerting` (`../../secrets/monitoring`,
`../../secrets/store.example.yaml`):

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
- `SecretStoreDown`: `systemctl restart openbao` on the test cluster's store
  (it comes back sealed), wait 15 minutes, unseal. The snapshot check:
  healthchecks.io's test notification on the check's ntfy integration, and
  `systemctl start bao-snapshot` on the store shows up as a ping in the
  check's log.
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
  (`zitadel-db`), or on a cluster that signs in with WeldID, WeldID's
  (`WeldIDDown`, `weldid-db`; its probe path is `AUTH_PROBE_PATH`).
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

### TraefikRateLimiting

Traefik's own rate limits (`../controllers/values/traefik.yaml`) refused more
than one request a second for 10 minutes. The limits count per client
address (an IPv6 /64): every request, the sign-in host and the platform's
`/api/sign-in` each have their own.

- Who: the Traefik dashboard in the Components folder (429s by entry point
  and service). Traefik keeps no access log, so nothing names the address;
  the Hetzner console's load balancer graphs show a flood's size.
- A flood from a few addresses: the limits are doing their job. One from
  many addresses gets through them and needs a scrubbing proxy in front
  (Hetzner runbook, "Rate limits").
- Customers refused (a support ticket, an office behind one NAT address):
  raise that middleware's `average` and `burst`, or `amount` for open
  requests.

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
clusters (namespace `postgres`), Zitadel's (`zitadel-db`, namespace
`zitadel`; down, nobody can sign in) or WeldID's (`weldid-db`, namespace
`weldid`, the rule in `../weldid/monitoring.yaml`). The clusters require a
synchronous replica (`dataDurability: required`), so a two-instance
cluster accepts no writes while either instance is down.

- `kubectl -n postgres get pods`, `kubectl cnpg status <cluster> -n postgres`
  (`-n zitadel` for `zitadel-db`, `-n weldid` for `weldid-db`).
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

## Secret store

### SecretStoreDown

The cluster's secret store (`rust/deploy/hetzner/secret-store`, ADR
OPS-023) has answered its health check (`SECRET_STORE_URL`/v1/sys/health)
with something other than 200 for 10 minutes. The cluster keeps every Secret
it has; External Secrets refreshes nothing, and new or changed values wait.
A warning: it waits for the morning. The HTTP code in the summary says
which:

- 503, sealed: OpenBao restarted (a reboot, Hetzner maintenance, a crash).
  Unseal it with two keys (the store's README, "Reboots and unsealing").
- 0, no answer: the server (Hetzner console), Caddy (`systemctl status
  caddy`), its DNS name, or the cluster's way out.
- 501, not initialised: a new or rebuilt server; README, "First start" or
  "Restore".
- 429, standby: OpenBao won't become active; `journalctl -u openbao` (an
  audit device changed in `openbao.hcl`, README, "Upgrades").

Probed only while the cluster's `SECRET_STORE_URL` is set. Its daily
snapshot isn't watched from here: a failed one is the healthchecks.io check
pinged by the store itself (`SNAPSHOT_PING_URL`, README, "Backups"), which
notifies on its own.

## Offsite copy

Only on a cluster that runs the offsite copy (`../offsite-copy`, opt-in;
the rule is `rules/offsite-copy.yaml`).

### OffsiteCopyStale

No run of the CronJob `offsite-copy/offsite-copy` has succeeded for 26
hours (or, for a new one, it has never succeeded and is older than that).
A run succeeds only when every bucket in `OFFSITE_SOURCE_BUCKETS` was
copied, so the copy at the second provider is at least a day behind the
cluster's own object storage. Nothing is lost yet: the source holds
everything. A warning.

- `kubectl -n offsite-copy get cronjob,jobs,pods`, then the last run's log
  (`kubectl -n offsite-copy logs job/<name>`, or `{namespace="offsite-copy"}`
  in Explore once its Job is gone). It names the bucket that failed (`not
  copied: …`) and rclone's error above it.
- An access error (403, `InvalidAccessKeyId`, `SignatureDoesNotMatch`): a
  key in `offsite-copy-s3` (the store's `weldsuite/offsite-copy`) expired,
  was rotated or lost a right, or a region setting is wrong
  (`OFFSITE_SOURCE_S3_REGION`, `OFFSITE_S3_REGION`). `NoSuchBucket`: a
  bucket in the settings doesn't exist (renamed, or `OFFSITE_BUCKET` never
  made at the destination).
- A quota or storage-full error at the destination: the copy only grows in
  copy mode; check its lifecycle rules (`rust/deploy/hetzner/README.md`,
  "Offsite copy").
- No run at all: the CronJob is suspended, or a run is still going
  (`concurrencyPolicy: Forbid`). A first copy of large buckets can take
  more than a day; one that hangs (no rclone stats line for an hour) can be
  deleted, and the next run carries on where it stopped.
- Once fixed, run it now instead of waiting for the schedule:
  `kubectl -n offsite-copy create job --from=cronjob/offsite-copy
  offsite-copy-manual`.

## Network policy

Only on a cluster that runs the network-policy layer (`../network-policy`,
opt-in; the rule is `rules/network-policy.yaml`).

### NetworkPolicyEnforcementDegraded

`kube-router` or `metadata-guard` (DaemonSets in kube-system, one pod per
node) has had a node without a ready pod for 10 minutes. Without
kube-router, that node's pods are held to stale rules, and new pods to none.
Without the guard, a new pod on it can reach the metadata service, and so the
node's Talos machine configuration, in its first second. A warning; fix it
in the day.

- `kubectl -n kube-system get ds kube-router metadata-guard` and `get pods
  -o wide -l app.kubernetes.io/name=<name>`: which node, and why (Pending:
  a taint or no room; not ready; crash loop).
- The guard's log says why it isn't ready: `can't read FLANNEL_NETWORK`
  (Flannel hasn't started on that node, or its `subnet.env` moved) or
  `can't insert the rule` (iptables' error). Its readiness probe fails while
  the rule is missing.
- kube-router's log (`kubectl -n kube-system logs <pod>`): a sync that keeps
  failing restarts it (`KubePodCrashLooping` too).

## WeldID

Only on a cluster that runs WeldID (`../weldid`, opt-in; the rules are in
`../weldid/monitoring.yaml`). Before the cluster switches to it
(`../weldid/README.md`, "Switching") nobody signs in through WeldID, so
these can wait for the morning; after it, WeldID is sign-in for the
platform, the mobile apps, the admin console and Grafana. Its ops port:
`kubectl -n weldid port-forward svc/weldid 9090`, then `/readyz` and
`/metrics` on `localhost:9090`. Logs: `{namespace="weldid"}` in Explore.

### WeldIDDown

No WeldID pod has been ready for 3 minutes.

- `kubectl -n weldid get pods`, `describe` and `logs --previous` of the
  ones not ready: an image pull error (the `registry` Secret: the images
  are private until WeldID 1.0), a crash at start (a config or secret
  WeldID refuses: its log says which), or not ready (`WeldIDNotReady`).
- A failed upgrade leaves the running pods alone; check the migration
  Job: `kubectl -n weldid logs job/weldid-migrate -c check-config`, then
  `-c migrate`, and `flux get helmreleases -n weldid`.
- `weldid-db` down (`PostgresInstanceDown`) takes WeldID with it.

### WeldIDNotReady

A WeldID pod has failed `/readyz` for 5 minutes while the other may still
serve. `/readyz` says which: `database: unavailable` (`weldid-db`, its
Service `weldid-db-rw`, the password in `weldid-env`) or `keys:
unavailable` (no current signing key: `WeldIDKeyRotationOverdue`, or a
`WELDID_MASTER_KEY` that doesn't open the keys in the database, after a
restore or a changed Secret: put the old key back, never a new one).

### WeldIDSignInFailures

More than 12 failed sign-ins a minute on one issuer for 10 minutes, at
least three for every success: password guessing or credential stuffing.
The rate limits slow each address down (`WeldIDRateLimited`); many
addresses mean a distributed attempt. Which accounts and addresses: the
logs. A wave against the staff issuer is the more serious one. Blocking at
Traefik or the load balancer, or making the second factor required on the
platform issuer (`issuers.platform.mfa` in `../weldid/values/weldid.yaml`)
are the levers.

### WeldIDRateLimited

WeldID refuses more than 30 requests a minute under one rate limit (the
`rule` label) for 15 minutes. An attack (see `WeldIDSignInFailures`), a
client stuck in a loop, or every visitor seen as one address: if the logs
show the same address for everyone (Traefik's), `trustedProxyHops` in
WeldID's values doesn't match the proxies in front of it.

### WeldIDKeyRotationOverdue

An issuer's newest signing key (per algorithm) retires in less than 6 days
and no successor is there. WeldID makes the successor 7 days ahead, at
start and hourly, so its key job has been failing for a day. At 0 that
issuer can't sign: sign-in stops and `/readyz` fails. The logs say why
(`kubectl -n weldid logs deploy/weldid | grep -i key`); `weldid keys rotate
--config /etc/weldid/weldid.toml [--issuer platform|staff]` in a WeldID pod
makes new keys at once (every client fetches the new JWKS by itself).

### WeldIDKeyMetricsMissing

WeldID is up but `weldid-db` reports no signing-key metric, so
`WeldIDKeyRotationOverdue` can't fire: the CloudNativePG custom query in
`../weldid/database.yaml` fails (a renamed table or column after a WeldID
upgrade, or the ConfigMap missing). The instance's log names the query's
error; fix the query.

## From kube-prometheus-stack

The chart's own rules also apply, trimmed (`../monitoring/values/kube-prometheus-stack.yaml`):
among them `KubeJobFailed` (a cron run failed; it clears a day later, when
the chart's `cron.ttlSecondsAfterFinished` removes the failed Job, or at once
with `kubectl -n weldsuite delete job <name>` once its logs are read),
`KubePodCrashLooping`,
`KubePersistentVolumeFillingUp`, `NodeMemoryHighUtilization`,
`TargetDown`, `PrometheusRuleFailures` and `AlertmanagerFailedToSendAlerts`,
and once etcd is scraped, `etcdNoLeader` and `etcdMembersDown` (critical).
Their runbooks: <https://runbooks.prometheus-operator.dev/>.
