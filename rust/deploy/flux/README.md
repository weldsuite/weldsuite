# Flux: everything in the EU cluster

Applied by Flux from `clusters/<cluster>` (runbook: `../hetzner/README.md`,
step 6). The cluster only pulls from the repository.

```
clusters/
  eu/       layers.yaml (the Flux Kustomizations, in order), cluster-settings.yaml (${NAME} values)
  drill/    the same layers with Postgres restored from production's backup (../hetzner/DRILL.md)
infrastructure/
  sources/      Helm repositories, Restate's OCI chart, this repository (the weldsuite chart)
  controllers/  namespaces, OpenEBS LocalPV, cert-manager, Traefik, CloudNativePG, barman-cloud plugin
  configs/      base: the issuer, Postgres clusters, poolers, backups; eu / drill overlays
  services/     NATS JetStream, Valkey, Restate, Zitadel
apps/eu/        the weldsuite HelmRelease
secrets/        eu/ and drill/: SOPS-encrypted Secrets; examples/: every Secret the layers expect
```

Order: `sources` → `controllers` → `secrets` → `configs` → `services` →
`apps`. Each HelmRelease's values are in a `values/` file next to it (a
generated ConfigMap), which `../validate.sh` renders with the chart at the
pinned version.

Rules:
- Pin every chart and image to a release at least two weeks old; change the
  pin in `../validate.sh` with it (the script fails when they differ).
- Never commit an unencrypted Secret; `.sops.yaml` encrypts `data` and
  `stringData` of `secrets/<cluster>/*.sops.yaml`.
- Per-cluster values go in `cluster-settings.yaml` as `${NAME}`, never as a
  copy of a layer.
