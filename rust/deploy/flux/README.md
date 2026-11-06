# Flux: everything in the EU cluster

Applied by Flux from `clusters/<cluster>` (runbook: `../hetzner/README.md`,
step 6). The cluster only pulls from the repository.

```
clusters/
  eu/       layers.yaml (the Flux Kustomizations, in order), cluster-settings.yaml (${NAME} values)
  drill/    the same layers with Postgres restored from production's backup (../hetzner/DRILL.md)
  test/     the EU test cluster: the same layers on small nodes, following develop, with the
            chart and images of the newest develop build (../hetzner/TEST-CLUSTER.md)
infrastructure/
  sources/      Helm repositories, Restate's OCI chart, this repository (the weldsuite chart)
  controllers/  namespaces, OpenEBS LocalPV, cert-manager, Traefik, CloudNativePG, barman-cloud plugin,
                metrics-server, the kubelet serving-certificate approver
  configs/      base: the issuer, Postgres clusters, poolers, backups; eu / drill / test overlays
  services/     NATS JetStream, Valkey, Restate, Zitadel
  video/        LiveKit (WeldMeet and WeldChat calls), its signalling host and TURN over TLS through Traefik
  monitoring/   Prometheus for Lens (test only, so far)
apps/eu/        the weldsuite HelmRelease
apps/marketing/ the marketing site (test only, so far: its image is built for the test cluster's
                hosts in weldsuite-eu-marketing, which publishes its chart too)
secrets/        eu/, drill/ and test/: SOPS-encrypted Secrets; examples/: every Secret the layers expect
scripts/        fill-secrets.mjs: a cluster's secrets file from the examples, with random values
```

Order: `sources` → `controllers` → `secrets` → `configs` → `services` →
`apps`, and `video` after `services`, beside `apps` (eu and test; the drill
leaves it out). On test, `marketing` follows `configs` (the ingress and the
issuer are all it needs). Each HelmRelease's values are in a `values/` file next to it
(a generated ConfigMap), which `../validate.sh` renders with the chart at the
pinned version.

Rules:
- Pin every chart and image to a release at least two weeks old; change the
  pin in `../validate.sh` with it (the script fails when they differ).
- Never commit an unencrypted Secret; `.sops.yaml` encrypts `data` and
  `stringData` of `secrets/<cluster>/*.sops.yaml`.
- Per-cluster values go in `cluster-settings.yaml` as `${NAME}`, never as a
  copy of a layer.
