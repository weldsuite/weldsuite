# WeldSuite on Hetzner: install guide

The Kubernetes edition of WeldSuite (the Rust backend, ADRs API-014 and
OPS-012/013) on Hetzner Cloud: **Talos** Kubernetes across Falkenstein (FSN1)
and Nuremberg (NBG1) with a Helsinki (HEL1) control-plane tie-breaker,
CloudNativePG on a dedicated local-NVMe pool, and everything else in the
cluster. Design: "EU: Kubernetes on Hetzner, then own servers" in
`design/platform/editions-and-self-hosting.md` (docs repo), phase P5.

This guide installs it on a cluster of your own: the self-hosted
distribution of [ADR OPS-014](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/OPS-014-self-hosted-distribution.md).
Your cluster's folder starts as a copy of `flux/clusters/example`, in your
own copy of this repository. WeldSuite runs its own clusters (EU production,
its test cluster and a monthly restore drill) with this module, the same
base layers and the same chart, but from a private repository that holds
their settings, secrets and runbooks (ADR OPS-018).

| Layer | What | Where |
|---|---|---|
| Servers, network, firewall, load balancers, Talos bootstrap | OpenTofu (`hetznercloud/hcloud` 1.70.0, `siderolabs/talos` 0.12.0) | `rust/deploy/hetzner` |
| Everything in the cluster | Flux (v2.9.6), Helm, kustomize, SOPS (age) | `rust/deploy/flux` |
| The application | the `weldsuite` chart | `rust/deploy/helm/weldsuite` |
| Checks without a cloud account | `rust/deploy/validate.sh` (CI: `Rust · deploy config`) | |

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
| LiveKit | chart 1.9.0 (livekit-server v1.13.10) | WeldMeet and WeldChat calls: one pod on each of two general workers, host network; `livekit.<domain>` and TURN at `turn.<domain>` ("Video" below) |
| weldsuite MTA | this repository (`weldsuite mta`) | Outgoing mail from the mail nodes' own addresses, pools `system` and `customer`; bounce MX at `bounces.<domain>` ("Mail" below) |
| kube-prometheus-stack | chart 92.3.1 | Prometheus (30 days), Alertmanager, Grafana at `grafana.<domain>` ("Monitoring, alerts and logs" below) |
| Blackbox exporter | chart 11.20.2 | Probes the public hosts through the load balancer |
| Loki | chart 7.5.0 | Logs, single binary, chunks in the logs bucket, 30 days |
| Fluent Bit | chart 0.58.3 | Every node's pod and Talos logs, and the cluster's events, to Loki |
| Haraka | this repository (`rust/deploy/haraka`) | WeldMail's MX at `mx.<domain>`, port 25 on the ingress load balancer ("Mail" below) |

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
- **Your copy of this repository** (a fork or a mirror) for your cluster's
  folder and its encrypted secrets. Flux reads it (step 6) and never
  pushes: a public copy needs no credentials, a private one a read-only
  credential (a GitHub App, `flux create secret githubapp`, or a deploy key).
- **A release** to run: `WELDSUITE_VERSION` (step 4), a `weldsuite-vX.Y.Z`
  release of this repository ("Releases" below). Its images (`weldsuite`, `weldsuite-sign-portal`,
  `weldsuite-collab-rooms`, `weldsuite-haraka`) and chart are public
  packages on ghcr.io today, the EU registry later. The first three build
  from `rust/Dockerfile` at the repo root: `docker build -f rust/Dockerfile .`
  (the server, with the platform SPA in `/srv/spa`; also the MTA, `weldsuite
  mta`), `--target sign-portal` and `--target collab-rooms`; Haraka from
  `rust/deploy/haraka`.
- For mail: a **paid first invoice** on the Hetzner project before the
  outbound port 25 unblock can be requested ("Mail" below).

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
# domain, admin_cidrs (your address), sizes
```

Server types (`cpx22` control plane, `cpx32` workers, `ccx23` Postgres) are
defaults, not facts: check availability in the console first (Hetzner has
listed "limited availability" of cloud instances since April 2026). `livekit_worker_count` (2) is how many general
workers also run LiveKit ("Video" below).

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
kubectl get nodes -L topology.kubernetes.io/zone,node.weldsuite.org/pool,node.weldsuite.org/livekit,weldsuite.org/mail-pool
```

This creates the private network, a spread placement group per location,
the firewall (only 6443 and 50000, from `admin_cidrs`), three control-plane
nodes, the general workers, the two Postgres nodes (tainted
`node.weldsuite.org/postgres`), and two load balancers: one for the
Kubernetes and Talos APIs, one for HTTP(S) to Traefik with the PROXY
protocol. The first `livekit_worker_count` workers also get the
`node.weldsuite.org/livekit` label and a second firewall with LiveKit's media
ports (UDP 7882, TCP 7881, UDP 3478). With `mail_pools`, the mail nodes
come too, each with its own primary IPv4, reverse DNS and the mail firewall
(TCP 25), and with `mx_node_port` the ingress load balancer also listens on
25 ("Mail" below). Talos boots from the machine config in the server's user
data; OpenTofu bootstraps etcd and writes the kubeconfig.

Later changes to a machine config: `talosctl apply-config` (OpenTofu ignores
`user_data` after creation, so it never replaces a running node). Talos and
Kubernetes upgrades: `talosctl upgrade` / `talosctl upgrade-k8s`, one node at
a time.

## 4. Settings and secrets for Flux

- Your cluster's folder: copy `rust/deploy/flux/clusters/example` to
  `clusters/<cluster>` and `secrets/example` to `secrets/<cluster>`, and in
  its `layers.yaml` change the two paths that name `example` (the secrets
  layer and `configs-extra`). Then `cluster-settings.yaml`: domain, ACME
  email, the backup and files endpoints and buckets, and the release
  (`WELDSUITE_VERSION`, "Releases" below). Not secret; commit it. Sizing or
  other changes to a base layer go in that layer's `patches` in
  `layers.yaml`.
- Secrets: a `rust/deploy/flux/.sops.yaml` with your age public key:

  ```yaml
  creation_rules:
    - path_regex: secrets[/\\]<cluster>[/\\].*\.sops\.yaml$
      encrypted_regex: ^(data|stringData)$
      age: age1…   # the "public key" line of your .agekey
  ```

  then

  ```bash
  cd rust/deploy/flux
  cp secrets/examples/secrets.example.yaml secrets/<cluster>/secrets.sops.yaml
  # replace every CHANGE_ME (openssl rand -base64 32 …)
  sops --encrypt --in-place secrets/<cluster>/secrets.sops.yaml
  # list secrets.sops.yaml in secrets/<cluster>/kustomization.yaml, commit
  ```

  `DATABASE_ENCRYPTION_KEY` decrypts `workspaces.database_url`;
  `SIGN_PORTAL_SECRET` is shared by the server and the sign portal (the
  server trusts the signer's IP the portal reports only next to it); the
  Zitadel masterkey is exactly 32 characters. Losing either makes stored data
  unreadable: keep them in the password manager too. The LiveKit key pair
  appears twice (`weldsuite-env` and `livekit-env`) and must match, as must
  `livekit-env`'s `REDIS_PASSWORD` and the Valkey password. `MTA_KEY`
  (`weldsuite-mta`) seals every sending domain's DKIM key: keep it there too,
  and the MTA's database password matches in `weldsuite-mta` and
  `master-db-mta`. `scripts/fill-secrets.mjs` generates all of these.
  `MISTRAL_API_KEY` is the one AI key the cluster needs ("AI" below); the
  script takes it from the variable of that name, and generates
  `AI_KEYS_ENCRYPTION_KEY`, which seals the keys workspaces bring for Claude
  and ChatGPT (losing it loses those keys, nothing else).
- The Traefik values trust PROXY headers from `10.10.0.0/16`; change them in
  `flux/infrastructure/controllers/values/traefik.yaml` if you change
  `network_cidr`.

## 5. DNS

Create the records `tofu output dns_records` prints (A and AAAA for `app.`,
`api.`, `auth.`, `sign.`, `admin.`, `grafana.`, `livekit.`, `turn.`, and `mx.` with
`mx_node_port` → the ingress load balancer) at the DNS provider. cert-manager
issues certificates once they resolve. (external-dns is not installed: a
handful of static records doesn't need it.) Media needs no record: LiveKit
gives clients the nodes' addresses itself. The mail records are in "Mail" below.

## 6. Flux

Read only: the cluster pulls from your copy of the repository, nothing is
pushed. The configuration comes from its branch; the chart and images come
from the release `WELDSUITE_VERSION` names. The flux CLI must be the version
it installs (v2.9.6; a newer CLI refuses).

```bash
flux install --version=v2.9.6
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey=<cluster>.agekey
flux create source git flux-system \
  --url=https://github.com/<you>/weldsuite --branch=main
flux create kustomization flux-system \
  --source=GitRepository/flux-system --path=./rust/deploy/flux/clusters/<cluster> --prune=true
flux get kustomizations --watch
```

A private copy needs a credential first, e.g. a GitHub App with read access
to it (`flux create secret githubapp <name> --app-id=… --app-installation-id=…
--app-private-key=<pem>`, then `--provider=github --secret-ref=<name>` on the
source; Flux 2.5 or later).

The layers come up in order: `sources` → `controllers` (namespaces, OpenEBS,
cert-manager, Traefik, CloudNativePG, the backup plugin) → `secrets` →
`configs` (Postgres clusters, poolers, backups, the issuer; then
`configs-extra`, the MTA's database) → `services`
(NATS, Valkey, Restate, Zitadel) → `apps` (weldsuite), with `video`
(LiveKit) beside `apps`: a missing `livekit.` or `turn.` record holds up
calls only.

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
   `flux/clusters/<cluster>/cluster-settings.yaml` (quoted; it is 18 digits).
2. **Web application** `platform` in the project: type *User Agent*,
   authentication *PKCE*, redirect URIs on `https://app.<domain>` (the auth
   facade's callback, P4 4.F5), and **Auth token type: JWT**: the server
   verifies access tokens as JWTs against Zitadel's JWKS and never
   introspects. Its client id is `ZITADEL_WEB_CLIENT_ID`, which the server
   hands the frontends in `/config.json`. Commit the settings.
   - **2b. Native application** `mobile` in the same project, for the mobile
     apps: type *Native*, authentication *PKCE*, refresh tokens on, **Auth
     token type: JWT**, and one redirect URI per app:
     `weldagent://sso-callback`, `weldbooks://sso-callback`,
     `weldcalendar://sso-callback`, `weldchat://sso-callback`,
     `weldcrm://sso-callback`, `welddesk://sso-callback`,
     `weldflow://sso-callback`, `weldhr://sso-callback`,
     `weldmail://sso-callback`, `weldmeet://sso-callback`,
     `weldsocial://sso-callback` and `weldstash://sso-callback` (the
     route the apps already use for Clerk's SSO). Under *Token settings*
     turn on **User roles inside ID Token** and **User Info inside ID
     Token**: the apps read the workspaces and the person's name from the
     ID token and don't call userinfo. Its
     client id is `ZITADEL_MOBILE_CLIENT_ID`; until it is set the apps can't
     sign in to the cluster
     (`docs/plans/mobile-server-choice.md` in the code repo).
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
   allow users to register. People sign up there (the platform's "Sign up",
   `prompt=create`), and each workspace they create becomes an organisation
   of its own (next section).
7. **WeldSuite's own sign-in screens** (ADR SEC-016; `config.auth.oidc.signIn:
   platform` in the app's values). Zitadel stays the identity provider, but
   people see the screens Global shows, on `app.<domain>`, and the server
   signs them in as Zitadel's *login client* (`/api/sign-in`). Until the
   steps below are done Zitadel's own pages keep working, so do them on the
   test cluster first, in this order:
   1. Give the service user of step 5 the instance role `IAM_LOGIN_CLIENT`
      as well: Default settings → Administrators, click its row, tick the
      role (or `PUT /admin/v1/members/<user id>` with
      `{"roles": ["IAM_OWNER", "IAM_LOGIN_CLIENT"]}`).
      `IAM_OWNER` alone may open sessions but not finish a sign-in
      (`session.link`); the server then logs "the provider refused the
      service user" and sign-in answers 503. To keep sign-in on a user of its
      own, make a second machine user with only `IAM_LOGIN_CLIENT` and put
      its token in `weldsuite-env` as `ZITADEL_LOGIN_TOKEN`.
   2. Give every other application a login setting: open each one (the
      admin console's `admin` in the `WeldSuite Staff` organisation, and
      Zitadel's own "Management Console" in the default organisation's
      ZITADEL project), tick "Use new Login UI", leave "Custom base URL for
      the new Login UI" empty, and save. They keep Zitadel's pages under
      `/ui/v2/login`. An application left without the setting falls back to
      the old Login V1 at step 4.
   3. Application `platform`: tick "Use new Login UI" and set "Custom base
      URL for the new Login UI" to `https://app.<domain>/auth`. Nothing
      changes yet: the instance feature "Login V2" is *Enabled* (required)
      on a new v4 instance, which sends every application to Zitadel's own
      pages whatever it asks for.
   4. The switch: Default settings → Features → "Login V2" → *Disabled*
      (or `PUT /v2/features/instance` with `{"loginV2": {"required":
      false}}`). Applications now use their own setting, and Zitadel sends
      the platform's sign-in to
      `https://app.<domain>/auth/login?authRequest=…`.
   5. Check: open `https://app.<domain>` signed out. The WeldSuite sign-in
      shows; signing in lands in the workspace; switching workspace asks for
      no password; signing out and opening the platform again shows the
      sign-in. `https://auth.<domain>/ui/console` still signs in under
      `/ui/v2/login`. To go back, set "Login V2" to *Enabled* again.

   What these screens do themselves: email and password, a second factor by
   authenticator app or emailed code, sign-up with a verified address, and a
   forgotten password. For anything else (a passkey, a security key, a code
   by SMS, a forced password change, setting up a second factor the policy
   demands) they hand that one sign-in to Zitadel's page, which is why the
   `login` ingress stays. Invitations still open Zitadel's page
   (`config.identity.zitadel.inviteUrlTemplate`), and the emails for
   verifying an address and resetting a password link to the platform
   (`PLATFORM_URL`). The server counts attempts in Valkey; Zitadel's lockout
   policy (Default settings → Lockout) applies on top when it is set.

Zitadel sends those emails itself (sign-up codes, password resets,
invitations, emailed second factors), through an SMTP provider you give it
once the MTA runs: "Mail", "Zitadel's own mail". Until then sign-up stops at
the code.

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

## Staff work

Staff work in the admin console at `https://admin.<domain>` (ADR FE-018) or
with `weldsuite admin`, run in a server pod (ADR SEC-014;
`weldsuite admin --help`, and "Staff work" in `rust/README.md`). Both let in
only the cluster's staff list, master `admin_users`. The commands need the
cluster's API, which only `admin_cidrs` reach. Once per cluster, add the first
superadmin with a command (allowed without `--as` only while the staff list is
empty):

```bash
A="kubectl -n weldsuite exec deploy/weldsuite -- weldsuite admin"
$A staff add you@example.com --role superadmin --name "Your Name" --reason "first superadmin"
$A staff add colleague@example.com --role admin --as you@example.com --reason "support"
```

Then, for example, WeldReach's access requests (REACH-003; the module answers
403 until a workspace is approved):

```bash
$A access list --status requested
$A access show <workspace>               # id, slug or organization id
$A access approve <workspace> --as you@example.com --reason "B2B, own customer list"
$A access limits <workspace> --max-mailboxes 20 --as you@example.com --reason "launch"
$A access suspend <workspace> --as you@example.com --reason "complaints"
```

Every change is a row in `admin_audit_events`. Approval installs WeldReach in
the workspace and emails the requester through `SMTP_URL`, with links to
`PLATFORM_URL` (set in `flux/apps/eu/values/weldsuite.yaml`); without SMTP the
command warns and you tell them yourself. Feature flags (`feature_flag_overrides`)
and plan rows (`plans`) are the console's **Feature flags**
and **Plans** pages; the staff list is its **Staff** page too, for
superadmins.

### The admin console

The chart runs it (`admin` in `flux/apps/eu/values/weldsuite.yaml`), but it
lets nobody in until these are done, once per cluster:

1. **Zitadel.** In `https://auth.<domain>/ui/console`, an organization
   `WeldSuite Staff` for the staff's own accounts (MFA required in its login
   policy), a project `WeldSuite Staff`, and in it a web application `admin`:
   code flow, authentication method Basic (a client secret), redirect URI
   `https://admin.<domain>/auth/callback`, post-logout URI
   `https://admin.<domain>/sign-in?signed_out=1`. Keep its client id and
   secret.
2. **Secrets.** `ADMIN_OIDC_CLIENT_ID` and `ADMIN_OIDC_CLIENT_SECRET` from that
   app, plus a generated `ADMIN_SESSION_SECRET` and `OUTBOUND_ADMIN_SECRET`, in
   `weldsuite-env`:

   ```bash
   ADMIN_OIDC_CLIENT_ID=… ADMIN_OIDC_CLIENT_SECRET=… SOPS_AGE_KEY_FILE=~/<cluster>.agekey \
     node rust/deploy/flux/scripts/fill-secrets.mjs --update rust/deploy/flux/secrets/<cluster>/secrets.sops.yaml
   ```

3. **Who may reach it.** `ADMIN_CIDRS` in `flux/clusters/<cluster>/cluster-settings.yaml`:
   the staff's addresses as an unquoted YAML list (`[203.0.113.7/32]`). The
   default, `[127.0.0.1/32]`, refuses everyone; Traefik checks it with the
   client's own address, which the load balancer passes on (PROXY protocol).
4. **DNS.** `admin.` is in `tofu output dns_records`.

A person on the staff list then signs in with their Zitadel account. Their row
matches the account (`user_id`, which `staff add` fills when they also use the
platform) or, the first time, their verified email, and is then bound to that
account. `staff remove`, or `staff add` again with another `--role`, takes
effect on their next click.

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

## Releases

A cluster runs a release, never a development build. (WeldSuite's own EU
production is the exception: it follows the main builds its test cluster ran,
ADR OPS-020.) WeldSuite cuts a release with the "Rust release" workflow (`.github/workflows/rust-release.yml`)
from a build its own test cluster already ran, promoted unchanged: the four
images under the version tag (`ghcr.io/weldsuite/weldsuite:X.Y.Z`, `-sign-portal`,
`-collab-rooms`, `-haraka`; the same digests as the build), the chart of the
same commit as `oci://ghcr.io/weldsuite/releases/weldsuite` X.Y.Z (its
appVersion names those images), and the tag `weldsuite-vX.Y.Z` on that
commit. A release is never replaced: a fix is the next version.

1. **Take the release's base layers.** Merge the tag `weldsuite-vX.Y.Z` into
   your copy's branch, so the layers and `apps/eu/values/weldsuite.yaml`
   are the ones the release was tested with.
2. **Deploy it.** Set `WELDSUITE_VERSION: "X.Y.Z"` in your cluster's
   `cluster-settings.yaml` and push. Flux runs the release's migration Job
   first, then rolls the pods (step 8): `flux get helmreleases -A`.
3. **Roll back** by putting the previous version back the same way. Its
   migrations stay applied, so the older release runs on the newer schema:
   check that the release's migrations only add before rolling back.

The chart ignores values it doesn't know, so a value for a newer release can
land before it; but don't remove or rename a value until the cluster runs a
release that no longer reads it.

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

## Video (LiveKit)

WeldMeet sessions and WeldChat calls run on LiveKit in the cluster
(`flux/infrastructure/video`, the `video` layer), where Global uses
Cloudflare RealtimeKit (rust/README.md, "WeldMeet on LiveKit").

- **Where.** One pod on each of the `livekit_worker_count` general workers
  (two, one per location), on the host network, sharing those nodes with
  the weldsuite server. Rooms are routed between the two through Valkey
  (database 1). Each pod requests half a CPU and has no CPU limit, because
  throttling breaks up audio.
- **What comes in where:**

  | Traffic | Path |
  |---|---|
  | Signalling and LiveKit's API | `wss://livekit.<domain>` → load balancer → Traefik → `livekit:7880` |
  | Media | UDP 7882 on the node's public address; TCP 7881 when a network blocks UDP |
  | TURN over UDP (also the clients' STUN) | UDP 3478 on the node's public address |
  | TURN over TLS (networks that only allow 443) | `turn.<domain>:443` → load balancer → Traefik, which ends TLS → `livekit-turn:5349` |
  | Webhooks | LiveKit → `http://weldsuite.weldsuite.svc/api/webhooks/livekit` |

- **The address LiveKit advertises** is the node's first IPv4, which on
  Hetzner Cloud is its public address (`use_external_ip: false`, so LiveKit
  never asks Google's or Twilio's STUN servers). After the first start,
  check that `kubectl -n livekit logs deploy/livekit | grep -i nodeIP` shows
  the node's public IPv4 (`tofu output nodes`), not a `10.10.x.x` address.
- **A cluster built before this** gets the firewall from `tofu apply`, but
  not the label: it lives in the machine config, which OpenTofu doesn't push
  (step 3). Label the two workers once with
  `kubectl label node weldsuite-eu-worker-1 weldsuite-eu-worker-2 node.weldsuite.org/livekit=true`.
  New servers get the label from their machine config.
- **Check it** with a call between two people on different networks, then
  one from a network that only allows 443 out (TURN over TLS). Before relying
  on the capacity estimate (about 100 people in calls at once per shared
  node), load-test with `lk load-test` from the LiveKit CLI against
  `wss://livekit.<domain>`.
- **Upgrades take hours.** A stopping pod keeps its calls for up to five
  hours (`terminationGracePeriodSeconds`), and a rollout replaces one node's
  pod at a time (the new one needs the same host ports). Draining those two
  nodes for a Talos upgrade waits for their calls too, so do it at night. The
  PodDisruptionBudget keeps one pod up throughout.
- **When it outgrows the shared nodes** (around a million participant-minutes
  a month, roughly 1,000 users, or calls breaking up while the server is
  busy), move LiveKit to nodes of its own: dedicated servers or larger
  workers carrying the label and the `livekit` firewall. Flux needs no change.
- **Not on LiveKit yet:** recording and transcripts. Recording would be
  LiveKit Egress, at about 4 CPUs per concurrent recording, so it doesn't
  belong on these shared nodes.

## AI (Mistral)

Every AI feature of the EU edition runs on Mistral, in the EU (ADR AI-012,
`docs/plans/eu-ai-mistral.md`; rust/README.md, "AI"). The app's values set
`config.ai` (Mistral as the install provider, Claude and ChatGPT offered to
workspaces with their own key, the credit gate on); the search index embeds
through it with `mistral-embed`, metered as `search-index` (so
`consume.embeddings`, for installs without AI, stays unset).

- **Keys** (`weldsuite-env`): `MISTRAL_API_KEY`, from the EU edition's
  account on Mistral's La Plateforme (zero data retention, the rate-limit
  tier it was granted); `AI_KEYS_ENCRYPTION_KEY`, 64 hex characters. The
  server, `consume` and the cron jobs don't start without them. A running
  cluster adds them with

  ```bash
  MISTRAL_API_KEY=… SOPS_AGE_KEY_FILE=~/<cluster>.agekey \
    node rust/deploy/flux/scripts/fill-secrets.mjs --update rust/deploy/flux/secrets/<cluster>/secrets.sops.yaml
  ```

  (it generates `AI_KEYS_ENCRYPTION_KEY`), before Flux applies a release
  with `config.ai` set.
- **WeldSuite's own Claude and ChatGPT accounts**, once opened for the EU
  edition: add `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` to `weldsuite-env`,
  then set `weldsuiteKey: true` for that provider under `config.ai.optIn`.
  The other order stops the server: an opt-in with WeldSuite's key needs the
  key.
- **Check it**: `kubectl -n weldsuite exec deploy/weldsuite -- weldsuite doctor`
  lists each key the install holds (a model list, free) and asks the default
  chat models for one token each; `--no-model-calls` skips that.
  `/config.json` names the providers under `ai`.
- **Credits**: every call on WeldSuite's key is charged to the workspace's
  credit wallet and written to the ops ledger (`ai_provider_usage`); with
  `creditGate: true` a workspace with an empty wallet gets 402 until it tops
  up.

## Mail

The EU edition sends and receives its own mail (plan:
`docs/plans/eu-mail-service.md`; ADRs MAIL-010 and MAIL-011). No relay, no
mail provider:

| Path | What | Where |
|---|---|---|
| Out | The MTA (`weldsuite mta`, the chart's `mta`): every message the platform (pool `system`, `SMTP_URL`) and its customers (pool `customer`, `MAIL_SMTP_URL`) send, straight to the recipients' MX | Mail nodes (`mail_pools`), one DaemonSet per pool, host network, each node sending from its own IPv4 |
| Back | The MTA's bounce MX: DSNs and complaint reports (ARF) for `bounces.<domain>` | Port 25 on the mail nodes |
| In | Haraka (`mailInbound`): the MX of WeldMail mailboxes and WeldReach replies | `mx.<domain>`, port 25 on the ingress load balancer → NodePort 30025 (`mx_node_port`) |

The MTA's queue is its own database, `weldsuite_mta` on `master`
(`flux/infrastructure/configs/eu/mta-database.yaml`, role `mta`), which it
migrates at start. It runs in its own namespace, `weldsuite-mail` (Pod
Security `privileged`: the host network), with its keys in the
`weldsuite-mta` Secret there; the server reads the API secret and the
submission passwords from `weldsuite/weldsuite-mta-client`. Its delivery
events reach `weldsuite consume` over NATS (`mail.sending-events`), with
`NATS_URL` and `NATS_TOKEN` in `weldsuite-mta` too (the MTA can't read
`weldsuite-env`); without them they stay in its outbox (`pendingEvents` in
`$M queue`). On a running cluster: `fill-secrets.mjs --update --only
weldsuite-mail/weldsuite-mta` copies them from `weldsuite-env`.

Nothing below is optional: a new address that sends without its DNS in
place, or too much on its first days, lands in spam folders for weeks.

### 1. Outbound port 25

Hetzner blocks outbound ports 25 and 465 on every new Cloud project. The
unblock is a request to Hetzner support, possible **once the project's first
invoice is paid**, one request per project (it covers all its servers, now
and later). In the Cloud Console's support/limit request form, name the
project and say what the mail is: transactional and user-written mail of a
business platform, sent by our own MTA from dedicated servers, with SPF, DKIM
and DMARC, bounce and complaint processing, suppression of hard bounces and
complaints, and a warm-up. Inbound 25 (the bounce MX, Haraka) is not blocked.

Check from a mail node once it is granted (a debug pod shares the node's
network):

```bash
kubectl debug node/weldsuite-eu-mail-system-1 -it --image=busybox:1.37 -- \
  nc -w 5 gmail-smtp-in.l.google.com 25     # a 220 banner, not a timeout
```

### 2. Mail nodes, addresses, reverse DNS

`mail_pools` in `terraform.tfvars` (one `system` and one `customer` node to
start), then `tofu apply`. Each node gets a **primary IPv4**, which outlives
the server (rebuilding a node keeps the address and its reputation; `tofu
destroy` still deletes it), its **PTR** `mail<n>-<pool>.<domain>`, the mail
firewall (inbound TCP 25; submission 2587 and the MTA's API 8025 listen on
the private address only), the label `weldsuite.org/mail-pool=<pool>` and
the taint `weldsuite.org/mail` (nothing else runs there). Port 25 is
unprivileged in the host network on these nodes only (`talos/mail.yaml`), as
the MTA runs as a non-root user.

```bash
tofu output mail_nodes        # name, pool, location, IPv4 of each
tofu output mail_dns_records  # the A records and _spf.<domain>
dig -x <ipv4> +short          # mail1-system.<domain>.
```

The MTA's EHLO is that PTR name. More nodes for a pool (`count`) is another
`tofu apply`; the chart's DaemonSet starts on them, and their addresses join
`_spf.<domain>` (`tofu output mail_dns_records` again) **before** they send.

**Or on nodes the cluster already has.** `mail_pool_nodes` puts a pool on an
existing node instead of a server of its own (`{ system = "worker-1",
customer = "worker-2" }`): the node sends from its own IPv4, which gets the
PTR `mail1-<pool>.<domain>`, and gets the mail firewall and the
`weldsuite.org/mail-pool` label, but not the taint, so its other workloads
stay. Only nodes without a taint qualify, as the MTA's DaemonSet tolerates
the mail taint alone: general workers, or control-plane nodes on a cluster
without general workers (`worker_count = 0`, where they take the workloads
and have no taint), never the Postgres nodes. A plan with a tainted node
stops with an error. No extra server or address; the costs are that the pool's address is
the node's (a replaced node comes back with a new address and warms up
again) and that everything else on the node leaves through it too. The
node's machine config gains the label and the port 25 setting; on a running
node apply them with `talosctl patch machineconfig` (OpenTofu ignores
`user_data` after creation):

```yaml
machine:
  sysctls:
    net.ipv4.ip_unprivileged_port_start: "25"
---
apiVersion: v1alpha1
kind: KubeNodeConfig
labels:
  weldsuite.org/mail-pool: system
```

### 3. DNS

With `<domain>` the EU domain, `bounces.<domain>` the bounce domain
(`mta.bounceDomain`) and the **system domain** the domain of the platform's
sender (`config.mail.from`; the chart's default is
`notifications@mail.weldsuite.org`, set it to an address at the EU domain to
send from there):

| Name | Type | Value |
|---|---|---|
| `mail<n>-<pool>.<domain>` | A | the node's IPv4 (`mail_dns_records`); its PTR is OpenTofu's |
| `mail<n>-<pool>.<domain>` | TXT | `v=spf1 a -all` (the EHLO name's own SPF) |
| `_spf.<domain>` | TXT | `v=spf1 ip4:<each mail IPv4> -all` (`mail_dns_records`) |
| `bounces.<domain>` | MX | `10 mail<n>-<pool>.<domain>`, one per mail node |
| `bounces.<domain>` | TXT | `v=spf1 include:_spf.<domain> -all` |
| system domain | TXT | `v=spf1 include:_spf.<domain> -all` |
| `<selector>._domainkey.<system domain>` | TXT | what `weldsuite mta domains add` prints (below) |
| `_dmarc.<system domain>` | TXT | `v=DMARC1; p=none; rua=mailto:<an address you read>` first; `p=quarantine`, then `p=reject`, once the reports show only your own mail passing |
| `mx.<domain>` | A, AAAA | the ingress load balancer (`dns_records`) |

The system domain's DKIM key is the MTA's; register it once the MTA runs,
for the `system` pool only:

```bash
M="kubectl -n weldsuite-mail exec ds/weldsuite-mta-system -- weldsuite mta"
$M domains add mail.<domain> --pool system   # prints the TXT record to publish
$M domains list
```

Customers' sending domains are registered by the server (the mail domain
routes, `MTA_API_URL`) for the `customer` pool; their DNS needs that DKIM
record and `include:_spf.<domain>` in their SPF. Until a domain has a key
the pool can use, submission refuses its mail (`550 5.7.1`).

**Free addresses** (`config.mail.freeAddressDomain`, `weldmail.eu` on the EU
edition; ADR MAIL-012) are `<name>@<workspace slug>.<free domain>`. Register
the free domain once for the `customer` pool; the MTA signs every workspace
subdomain with its key (`d=<free domain>`, which DMARC's relaxed alignment
accepts), so a new workspace needs no DNS of its own:

```bash
M="kubectl -n weldsuite-mail exec ds/weldsuite-mta-customer -- weldsuite mta"
$M domains add <free domain> --pool customer   # prints the TXT record to publish
```

| Name | Type | Value |
|---|---|---|
| `*.<free domain>` | MX | `10 mx.<domain>` |
| `*.<free domain>` | TXT | `v=spf1 include:_spf.<domain> -all` |
| `<selector>._domainkey.<free domain>` | TXT | what `weldsuite mta domains add` printed |
| `_dmarc.<free domain>` | TXT | `v=DMARC1; p=none; sp=none; rua=mailto:<an address you read>`, tightened as for the system domain |

Never `weldmail.com` or `weldmail.org`: they are Global's, and the server
refuses to start with them.

Check with a message to a Gmail and an Outlook address ("Show original":
SPF, DKIM and DMARC `pass`, the PTR name in the first `Received`) and with
mail-tester.com.

### 4. Warm-up

Receivers trust an address by its history, and a new one has none. The MTA
caps each address's deliveries per day (`MTA_WARMUP_SCHEDULE`, default 50,
100, 200, 400, 800, 1,500, 3,000, 6,000, 12,000, 25,000, 50,000 on days 1 to
11, unlimited after); what is over the cap waits in the queue, it is not
lost, but it still bounces after `mta.maxQueueAge` (5 days). So:

- Send the platform's own mail (the `system` pool) first; move customer
  mail over as the `customer` addresses warm up. Expect some deferrals
  (421/451 from Microsoft and Yahoo) the first week: the MTA retries.
- Keep complaints under 0.1% (Gmail's and Yahoo's sender rules refuse bulk
  mail above 0.3%) and hard bounces low: the MTA suppresses a hard-bounced
  recipient per pool for `mta.suppressDays` (30).
- Watch the queue: `$M queue` (counts by pool and status). A growing
  `deferred` count on day one is the cap, not a fault.
- A new address (a node added, a primary IP replaced) starts again at day
  one. An address with history can skip it: `mta.warmupSchedule: "off"`.

### 5. Postmaster tools and feedback loops

Complaint reports go to `fbl@bounces.<domain>`, which the bounce MX takes
and turns into `complained` events (as `abuse@` and `postmaster@`).

- **Google Postmaster Tools** (postmaster.google.com): add the system domain
  and `bounces.<domain>`, verified by a TXT record. Gmail sends no complaint
  reports; it shows spam rate, reputation and authentication per domain,
  and per `Feedback-ID` (the MTA sets `<pool>:weldsuite`).
- **Microsoft SNDS** (sendersupport.olc.protection.outlook.com/snds): request
  access for each mail IPv4 (confirmed by mail to an address at the PTR's
  domain, e.g. `postmaster@<domain>`), then enroll the same addresses in
  **JMRP** (the Junk Mail Reporting Program) with `fbl@bounces.<domain>` as
  the report address. A blocked address is delisted through Microsoft's
  sender support form.
- **Yahoo Complaint Feedback Loop** (senders.yahooinc.com): register the
  DKIM domains (the system domain, then the larger customer domains) with
  `fbl@bounces.<domain>` as the report address; Yahoo matches complaints by
  DKIM domain, not by IP.

### 6. Blocklists

Check every mail IPv4 before it sends for the first time and weekly after:
Spamhaus (check.spamhaus.org), Barracuda, SpamCop, and a multi-list lookup
(multirbl.valli.org, MXToolbox). Hetzner Cloud ranges sometimes carry old
listings; a listed fresh address is cheaper to replace than to delist,
before it has sent anything: replace the address and the node together
(`tofu apply -replace='hcloud_primary_ip.mail["mail-system-1"]'
-replace='hcloud_server.mail["mail-system-1"]'`; the PTR follows), then
update its A record and `_spf.<domain>`. Spamhaus refuses lookups through
public resolvers (the nodes use Quad9), so check from its website, not with
`dig` on a node.

### Zitadel's own mail

Zitadel sends sign-up codes, password resets, invitations and emailed second
factors itself. Without an active SMTP provider it logs
`Errors.SMTPConfig.NotFound` and sends nothing. Give it the MTA's `system`
pool once the system domain has its key (step 3): in the console, Default
settings → SMTP provider → Generic SMTP.

| Field | Value |
|---|---|
| Host and port | `weldsuite-mta.weldsuite-mail.svc.cluster.local:587`, the submission Service |
| TLS | off: submission has no STARTTLS unless `mta.submission.tls` is on, and the connection stays in the cluster |
| User | `system` |
| Password | `MTA_SUBMISSION_PASSWORD_SYSTEM` from the Secret `weldsuite-mail/weldsuite-mta` |
| Sender | the platform's sender (`config.mail.from`, e.g. `notifications@mail.<domain>`): the MTA refuses a sender whose domain has no key for the pool (`550 5.7.1`) |

Then **Test** with an address of your own and **Activate**. The admin API
does the same with an `IAM_OWNER` token: the chart's machine user
`iam-admin`, whose PAT Zitadel's first start writes to the Secret
`zitadel/iam-admin-pat` (the chart's default
`FirstInstance.Org.Machine`), or the service user's from step 7.5
(`ZITADEL_SERVICE_TOKEN` in `weldsuite-env`). `POST /admin/v1/email/smtp` with
`senderAddress`, `senderName`, `tls`, `host`, `user` and `password`, then
`POST /admin/v1/email/smtp/_test` with the same settings, `id` and
`receiverAddress`, and `POST /admin/v1/email/<id>/_activate`. (Zitadel v4.19
answers `/admin/v1/email/smtp/<id>/_test` with "not implemented".)

Zitadel keeps the provider and its copy of the password in its own database,
not in the chart's values: set it again after rotating
`MTA_SUBMISSION_PASSWORD_SYSTEM`, with `PUT /admin/v1/email/smtp/<id>/password`
(or the console's password field alone). Don't send the password in the same
update as the other settings: v4.19's projection then sets the column twice
("multiple assignments to same column password") and holds back every later
change, the activation included, until it gives up on that event after five
failures. Its mail counts against the system
address's warm-up cap (step 4), and a code that waits a day in the queue is
no use, so don't send a large batch of invitations in the first week.

### Inbound: Haraka

`mx_node_port = 30025` in `terraform.tfvars` makes the ingress load balancer
pass port 25 to Haraka's NodePort with the PROXY protocol; `mx.<domain>`
points at the load balancer, so cert-manager's HTTP-01 issues Haraka's
certificate through Traefik. It needs the mail bucket
(`FILES_BUCKET_MAIL`, created next to the private one, same keys) and
`MAIL_INBOUND_SECRET` in `weldsuite-env`. A WeldMail domain's MX is
`mx.<domain>`.

## Monitoring, alerts and logs

Three layers (`flux/infrastructure/monitoring`, `monitoring-config`,
`logging`; ADR OPS-021): Prometheus, Alertmanager and Grafana, what they
scrape, probe and alert on, and Loki with Fluent Bit. What each alert means
and what to check first: `flux/infrastructure/monitoring-config/ALERTS.md`.

1. **Settings** (`cluster-settings.yaml`): `ZITADEL_STAFF_ORG_DOMAIN`, the
   primary domain of the Zitadel organisation whose users may open Grafana; `LOGS_S3_ENDPOINT`
   (a host name, no `https://`), `LOGS_S3_REGION` and `LOGS_BUCKET` for
   Loki. Give the bucket a lifecycle rule that deletes after 31 days (Loki
   deletes after 30) and a key limited to it.
2. **Grafana's sign-in.** In Zitadel's console, in the project of the
   organisation whose users sign in (WeldSuite's clusters: `WeldSuite Staff`,
   next to the admin console's app): a web application "Grafana" (code flow, PKCE, redirect
   `https://grafana.<domain>/login/generic_oauth`), with "User roles inside
   ID Token" and "User Info inside ID Token" on, the project's "Assert Roles on Authentication" on, and a
   role `grafana-admin` granted to whoever administers Grafana. Everyone
   else in the organisation gets Viewer; nobody outside it gets in. Tick
   "Use new Login UI" and leave its base URL empty, like the admin console's
   app ("Give every other application a login setting", section 7): without it Grafana's sign-in goes to the old
   Login V1, which refuses a security key or passkey registered on the new
   pages (`Errors.User.WebAuthN.BeginLoginFailed`, "Found no credentials for
   user" in Zitadel's log).
3. **Where alerts go.** The Secret `monitoring/alerting-receivers` holds three
   URLs by role and a token: `critical-url` (pages at any hour),
   `warning-url` (muted at night), `heartbeat-url` (pinged every minute by
   the always-firing Watchdog; a dead-man's switch such as a healthchecks.io
   check behind it alarms when the pings stop, which covers the cluster or
   its monitoring going away) and `token` (sent as a bearer token to the
   first two). For ntfy topics, `flux/scripts/ntfy-receiver-url.mjs`
   prints a URL with ntfy's message template. Any webhook works.
4. **Secrets**: `alerting-receivers`, `grafana-oidc` (the app's client id
   and secret), `grafana-admin` (the break-glass login) and `logging/loki-s3`.
   `fill-secrets.mjs --update` adds them (`ALERT_*`, `GRAFANA_OIDC_*` and
   `LOGS_S3_*` in the environment).
5. **DNS**: `grafana.<domain>` (step 5).
6. **Layers**: `monitoring`, `monitoring-config` and `logging`, as in
   `flux/clusters/example/layers.yaml`.
7. **etcd and Talos's logs.** The Talos config (`hetzner/talos`) opens
   etcd's metrics on each control-plane node's private address and sends
   Talos's own logs to the node's Fluent Bit. Applying it to a running
   cluster restarts etcd on each control-plane node: `tofu apply
   -parallelism=1`, so they restart one at a time. Then patch the
   `monitoring` layer with the control-plane addresses:

   ```yaml
   - target:
       kind: HelmRelease
       name: kube-prometheus-stack
     patch: |
       apiVersion: helm.toolkit.fluxcd.io/v2
       kind: HelmRelease
       metadata:
         name: kube-prometheus-stack
       spec:
         values:
           kubeEtcd:
             enabled: true
             endpoints: [10.10.1.10, 10.10.1.11, 10.10.1.12]
           defaultRules:
             rules:
               etcd: true
   ```

Then, before relying on it, fire each critical alert once on purpose and
see it arrive (ALERTS.md, "Testing the alerts").

## Backups and restores

Every Postgres cluster archives WAL continuously and takes a nightly base
backup to the second provider (`postgres/*-backups` ObjectStores, 30 days).
Restore a cluster into a new `Cluster` with `bootstrap.recovery` from the
ObjectStore: a patch on the `configs` layer in your cluster's `layers.yaml`,
per Postgres cluster, that turns `initdb` off, recovers from the backups'
ObjectStore and `serverName`, and archives its own WAL under a new
`serverName` (or another ObjectStore), since barman refuses to archive into
a path that holds another server's WAL. For `master`:

```yaml
    - target:
        kind: Cluster
        name: master
      patch: |-
        apiVersion: postgresql.cnpg.io/v1
        kind: Cluster
        metadata:
          name: master
        spec:
          bootstrap:
            initdb: null
            recovery:
              source: previous
          externalClusters:
            - name: previous
              plugin:
                name: barman-cloud.cloudnative-pg.io
                parameters:
                  barmanObjectName: master-backups
                  serverName: master
          plugins:
            - name: barman-cloud.cloudnative-pg.io
              isWALArchiver: true
              parameters:
                barmanObjectName: master-backups
                serverName: master-2
```

The bootstrap only matters when the `Cluster` is created. Practise it: build
a throwaway cluster from the backups now and then, check the data, and tear
it down (WeldSuite does this monthly).

## Cost

Estimates at Hetzner list prices: the default topology ≈ €310/month, ten
times its load ≈ €1,300/month.

LiveKit adds no servers at launch: it runs on two of the general workers. If
those two need more CPU, making them `cpx42` instead of `cpx32` costs about
€70/month more. Traffic stays within what the servers include (20 TB a month
each): a participant in a video call sends out about 9 MB a minute, so half a
million participant-minutes a month is about 4.5 TB.

Mail adds a small server per mail node (`cpx22` by default, one per pool to
start) and a primary IPv4 each; Haraka and the MTA's database run on what is
already there.

## Not yet: what's missing before production

Be clear about this before anyone signs a contract:

- **Modules.** The Rust backend serves what is marked ported
  (`RUST_PORTED_MODULES` in `packages/core/api-modules`): the core platform
  (team and settings, files and drive, search, custom objects, WeldApps,
  notifications, audit logs, API keys, credits, onboarding), WeldKnow,
  WeldSign, WeldPass, the calendar, CRM, Flow, Mail, Chat, Desk, Stash, Ads,
  Social, Data, Commerce, HR, Call (on Telnyx), Host, Meet, Reach, Books,
  Docs, Panel, Sheets and Connect. Also external-api's `/v1` (not yet its
  mail, custom-object and WeldReach groups), the MCP server at `/mcp`,
  personal-api at `/personal-api` (with `DATABASE_URL_PERSONAL`) and the
  integration workers' webhooks and jobs. Not WeldAgent: there is no AI on
  this edition until there is an EU AI provider (ADR AI-011), and the other
  modules' AI features are listed unavailable. Docs and Sheets need the
  collab-rooms sidecar (`collabRooms`, ADR OPS-016). `/config.json` lists
  the offered modules, and the platform hides the rest (work package 4.F3).
- **Sign-in.** The server verifies Zitadel's tokens (`AUTH_PROVIDER=oidc`,
  step 7) and the platform signs in through Zitadel with its auth facade
  (OIDC with PKCE, from `/config.json`), on WeldSuite's own sign-in screens
  once step 7.7 is done. Invitations and member changes go
  through the Zitadel identity adapter; the identity sync (above) catches up
  on changes made in Zitadel within about a minute. No SAML connections
  (`sso-connections` is listed as unavailable).
- **Workspace lifecycle.** Signup, onboarding, provisioning, the identity
  sync and the deletion sweeps run (above). Not on this cluster: sample
  data and the default helpdesk workflows (their seeders aren't ported), the
  WeldMail domain of a new workspace, Stripe, and a reseller's entry point
  (partner onboarding runs on Global; only the provisioning job knows a
  partner workspace).
- **Frontends.** The server serves the platform SPA from its image at
  `app.<domain>` (built with `VITE_RUNTIME_CONFIG=on`: it reads
  `/config.json` and calls the API on its own origin). The sign portal runs
  at `sign.<domain>` and calls the server's `/public/sign-portal/*` with the
  shared `SIGN_PORTAL_SECRET` (ADR FE-017); the server needs
  `SIGN_SESSION_SECRET` for signer sessions. `/config.json` carries the
  public settings in `config.publicEnv` (Mapbox, the portal URLs) and lists
  the `unavailableFeatures` the platform hides (billing, credit top-up,
  paid apps, desktop sign-in, analytics, the search reindex). Not here yet:
  the help center and a CDN (Bunny.net) in front of `app.<domain>`.
- **Billing.** Mollie for the EU edition (P5, needs a BILL ADR). No billing
  runs here.
- **Other EU services** in the design: mail goes out through the cluster's
  own MTA (`mta`, ADR MAIL-011), system mail (`SMTP_URL`) and customer mail
  (`MAIL_SMTP_URL`) from separate IP pools, and comes in through the Haraka
  MX for WeldMail mailboxes and WeldReach replies (`mailInbound`, ADR
  MAIL-010), whose image the "Rust images" workflow publishes with the
  others; the EU values turn both on ("Mail" above). Neither sends a byte
  before the port 25 unblock, the DNS records and the warm-up. Not yet: IPv6
  sending, DANE, a queue admin UI. WeldMeet
  and WeldChat calls run on the in-cluster LiveKit (`config.video`, ADR
  MEET-007; "Video" above), without recording and transcripts. The
  semantic search index embeds on Mistral through `config.ai` ("AI (Mistral)"
  above).
- **Operations** (P5): the EU registry and signed images (5.4), observability
  and alerting (5.5), the drill runner (5.6), DNS failover between locations,
  object storage replication, HA for Valkey (Sentinel or replicas) and a
  three-node Restate cluster.
