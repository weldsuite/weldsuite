# Flux: everything in the cluster

Applied by Flux from `clusters/<cluster>` (install guide:
`../hetzner/README.md`, step 6). The cluster only pulls from the repository.

```
clusters/
  example/  an example cluster with placeholders: layers.yaml (the Flux Kustomizations, in order),
            cluster-settings.yaml (${NAME} values), configs/ (its own configs: the MTA's database)
infrastructure/
  sources/      Helm repositories, Restate's OCI chart, the weldsuite chart's releases
  controllers/  namespaces, OpenEBS LocalPV, cert-manager, Traefik, CloudNativePG, barman-cloud plugin,
                metrics-server, the kubelet serving-certificate approver, External Secrets Operator
  configs/      base: the issuer, Postgres clusters, poolers, backups (a cluster patches it in its layers)
  services/     NATS JetStream, Valkey, Restate, Zitadel
  video/        LiveKit (WeldMeet and WeldChat calls), its signalling host and TURN over TLS through Traefik
  monitoring/   kube-prometheus-stack (Prometheus, Alertmanager, Grafana) and the blackbox exporter
  monitoring-config/
                what they scrape, probe and alert on, and WeldSuite's dashboards (after monitoring,
                which brings the CRDs; dashboards/generate.mjs writes them); ALERTS.md: what each
                alert means and what to do
  logging/      Loki on the cluster's logs bucket, Fluent Bit on every node and for the events
  offsite-copy/ OPT-IN: rclone in a CronJob, copying the buckets a cluster lists to a bucket at another
                provider once a day (clusters/example/offsite-copy.yaml; ../hetzner/README.md,
                "Offsite copy"); its alert is in monitoring-config
  network-policy/
                OPT-IN: kube-router's network policy controller beside Flannel, so NetworkPolicies are
                enforced, and a policy per namespace that keeps pods off the metadata service
                (clusters/example/network-policy.yaml; ../hetzner/README.md, "Agent sandbox")
  weldid/       OPT-IN: WeldID, WeldSuite's own OIDC provider replacing Zitadel (ADR SEC-019), with its
                namespace (namespace/), CNPG cluster, backups, alerts; README.md there says how to turn it
                on and switch to it (clusters/example/weldid.yaml, weldid-switch.yaml)
apps/eu/        the weldsuite HelmRelease
apps/weldid-switch/
                OPT-IN: the switch from Zitadel to WeldID, values the base releases list as optional
apps/marketing/ the marketing site (WeldSuite's test cluster only, so far: its image is built for that
                cluster's hosts in weldsuite-eu-marketing, which publishes its chart too; both private,
                pulled with the marketing/ghcr token)
secrets/        the secrets layer: the ClusterSecretStore (the cluster's secret store) and an
                ExternalSecret for every Secret the layers read, no values; mta/, marketing/,
                monitoring/, logging/, offsite-copy/, registry/: components a cluster adds; weldid/: WeldID's, its
                own layer; store.example.yaml: every value the store holds
scripts/        seed-secrets.mjs: fills a cluster's secret store (--import: from a SOPS file),
                --check: the secrets layer against store.example.yaml;
                ntfy-receiver-url.mjs: an Alertmanager receiver URL for an ntfy topic;
                restore-workspace.sh: one workspace's database back to a point in time
                (rust/deploy/hetzner/README.md, "Restoring one workspace")
```

To run your own cluster, copy `clusters/example` to `clusters/<name>` in your
copy of this repository, change the path in its `layers.yaml` that names
`example`, fill in its settings and fill its secret store
(`../hetzner/README.md`, step 4).

WeldSuite's own clusters (EU production, the test cluster and the monthly
restore drill) are not here: their settings, layers, patches and runbooks
are in a private deployment repository (ADR OPS-018), and their secrets in
an OpenBao store of their own (`../hetzner/secret-store`, ADR OPS-023). Their Flux reads two sources: this repository
(GitRepository `weldsuite`) for the base layers above, and the private one
(`flux-system`) for the cluster folder. The test cluster follows `main`; production and the drill follow
the main build test last ran, pinned to its chart (`X.Y.Z-main.N`) and the
commit whose CI passed for it: the build's own, or a later one that changed
nothing the build is made from (ADR OPS-020). A self-hosted install follows a release tag
(`weldsuite-vX.Y.Z`).

Order: `sources` → `controllers` → `secrets` → `configs` (with a cluster's
own `configs-extra` next to it) → `services` → `apps`, and `video` after
`services`, beside `apps`; `monitoring` after `secrets`, then
`monitoring-config` and `logging` after it. The opt-in `network-policy` comes
after `controllers`, and `offsite-copy` after `secrets` (with the secrets
layer's `offsite-copy` component). A cluster that turns WeldID on adds
`weldid-namespace` → `weldid-secrets` → `weldid` (after `services` and `monitoring`), and to
sign in with it `weldid-switch` (`../hetzner/README.md`, "WeldID instead of Zitadel"). Each
HelmRelease's values are in a `values/` file
next to it (a generated ConfigMap), which `../validate.sh` renders with the
chart at the pinned version.

Rules:
- Pin every chart and image to a release at least two weeks old; change the
  pin in `../validate.sh` with it (the script fails when they differ, and
  when a layer's own manifest runs an image it doesn't pin).
- Never commit a secret value, encrypted or not: values live in the
  cluster's secret store, and `secrets/` holds only the ExternalSecrets that
  read them. A new Secret is an ExternalSecret in `secrets/` (or one of its
  components) and its values in `store.example.yaml`; `../validate.sh` fails
  when the two disagree (`seed-secrets.mjs --check`).
- Per-cluster values go in `cluster-settings.yaml` as `${NAME}`, and
  per-cluster changes to a base layer in that layer's `patches` in the
  cluster's `layers.yaml`, never in a copy of a layer.
- A Kustomization's `path` must be in its own source: a cluster on two
  sources can't use a kustomize overlay over a base in the other one, so
  its patches go in `layers.yaml` and its extra resources in its own folder.
