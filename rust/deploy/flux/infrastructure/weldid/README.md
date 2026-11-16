# WeldID (opt-in)

WeldID is WeldSuite's own OpenID Connect provider, and replaces Zitadel on
the Kubernetes editions (ADR SEC-019, plan `plans/weldid-auth-server.md` in
weldsuite-documentation). The code, chart and install guide live in
[weldsuite/weldid](https://github.com/weldsuite/weldid) (`deploy/helm/weldid`,
`docs/deploy.md`). This layer runs it in the cluster: namespace `weldid`,
host `auth.<domain>` (Zitadel's today), its own CloudNativePG cluster.

**Nothing here runs anywhere until a cluster lists it.** The example cluster
doesn't. Clusters without WeldID keep Zitadel and see no change: the base
HelmReleases only gained `optional` `valuesFrom` entries for ConfigMaps that
only the switch layer makes.

| Piece | Path | Flux Kustomization (clusters/example) |
|---|---|---|
| The namespace (restricted) | `namespace/` | `weldid-namespace` (`weldid.yaml`) |
| WeldID's Secrets (SOPS) | `secrets/<cluster>/weldid/` | `weldid-secrets` (`weldid.yaml`) |
| Chart source, release and values, `weldid-db` with backups, the `auth.` certificate, monitors and alerts | here | `weldid` (`weldid.yaml`) |
| The switch: platform, admin console and Grafana on WeldID; WeldID on `auth.`, Zitadel off it | `../../apps/weldid-switch/` | `weldid-switch` (`weldid-switch.yaml`) |

The namespace is a layer of its own because WeldID's Secrets go into it
before the layer that uses them, and the cluster's main `secrets` layer
can't put them there on a cluster without WeldID. Turning the layers off
never deletes the namespace, `weldid-db` or its backups (Flux's prune is off
for them): delete those by hand.

## Turning it on

WeldID then runs next to Zitadel, in the cluster only: its Ingress stays off
while Zitadel serves `auth.<domain>`. Nobody signs in through it yet.

1. **Settings** (`clusters/<cluster>/cluster-settings.yaml`):
   `WELDID_VERSION` (the chart release), `WELDID_RP_ID` (see the warning
   below), and `WELDID_BACKEND_KEY_X` / `_Y` from step 2.
   `WELDID_MAIL_FROM` only if the platform sends from another address than
   the chart's `notifications@mail.weldsuite.org`.
2. **Secrets**, next to the cluster's other secrets:

   ```bash
   SOPS_AGE_KEY_FILE=~/<cluster>.agekey node rust/deploy/flux/scripts/fill-secrets.mjs \
     --weldid --main rust/deploy/flux/secrets/<cluster>/secrets.sops.yaml \
     rust/deploy/flux/secrets/<cluster>/weldid/weldid.sops.yaml
   sops --encrypt --in-place rust/deploy/flux/secrets/<cluster>/weldid/weldid.sops.yaml
   ```

   It prints `WELDID_BACKEND_KEY_X` and `_Y` (step 1). Copy
   `secrets/example/weldid/kustomization.yaml` there and list the file in
   it. Put `WELDID_MASTER_KEY` in the password manager.
3. **Image pull.** `ghcr.io/weldsuite/weldid` and its chart are private
   until WeldID 1.0. The `weldid/registry` Secret takes the same login as
   `weldsuite/registry` (the script copies it), so that account must be able
   to read the weldid packages: give its token `read:packages` and the
   account access to the packages (each package's settings on GitHub,
   "Manage access"). Or make both packages public, then delete the Secret
   and the `secretRef` in `source.yaml`.
4. **Layers.** Copy `clusters/example/weldid.yaml` (change the secrets path
   that names `example`) and list it in the cluster's `kustomization.yaml`.
   The first install takes a few minutes: the migration Job waits for
   `weldid-db`. Check it:

   ```bash
   kubectl -n weldid get pods,certificate
   kubectl -n weldid port-forward svc/weldid 8080 9090
   curl -s localhost:9090/readyz                       # database: ok, keys: ok
   curl -s -H 'Host: auth.<domain>' localhost:8080/.well-known/openid-configuration
   ```

5. **Staff** for the admin console and Grafana, on the staff issuer (MFA
   required): `kubectl -n weldid exec deploy/weldid -- weldid admin staff add
   --config /etc/weldid/weldid.toml --email you@example.com --name "…"
   --roles grafana-admin`. They set a password at `https://auth.<domain>/staff/forgot`
   once WeldID is on the host. The admin console still lets in only the
   `admin_users` roster.

> **`WELDID_RP_ID` can never change after WeldID's first start.** Every
> passkey is bound to it; changing it breaks every passkey of every user,
> with no way to move them. Use the cluster's `DOMAIN` (a parent of
> `auth.<domain>`), decide before step 4, and never edit it afterwards. The
> chart refuses an upgrade that changes it on a running install.

## Switching

All at once and reversibly, once WeldID is ready:

1. `weldsuite-env`: `ADMIN_OIDC_CLIENT_ID` becomes `weldsuite-admin`
   (`sops edit` the cluster's secrets file). Its secret stays: WeldID has the
   same one (step 2 copied it). Grafana keeps `grafana-oidc` as is: the
   switch sets its client id. The staff roster's rows are bound to their
   Zitadel accounts (`admin_users.console_subject`), which no WeldID account
   matches; unbind them, so each binds to its WeldID staff account by email
   at the next console sign-in (there is no `weldsuite admin` command for
   it yet):
   `kubectl cnpg psql master -n postgres -- -d weldsuite_master -c "update admin_users set console_subject = null"`.
2. `AUTH_PROBE_PATH: /.well-known/openid-configuration` in the cluster's
   settings, so the `auth.` probe asks WeldID, not Zitadel's
   `/debug/healthz`.
3. Copy `clusters/example/weldid-switch.yaml` and list it. The
   `weldid-switch` layer makes four ConfigMaps that the releases already
   list as optional values: WeldID's Ingress on (with the certificate it
   already has), Zitadel's two Ingresses off, the weldsuite release on
   WeldID (issuer `https://auth.<domain>`, audience `weldsuite-api`,
   workspace from the `X-Weld-Workspace` header, WeldID's own sign-in
   screens, clients `weldsuite-web`, `weldsuite-mobile` and
   `weldsuite-desktop`, the admin API
   at `http://weldid.weldid.svc:8080` as `weldsuite-backend` with
   `WELDID_CLIENT_KEY` from `weldsuite/weldid-client`, the admin console on
   `https://auth.<domain>/staff` without `ADMIN_OIDC_ORG_ID`), and Grafana
   on the staff issuer with Admin for the `grafana-admin` role.
4. Check: sign up on `https://app.<domain>`, make a workspace, invite
   someone; the admin console and Grafana with a staff account;
   `kubectl -n weldsuite logs deploy/weldsuite | grep -i weldid` for the
   identity sync.

Back to Zitadel: unlist `weldid-switch.yaml`, put `ADMIN_OIDC_CLIENT_ID` and
`AUTH_PROBE_PATH` back.

5. **Removing Zitadel** comes after (on EU test right after the switch;
   production keeps it until WeldID 1.0, plan phase 6): its HelmRelease,
   values and source, `zitadel-db` with its backups, its Secrets, its
   namespace, its monitors and alert expressions, the `ZITADEL_*` settings,
   and `ZITADEL_SERVICE_TOKEN`. In the base layers once WeldID is the
   default; until then on one cluster with `$patch: delete` patches in its
   layers and the rest by hand.

## Secrets

`secrets/examples/weldid.example.yaml` lists them; `fill-secrets.mjs
--weldid` writes them. Where each value comes from:

| Secret | Key | Value |
|---|---|---|
| `weldid/weldid-env` | `WELDID_DATABASE_URL` | generated: the `weldid` role on `weldid-db-rw` |
| | `WELDID_MASTER_KEY` | generated: 32 random bytes, base64. Seals the signing keys; never replace it |
| | `WELDID_SMTP_URL` | the MTA's system pool, `MTA_SUBMISSION_PASSWORD_SYSTEM` of `weldsuite-mail/weldsuite-mta`, `?tls=none` (in the cluster) |
| | `WELDID_VALKEY_URL` | Valkey's password, `weldsuite/valkey-users` |
| | `WELDID_CLIENT_SECRET_WELDSUITE_ADMIN` | `ADMIN_OIDC_CLIENT_SECRET` of `weldsuite/weldsuite-env` |
| | `WELDID_CLIENT_SECRET_GRAFANA` | `GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET` of `monitoring/grafana-oidc` |
| `weldid/weldid-db-owner` | `username`, `password` | `weldid` and the database password above |
| `weldid/postgres-backup-s3` | `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY` | the backup bucket's keys, as `postgres/postgres-backup-s3` |
| `weldid/registry` | `.dockerconfigjson` | the ghcr.io login of `weldsuite/registry` (step 3) |
| `weldsuite/weldid-client` | `WELDID_CLIENT_KEY` | generated: the server's P-256 private key (PKCS#8 PEM) for WeldID's admin API (client `weldsuite-backend`, `private_key_jwt`) |

**The admin API key's public half** is not a secret: WeldID's values render
it into the `weldsuite-backend` client's `jwks` from the cluster settings
`WELDID_BACKEND_KEY_X` and `_Y` (base64url coordinates of the P-256 key,
`kid` `weldsuite-backend-1`). The script prints them when it makes the key,
and again on every `--update`; by hand:
`node -e "console.log(require('crypto').createPublicKey(require('fs').readFileSync('key.pem')).export({format:'jwk'}))"`.
Empty or wrong, WeldID starts but refuses the server's admin API calls. To
rotate, add a second key (`weldsuite-backend-2`) to the client in a patch,
switch `WELDID_CLIENT_KEY`, then remove the first.

> **External Secrets (ADR OPS-023).** The migration of the cluster's Secrets
> off SOPS to the OpenBao store, in flight, must carry these five Secrets
> too: new store entries for WeldID's own values (`WELDID_MASTER_KEY`, the
> database password, the PEM key), ExternalSecrets for `weldid-env`,
> `weldid-db-owner`, `postgres-backup-s3` and `registry` in `weldid` and
> `weldid-client` in `weldsuite` (templated from the shared entries above,
> so each shared value keeps one source), and `weldid` in the
> ClusterSecretStore's allowed namespaces. The weldid repository's
> `docs/deploy.md` ("Install with Flux") sketches them.

## Monitoring

`monitoring.yaml`: a PodMonitor for `weldid-db` (so the Postgres alerts
cover it), and the alerts `WeldIDDown`, `WeldIDNotReady`,
`WeldIDSignInFailures`, `WeldIDRateLimited`, `WeldIDKeyRotationOverdue`,
`WeldIDKeyMetricsMissing` and `PostgresInstanceDown` for `weldid-db`
(`../monitoring-config/ALERTS.md`, "WeldID"). The server's own `/metrics`
is the chart's ServiceMonitor. Key rotation is watched from the database: a
CloudNativePG custom query on `signing_keys` (`database.yaml`).
