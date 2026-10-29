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
| OpenEBS LocalPV hostpath | chart 4.6.0 | Default StorageClass `openebs-hostpath`, under `/var/mnt/local-storage` (a Talos user volume) |
| cert-manager | v1.21.2 | Let's Encrypt (HTTP-01 through Traefik) |
| Traefik | chart 41.7.1 (Traefik v3.7.14) | NodePorts 30080/30443 behind the Hetzner LB, PROXY protocol |
| CloudNativePG | chart 0.29.1 (operator 1.30.1) | Clusters `master`, `tenants-1`, `zitadel-db`; Postgres 17.8 "standard" image (pgvector) |
| barman-cloud plugin | chart 0.8.1 (v0.15.1) | WAL archive + nightly base backups to a second EU provider |
| PgBouncer | CNPG `Pooler` | `master-pooler`, `tenants-1-pooler`, transaction mode (spikes S3, S4) |
| NATS JetStream | chart 2.15.0 | 3 nodes across locations, token auth |
| Valkey | chart 0.12.0 (Valkey 9.1.2) | One primary, ACL auth |
| Restate | chart 1.7.13 | One node to start |
| Zitadel | chart 10.4.0 (v4.19.2) | `auth.<domain>`, own CNPG cluster |
| weldsuite | this repository | `app.<domain>` (the platform SPA and its API on one origin) and `api.<domain>`, 2-6 replicas |
| weldsuite sign portal | this repository | `sign.<domain>`, 2 replicas (Node; ADR FE-017) |

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
  `sops`, `age` and `hcloud-upload-image`.
- A read-only **deploy key** for this repository (Flux pulls; it never pushes).
- Access to the `weldsuite` and `weldsuite-sign-portal` images (ghcr.io
  today, the EU registry later). Both build from `rust/Dockerfile` at the repo
  root: `docker build -f rust/Dockerfile .` (the server, with the platform SPA
  in `/srv/spa`) and `--target sign-portal`.

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

  `DATABASE_ENCRYPTION_KEY` decrypts `workspaces.database_url`;
  `SIGN_PORTAL_SECRET` is shared by the server and the sign portal (the
  server trusts the signer's IP the portal reports only next to it); the
  Zitadel masterkey is exactly 32 characters. Losing either makes stored data
  unreadable: keep them in the password manager too.
- The Traefik values trust PROXY headers from `10.10.0.0/16`; change them in
  `flux/infrastructure/controllers/values/traefik.yaml` if you change
  `network_cidr`.

## 5. DNS

Create the records `tofu output dns_records` prints (A and AAAA for `app.`,
`api.`, `auth.`, `sign.` → the ingress load balancer) at the DNS provider. cert-manager
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

## 7. Zitadel: first admin, the WeldSuite project, sign-in

Zitadel starts with the organisation's human `admin` and the password from
`zitadel-first-admin`. Sign in at `https://auth.<domain>/ui/console`, change
the password, add a second admin and MFA. Then, in that (the instance's
default) organisation:

1. **Project** `WeldSuite`, with the roles `admin` and `member` (Clerk's
   `org:admin` and `org:member` without the prefix). Turn on "Assert roles on
   authentication"; leave "Check authorization on authentication" **off**: a
   person signs up before they have a workspace, and with it on Zitadel
   refuses their first sign-in. Workspace access is the server's check (a
   token names only organisations that granted the person a role). Its **resource id** is
   the tokens' audience: `ZITADEL_PROJECT_ID` in
   `flux/clusters/eu/cluster-settings.yaml` (quoted; it is 18 digits).
2. **Web application** `platform` in the project: type *User Agent*,
   authentication *PKCE*, redirect URIs on `https://app.<domain>` (the auth
   facade's callback, P4 4.F5), and **Auth token type: JWT**: the server
   verifies access tokens as JWTs against Zitadel's JWKS and never
   introspects. Its client id is `ZITADEL_WEB_CLIENT_ID`, which the server
   hands the frontends in `/config.json`. Commit the settings.
3. **Scopes** the platform asks for: `openid profile email offline_access`,
   `urn:zitadel:iam:org:project:id:<project id>:aud` (puts the project in
   `aud`), `urn:zitadel:iam:org:projects:roles`, and
   `urn:zitadel:iam:org:roles:id:<workspace org id>` for the active
   workspace. The token's `urn:zitadel:iam:org:project:<project id>:roles`
   claim then names that one organisation, which the server takes as the
   session's (`config.auth.oidc.orgClaim` in the app's values). Without the
   narrowing scope, someone in two workspaces gets `ORG_REQUIRED`, never a
   guessed workspace. (The chart's default claim, `urn:zitadel:iam:org:id`
   from the `urn:zitadel:iam:org:id:<org id>` scope, is only set when the
   workspace is the person's own organisation; checked on Zitadel v4.19.)
4. **Second factor**: the server's step-up check reads `auth_time` and
   `amr`; Zitadel puts `mfa` in `amr` after two factors or a passkey. Require
   MFA in the login policy, or let step-up send the user back through
   `prompt=login`.
5. **Service user** for the server's identity adapter (`ZitadelIdentity`:
   organisations, users, invitations, memberships, and the event store the
   identity sync reads): a machine user `weldsuite-api` with the instance
   manager role `IAM_OWNER` and a personal access token, in the instance's
   default organisation (which owns the project). The token is
   `ZITADEL_SERVICE_TOKEN` in `weldsuite-env`; the app's values point the
   server at `http://zitadel.zitadel.svc:8080` with `auth.<domain>` as the
   host (`config.identity`).
6. **Self-registration**: in the default organisation's login settings,
   allow users to register. People sign up there (the platform's "Sign up"
   opens Zitadel's registration, `prompt=create`), and each workspace they
   create becomes an organisation of its own (next section).

A workspace is a Zitadel organisation: its id is what `workspaces.clerk_org_id`
holds, where Global keeps the Clerk org id, and the server looks a session's
organisation up there (or in `workspaces.id`).

The server fetches Zitadel's discovery document and keys from
`https://auth.<domain>` through the load balancer. If pods can't reach it
that way, set `config.auth.oidc.jwksUrl` to a URL they can; Zitadel picks its
instance by host name, so an in-cluster URL needs that host.

## Sign-up and the first workspace

With `TENANT_SHARDS` and `ZITADEL_*` in `weldsuite-env` (secrets example),
the server serves `/api/onboarding` and runs the provisioning job; the
`identity-sync` CronJob (every minute), `workspace-deletion` (daily) and
`workspace-teardown` (hourly) run with the same environment. What happens,
so each step can be checked:

1. The person registers at Zitadel and signs in to `app.<domain>`. Their
   token names no organisation, so the platform shows onboarding.
2. `POST /api/onboarding/workspace` (or `/create-workspace` for another one)
   creates the organisation (`POST /v2/organizations`; a name another
   organisation has becomes `Name (slug)` in Zitadel, the workspace keeps its
   own), grants it the project with `admin` and `member`, makes the person
   its `admin`, and writes the `workspaces` row (Free plan,
   `provisioning_status = 'pending'`) with the person's `users` and
   `user_workspaces` rows. Check: `select id, clerk_org_id, provisioning_status from workspaces order by created_at desc limit 5;`
3. The `workspace.provision` job (on Restate) creates the database on a
   shard (role, database, sealed URL, tenant migrations), adds the person as
   OWNER, installs the apps they picked, and marks the workspace `ready`;
   then the digest schedule and the first credits. The platform polls
   `/api/onboarding/database-status`. A failure shows `failed` with the
   reason in `provisioning_error`; "Retry" (`POST /api/onboarding/retry`)
   starts it again. Restate's UI (`kubectl -n weldsuite port-forward svc/restate 9070`)
   shows the invocation and each step.
4. The platform asks Zitadel for a token scoped to the new organisation
   (`urn:zitadel:iam:org:roles:id:<org id>`), and the person is in.

Changes made in Zitadel's console (renames, removed members, deleted users
or organisations) reach the databases through the `identity-sync` CronJob
within a minute; its watermark is the `identity_sync.watermark` row in the
master's `system_settings`. To run it by hand:
`kubectl -n weldsuite create job --from=cronjob/weldsuite-identity-sync sync-now`.
Organisations made in the console are not workspaces: only onboarding makes
those.

## 8. The master database schema

The `master` cluster starts with an empty `weldsuite_master` database. The
chart's migration Job builds it: Flux's first install runs
`weldsuite migrate --master --tenants` as a pre-install hook, with the
release's image and the `weldsuite-env` Secret, before any pod starts, and
every upgrade runs it again first (`migrations` in
`flux/apps/eu/values/weldsuite.yaml`). The migrations are built into the
image, so there is nothing to apply by hand. Follow it with

```bash
kubectl -n weldsuite get jobs -w                  # weldsuite-migrate, removed once it succeeded
kubectl -n weldsuite logs -f job/weldsuite-migrate
```

A failed Job stays, with its log, and fails the release; fix the cause and
let Flux retry (`flux reconcile helmrelease weldsuite -n weldsuite`). To run
it by hand against the live cluster, use a server pod, which has the same
environment (the image has no shell):
`kubectl -n weldsuite exec deploy/weldsuite -- /usr/local/bin/weldsuite migrate --dry-run`.

## Tenant databases

Each workspace has its own database on a tenant shard (DATA-016); `tenants-1`
is the first. The `DatabaseProvisioner` port's CloudNativePG adapter
(`rust/crates/adapters-oss/src/cnpg.rs`) makes them, called by the
`workspace.provision` job on signup (above). What it does, so a database can
be checked or made the same way by hand:

- It logs in to the shard's primary (`tenants-1-rw`) as `tenant`, which
  needs `CREATEDB` and `CREATEROLE` (the `Cluster`'s `postInitSQL`; on a
  cluster made before that, run `ALTER ROLE tenant CREATEDB CREATEROLE` once).
- Role `role_<workspace id>` with a random password, database
  `ws_<workspace id>` owned by it, `REVOKE ALL ON DATABASE … FROM PUBLIC`
  (`vector` and `pg_trgm` come from `template1`).
- The workspace's master row gets its placement (`neon_project_id` =
  `cnpg:tenants-1`, `shared_project_id` = the shard's `neon_shared_projects`
  row, which counts its databases, `neon_database_name`, `neon_role_name`)
  and `database_url`:
  `postgres://role_<id>:<password>@tenants-1-pooler.postgres.svc:5432/ws_<id>?sslmode=require`,
  sealed with `DATABASE_ENCRYPTION_KEY_V2` (v3 with `FIELD_ENCRYPTION_AAD_WRITES`).
  The server also reads a plain URL, as the kind smoke test does, but don't
  store one in production.
- Then the tenant migrations, as `weldsuite migrate` applies them. By hand,
  for a database already placed and stored:
  `kubectl -n weldsuite exec deploy/weldsuite -- /usr/local/bin/weldsuite migrate --tenants --only <workspace id>`.

The provisioner's shards come from its configuration (`TENANT_SHARDS`, a
JSON list: `name`, `adminUrl` to `<cluster>-rw` as `tenant`, `poolerHost`,
optional `poolerPort`, `urlOptions`, `maxDatabases`). A new shard is another
`Cluster` + `Pooler` + `ObjectStore` + `ScheduledBackup` copied from
`tenants-1`, plus an entry there.

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
- **Sign-in.** The server verifies Zitadel's tokens (`AUTH_PROVIDER=oidc`,
  step 7) and the platform signs in through Zitadel with its auth facade
  (OIDC with PKCE, from `/config.json`). The core team routes that call the
  identity adapter (invitations, members) are still served in conformance
  builds only.
- **Workspace lifecycle.** Signup, onboarding, provisioning, the identity
  sync and the deletion sweeps run (above). Not on this cluster: sample
  data and the default helpdesk workflows (their modules aren't ported), the
  WeldMail domain of a new workspace, Stripe, and a reseller's entry point
  (partner onboarding runs on Global; only the provisioning job knows a
  partner workspace).
- **Frontends.** The server serves the platform SPA from its image at
  `app.<domain>` (built with `VITE_RUNTIME_CONFIG=on`: it reads
  `/config.json` and calls the API on its own origin). The sign portal runs
  at `sign.<domain>`, but the server's `/public/sign-portal/*` endpoints it
  calls are not ported yet, so a signing link answers "not found" until they
  are. Not here yet: the help center, a CDN (Bunny.net) in front of
  `app.<domain>`, and `/config.json`'s `env` map for the public keys Global
  bakes in (Stripe, Mapbox, the portal URLs), so those features are off.
- **Billing.** Mollie for the EU edition (P5, needs a BILL ADR). No billing
  runs here.
- **Other EU services** in the design: system email (SMTP adapter in progress
  on a separate branch), LiveKit + TURN, Haraka MX, Mistral, sipgate.
- **Operations** (P5): the EU registry and signed images (5.4), observability
  and alerting (5.5), the drill runner (5.6), DNS failover between locations,
  object storage replication, HA for Valkey (Sentinel or replicas) and a
  three-node Restate cluster.
