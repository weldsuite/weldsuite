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
                metrics-server, the kubelet serving-certificate approver
  configs/      base: the issuer, Postgres clusters, poolers, backups (a cluster patches it in its layers)
  services/     NATS JetStream, Valkey, Restate, Zitadel
  video/        LiveKit (WeldMeet and WeldChat calls), its signalling host and TURN over TLS through Traefik
  monitoring/   kube-prometheus-stack (Prometheus, Alertmanager, Grafana) and the blackbox exporter
  monitoring-config/
                what they scrape, probe and alert on, and WeldSuite's dashboards (after monitoring,
                which brings the CRDs; dashboards/generate.mjs writes them); ALERTS.md: what each
                alert means and what to do
  logging/      Loki on the cluster's logs bucket, Fluent Bit on every node and for the events
apps/eu/        the weldsuite HelmRelease
apps/marketing/ the marketing site (WeldSuite's test cluster only, so far: its image is built for that
                cluster's hosts in weldsuite-eu-marketing, which publishes its chart too; both private,
                pulled with the marketing/ghcr token)
secrets/        examples/: every Secret the layers expect; example/: where the example cluster's
                SOPS-encrypted Secrets go
scripts/        fill-secrets.mjs: a cluster's secrets file from the examples, with random values;
                --update adds what the examples gained to an encrypted one;
                ntfy-receiver-url.mjs: an Alertmanager receiver URL for an ntfy topic
```

To run your own cluster, copy `clusters/example` to `clusters/<name>` and
`secrets/example` to `secrets/<name>` in your copy of this repository, change
the paths in its `layers.yaml` that name `example`, and fill in its settings
and secrets (`../hetzner/README.md`, step 4).

WeldSuite's own clusters (EU production, the test cluster and the monthly
restore drill) are not here: their settings, layers, patches, secrets and
runbooks are in a private deployment repository (ADR OPS-018). Their Flux
reads two sources: this repository (GitRepository `weldsuite`) for the base
layers above, and the private one (`flux-system`) for the cluster folder and
the secrets. The test cluster follows `main`; production and the drill follow
the main build test last ran, pinned to its chart (`X.Y.Z-main.N`) and the
commit whose CI passed for it: the build's own, or a later one that changed
nothing the build is made from (ADR OPS-020). A self-hosted install follows a release tag
(`weldsuite-vX.Y.Z`).

Order: `sources` → `controllers` → `secrets` → `configs` (with a cluster's
own `configs-extra` next to it) → `services` → `apps`, and `video` after
`services`, beside `apps`; `monitoring` after `secrets`, then
`monitoring-config` and `logging` after it. Each HelmRelease's values are in a `values/` file
next to it (a generated ConfigMap), which `../validate.sh` renders with the
chart at the pinned version.

Rules:
- Pin every chart and image to a release at least two weeks old; change the
  pin in `../validate.sh` with it (the script fails when they differ).
- Never commit an unencrypted Secret: a `.sops.yaml` that encrypts `data`
  and `stringData` of `secrets/<cluster>/*.sops.yaml`
  (`../hetzner/README.md`, step 4); `../validate.sh` fails on a value that
  isn't `ENC[…]`.
- Per-cluster values go in `cluster-settings.yaml` as `${NAME}`, and
  per-cluster changes to a base layer in that layer's `patches` in the
  cluster's `layers.yaml`, never in a copy of a layer.
- A Kustomization's `path` must be in its own source: a cluster on two
  sources can't use a kustomize overlay over a base in the other one, so
  its patches go in `layers.yaml` and its extra resources in its own folder.
