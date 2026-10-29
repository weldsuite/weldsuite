# WeldSuite EU on Hetzner: runbook

The Kubernetes edition of WeldSuite (the Rust backend, ADRs API-014 and
OPS-012/013) on Hetzner Cloud: **Talos** Kubernetes across Falkenstein (FSN1)
and Nuremberg (NBG1) with a Helsinki (HEL1) control-plane tie-breaker,
CloudNativePG on a dedicated local-NVMe pool, and everything else in the
cluster. Design: "EU: Kubernetes on Hetzner, then own servers" in
`design/platform/editions-and-self-hosting.md` (docs repo), phase P5.

| Layer | What | Where |
|---|---|---|
| Servers, network, firewall, load balancers, Talos bootstrap | OpenTofu (`hetznercloud/hcloud` 1.70.0, `siderolabs/talos` 0.12.0) | `rust/deploy/hetzner` |
| Everything in the cluster | Flux (v2.9.6), Helm, kustomize, SOPS (age) | `rust/deploy/flux` |
| The application | the `weldsuite` chart | `rust/deploy/helm/weldsuite` |
| Checks without a cloud account | `rust/deploy/validate.sh` (CI: `Rust · deploy config`) | |
| Monthly build, restore, teardown | `scripts/drill.sh`, [DRILL.md](DRILL.md) | |

Nothing here uses a Hetzner-only managed service: no Cloud Volumes (local
NVMe through OpenEBS LocalPV), no managed Postgres, no cloud controller
manager (zones are node labels set by Talos). The same Flux tree runs on own
servers later; only this OpenTofu module is replaced by Talos on bare metal.

## What runs in the cluster

| Component | Version | Notes |
|---|---|---|
| Talos Linux | v1.14.3 | Image from Talos' Image Factory (`scripts/upload-talos-image.sh`) |
| OpenEBS LocalPV hostpath | chart 4.6.0 | Default StorageClass `openebs-hostpath`, under `/var/openebs/local` |
| cert-manager | v1.21.2 | Let's Encrypt (HTTP-01 through Traefik) |
| Traefik | chart 41.7.1 (Traefik v3.7.14) | NodePorts 30080/30443 behind the Hetzner LB, PROXY protocol |
| CloudNativePG | chart 0.29.1 (operator 1.30.1) | Clusters `master`, `tenants-1`, `zitadel-db`; Postgres 17.8 "standard" image (pgvector) |
| barman-cloud plugin | chart 0.8.1 (v0.15.1) | WAL archive + nightly base backups to a second EU provider |
| PgBouncer | CNPG `Pooler` | `master-pooler`, `tenants-1-pooler`, transaction mode (spikes S3, S4) |
| NATS JetStream | chart 2.15.0 | 3 nodes across locations, token auth |
| Valkey | chart 0.12.0 (Valkey 9.1.2) | One primary, ACL auth |
| Restate | chart 1.7.13 | One node to start |
| Zitadel | chart 10.4.0 (v4.19.2) | `auth.<domain>`, own CNPG cluster |
| weldsuite | this repository | `api.<domain>`, 2-6 replicas |

Every version is pinned and was released at least two weeks before it was
pinned. `validate.sh` fails when a HelmRelease's pin and the one it checks
differ.

## Prerequisites

- A **Hetzner Cloud project** and an API token (read/write), kept out of git:
  `export TF_VAR_hcloud_token=…` (and `HCLOUD_TOKEN` for the image script).
- A **domain** at an EU DNS provider (Hetzner DNS works).
- **Object storage**:
  - Hetzner Object Storage bucket(s) for files: the private bucket
    (`FILES_BUCKET_PRIVATE`) and S3 keys for it;
  - a bucket at a **second EU provider** for Postgres backups, and its keys.
- An **age** key pair for SOPS: `age-keygen -o eu.agekey`. Keep the private
  key outside git (a password manager); the cluster gets a copy in step 6.
- Tools: `tofu` (OpenTofu ≥ 1.9), `talosctl` v1.14, `kubectl`, `flux` v2.9,
  `sops`, `age`, `hcloud-upload-image`, and `pnpm` for the migrations.
- A read-only **deploy key** for this repository (Flux pulls; it never pushes).
- Access to the `weldsuite` image (ghcr.io today, the EU registry later).

## 1. Talos image

```bash
HCLOUD_TOKEN=… TALOS_VERSION=v1.14.3 rust/deploy/hetzner/scripts/upload-talos-image.sh
```

Uploads the stock Talos image as a snapshot labelled `os=talos,
talos_version=v1.14.3`; `servers.tf` picks the newest one with that label.

## 2. Settings

```bash
cd rust/deploy/hetzner
cp terraform.tfvars.example terraform.tfvars   # git-ignored
# domain, admin_cidrs (your address and the drill runner's), sizes
```

Server types (`cpx22` control plane, `cpx32` workers, `ccx23` Postgres) are
defaults, not facts: check availability in the console first, and expect the
drill to report substitutions.

**State.** The state holds the Talos secrets and the kubeconfig. Use the S3
backend in `versions.tf` (a private bucket) and OpenTofu's state encryption,
e.g. in a git-ignored `encryption.tf`:

```hcl
terraform {
  encryption {
    key_provider "pbkdf2" "main" { passphrase = var.state_passphrase }
    method "aes_gcm" "main" { keys = key_provider.pbkdf2.main }
    state { method = method.aes_gcm.main }
  }
}
```

## 3. Infrastructure

```bash
tofu init
tofu apply
tofu output -raw kubeconfig  > kubeconfig  && export KUBECONFIG=$PWD/kubeconfig
tofu output -raw talosconfig > talosconfig && export TALOSCONFIG=$PWD/talosconfig
kubectl get nodes -L topology.kubernetes.io/zone,node.weldsuite.org/pool
```

This creates the private network, a spread placement group per location,
the firewall (only 6443 and 50000, from `admin_cidrs`), three control-plane
nodes, the general workers, the two Postgres nodes (tainted
`node.weldsuite.org/postgres`), and two load balancers: one for the
Kubernetes and Talos APIs, one for HTTP(S) to Traefik with the PROXY
protocol. Talos boots from the machine config in the server's user data;
OpenTofu bootstraps etcd and writes the kubeconfig.

Later changes to a machine config: `talosctl apply-config` (OpenTofu ignores
`user_data` after creation, so it never replaces a running node). Talos and
Kubernetes upgrades: `talosctl upgrade` / `talosctl upgrade-k8s`, one node at
a time.

## 4. Settings and secrets for Flux

- `rust/deploy/flux/clusters/eu/cluster-settings.yaml`: domain, ACME email,
  the backup and files endpoints and buckets, the release tag
  (`WELDSUITE_GIT_TAG`) and image tag. Not secret; commit it.
- Secrets: put your age public key in `rust/deploy/flux/.sops.yaml`, then

  ```bash
  cd rust/deploy/flux
  cp secrets/examples/secrets.example.yaml secrets/eu/secrets.sops.yaml
  # replace every CHANGE_ME (openssl rand -base64 32 …)
  sops --encrypt --in-place secrets/eu/secrets.sops.yaml
  # list secrets.sops.yaml in secrets/eu/kustomization.yaml, commit
  ```

  `DATABASE_ENCRYPTION_KEY` decrypts `workspaces.database_url`; the
  Zitadel masterkey is exactly 32 characters. Losing either makes stored data
  unreadable: keep them in the password manager too.
- The Traefik values trust PROXY headers from `10.10.0.0/16`; change them in
  `flux/infrastructure/controllers/values/traefik.yaml` if you change
  `network_cidr`.

## 5. DNS

Create the records `tofu output dns_records` prints (A and AAAA for `api.`,
`auth.`, `sign.` → the ingress load balancer) at the DNS provider. cert-manager
issues certificates once they resolve. (external-dns is not installed: a
handful of static records doesn't need it.)

## 6. Flux

Read only: the cluster pulls from the repository, nothing is pushed.

```bash
flux install --version=v2.9.6
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey=eu.agekey
flux create secret git flux-system \
  --url=ssh://git@github.com/weldsuite/weldsuite --private-key-file=deploy-key
flux create source git flux-system \
  --url=ssh://git@github.com/weldsuite/weldsuite --branch=main --secret-ref=flux-system
flux create kustomization flux-system \
  --source=GitRepository/flux-system --path=./rust/deploy/flux/clusters/eu --prune=true
flux get kustomizations --watch
```

The layers come up in order: `sources` → `controllers` (namespaces, OpenEBS,
cert-manager, Traefik, CloudNativePG, the backup plugin) → `secrets` →
`configs` (Postgres clusters, poolers, backups, the issuer) → `services`
(NATS, Valkey, Restate, Zitadel) → `apps` (weldsuite).

## 7. Zitadel's first admin

Zitadel starts with the organisation's human `admin` and the password from
`zitadel-first-admin`. Sign in at `https://auth.<domain>/ui/console`, change
the password, add a second admin and MFA, then create the project and the OIDC
application for the platform (see "Not yet" below).

## 8. The master database schema

The `master` cluster starts with an empty `weldsuite_master` database. Apply
the journaled master migrations, straight to the cluster (not through
PgBouncer):

```bash
kubectl -n postgres port-forward service/master-rw 15432:5432 &
MASTER_DATABASE_URL="postgres://weldsuite:<master owner password>@127.0.0.1:15432/weldsuite_master?sslmode=require" \
  pnpm --filter @weldsuite/db db:migrate:master
```

Run it again after every release that adds a master migration (the chart's
migration Job is P5 work package 5.1).

## Tenant databases

Each workspace has its own database on a tenant shard (DATA-016); `tenants-1`
is the first. Until the `DatabaseProvisioner` port exists (P4 4a), a
workspace's database is made by hand:

```bash
kubectl -n postgres port-forward service/tenants-1-rw 25432:5432 &
psql "postgres://tenant:<tenant password>@127.0.0.1:25432/tenants?sslmode=require" \
  -c 'CREATE DATABASE ws_<workspace id>'
DATABASE_URL="postgres://tenant:<tenant password>@127.0.0.1:25432/ws_<workspace id>?sslmode=require" \
  pnpm --filter @weldsuite/db exec drizzle-kit migrate --config=drizzle.config.ts
```

Its `workspaces.database_url` points at the pooler:
`postgres://tenant:<password>@tenants-1-pooler.postgres.svc:5432/ws_<id>?sslmode=require`,
encrypted with `DATABASE_ENCRYPTION_KEY` (the server also reads a plain URL,
as the kind smoke test does, but don't store one in production). A new shard
is another `Cluster` + `Pooler` + `ObjectStore` + `ScheduledBackup` copied
from `tenants-1`.

## Backups and restores

Every Postgres cluster archives WAL continuously and takes a nightly base
backup to the second provider (`postgres/*-backups` ObjectStores, 30 days).
Restore a cluster the way the drill does (`flux/infrastructure/configs/drill`):
a new `Cluster` with `bootstrap.recovery` from the ObjectStore. Run the drill
monthly ([DRILL.md](DRILL.md)).

## Cost

Estimates from the design doc, at Hetzner list prices: dormant ≈ €70/month
(registry, backups, the drill), launch ≈ €310/month, ten times the launch load
≈ €1,300/month.

## Not yet: what's missing before production

Be clear about this before anyone signs a contract:

- **Modules.** The Rust backend serves only what is ported: the core routes of
  P1, know and (in progress) sign. Every other module is TypeScript-only and
  not available on this cluster (P4, P6, P8). The EU `/config.json` offers
  only ported modules.
- **Sign-in.** Zitadel runs, but the server still verifies Clerk-shaped
  session tokens (`CLERK_JWKS_URL`), and the frontends still use Clerk. The
  OIDC identity adapter (SEC-012) and the frontends' auth facade with runtime
  config (P4 4.F1/4.F2/4.F5) are needed before anyone can sign in through
  Zitadel.
- **Workspace lifecycle.** Signup, onboarding and database provisioning
  (P4 4a) are not ported; tenant databases are made by hand (above).
- **Frontends.** The SPA, the sign portal and the help center are not part of
  this cluster yet (Bunny.net edge for the SPA, the portal as a Node
  container; P3/P6).
- **Billing.** Mollie for the EU edition (P5, needs a BILL ADR). No billing
  runs here.
- **Other EU services** in the design: system email (SMTP adapter in progress
  on a separate branch), LiveKit + TURN, Haraka MX, Mistral, sipgate.
- **Operations** (P5): the EU registry and signed images (5.4), observability
  and alerting (5.5), the drill runner (5.6), DNS failover between locations,
  object storage replication, HA for Valkey (Sentinel or replicas) and a
  three-node Restate cluster.
