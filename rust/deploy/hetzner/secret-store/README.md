# A cluster's secret store: OpenBao on Hetzner

Every value a cluster's Secrets are made from lives here, outside the cluster
and outside git. The cluster's External Secrets Operator reads them over the
Vault API (KV version 2, mount `secret`): the cluster's `SECRET_STORE_URL` is
`https://<hostname>` and its one hand-made Secret is a read-only token
(step 3). [OpenBao](https://openbao.org) is the open-source fork of Vault and
speaks the same API, so any tool that talks to Vault talks to this.

One store per cluster (test and production apart), one small server each,
with a state of its own: a cluster's `tofu destroy` (the monthly drill) never
reaches it, and while it is down or sealed the cluster keeps every Secret it
has and only stops refreshing them. About €6 a month with Hetzner's backups
(`cpx02`, 1 vCPU and 1 GB, in `hel1`, November 2026).

## How it fits

```
cluster: External Secrets Operator ──HTTPS──▶ Caddy :443 (Let's Encrypt) ──▶ OpenBao 127.0.0.1:8200
operator: seed script, bao CLI ─────HTTPS──▶      │                           Raft on the server's disk
                                                  └─ narrows by address:      ↓ daily
                                                                              snapshot ─▶ bucket at another provider
```

| From | Gets through Caddy |
|---|---|
| `admin_cidrs` | the whole API: writes, tokens, snapshots, unsealing |
| anywhere else (the cluster) | `GET` a value (`/v1/secret/data/…`), the caller's own token (`/v1/auth/token/lookup-self`), `/v1/sys/health`; everything else is 403 |

OpenBao's policies apply on top (`policies/`): a cluster token reads values
and nothing else, whatever Caddy lets through.

| Credential | Where it lives | Lifetime |
|---|---|---|
| 3 unseal keys (2 unseal) | password manager, separate entries | until rekeyed |
| root token | revoked at the end of step 2; made again from the unseal keys when needed ("Root token") | minutes |
| operator token (`operator` policy) | password manager | 1 year, renewable |
| cluster token (`cluster` role, read-only) | the cluster's `external-secrets/secret-store-token` | 10 years |
| snapshot token (`snapshot` role) | `/etc/secret-store/snapshot.env` on the server | renewed by every run |

## 1. Create

A tfvars file per store, outside git (WeldSuite's: `eu/hetzner/` in the
deploy repository); `terraform.tfvars.example` lists what it takes.

```bash
cd rust/deploy/hetzner/secret-store
export TF_VAR_hcloud_token=…   # the project's read/write token
tofu init
tofu apply -var-file=/abs/path/to/secret-store-<cluster>.tfvars
tofu output dns_records
```

Add the A and AAAA records it prints. Caddy asks Let's Encrypt for the
certificate once the name resolves, and retries until then. Done when this
answers `501` (not initialised):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/v1/sys/health
```

The state holds no secret, but it is the only easy way to change the
firewall: keep it like the cluster's (`../README.md`, step 3). The server
has Hetzner's delete and rebuild protection and `prevent_destroy`; turn both
off on purpose before removing it.

## 2. First start

On the server (`ssh root@<hostname>`; `BAO_ADDR` is already set there):

```bash
bao operator init -key-shares=3 -key-threshold=2
```

Put the three unseal keys and the root token in the password manager now:
they are shown once, and without two of the keys nothing in the store can be
read again, by anyone. Then:

```bash
bao operator unseal              # twice, with two different keys
read -rs BAO_TOKEN; export BAO_TOKEN   # paste the root token
bao-configure                    # the KV mount, policies and token roles
bao token create -policy=operator -orphan -ttl=8760h -display-name=operator -field=token
bao token revoke -self           # the root token is done
```

The operator token goes in the password manager. `bao-configure` can run
again at any time (after a change to `policies/`, copied to
`/etc/secret-store/policies/`); it needs a root token.

## 3. The cluster's token

```bash
read -rs BAO_TOKEN; export BAO_TOKEN   # the operator token
bao token create -role=cluster -ttl=87600h -display-name=<cluster> -field=token
```

Give it to the cluster, the one Secret put in by hand, before Flux starts:

```bash
kubectl --context <ctx> create namespace external-secrets
kubectl --context <ctx> -n external-secrets create secret generic secret-store-token --from-literal=token=<the token>
```

To make cluster tokens that only work from the cluster's own addresses, run
`bao-configure` with `CLUSTER_TOKEN_CIDRS=<node addresses, comma-separated>`
before creating one. A node with a new address then needs a new token, so
this is off by default.

## 4. Filling it

From an `admin_cidrs` address, with the operator token as the token that may
write: the secrets layer's seed script writes every value the cluster's
ExternalSecrets read. By hand, from the server or with the `bao` CLI and
`BAO_ADDR=https://<hostname>`:

```bash
bao kv get secret/weldsuite/server
bao kv patch secret/weldsuite/server SOME_KEY=…
```

## Backups

Two layers. Hetzner's daily backups of the whole server (`backups = true`,
seven kept) restore it from the console in minutes. And a daily Raft snapshot
(`bao-snapshot.timer`, 03:30 UTC) goes to a bucket at another provider, so a
lost Hetzner account loses nothing. A snapshot is sealed with the store's own
keys: it can't be read without two unseal keys.

Once, on the server, with a key pair that may write to the bucket:

```bash
read -rs BAO_TOKEN; export BAO_TOKEN   # the operator token
snapshot_token="$(bao token create -role=snapshot -display-name=snapshot -field=token)"
umask 077
cat > /etc/secret-store/snapshot.env <<EOF
BAO_TOKEN=$snapshot_token
S3_ENDPOINT=https://…
S3_BUCKET=…
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_PREFIX=<cluster>
EOF
systemctl start bao-snapshot && journalctl -u bao-snapshot -n 3
```

How long snapshots are kept is the bucket's lifecycle rule (30 days is
plenty). `systemctl list-timers bao-snapshot` shows the next run.

## Reboots and unsealing

Every start of OpenBao (a reboot, Hetzner maintenance, a crash,
`systemctl restart openbao`) leaves the store sealed until two unseal keys
are given. Meanwhile the cluster keeps its Secrets; new and changed values
wait.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/v1/sys/health   # 200 active, 503 sealed
ssh root@<hostname> bao operator unseal   # twice
```

Debian's security updates install themselves; the server never reboots by
itself. Reboot for a new kernel when convenient, and unseal after.

## Upgrades and changed settings

cloud-init runs once, so a running server is changed by hand, and the
variables are updated to match so a new server comes out the same.

**OpenBao** (a snapshot first):

```bash
v=2.7.3
cd /root
curl -fsSLO "https://github.com/openbao/openbao/releases/download/v$v/openbao_${v}_linux_amd64.deb"
curl -fsSL "https://github.com/openbao/openbao/releases/download/v$v/checksums.txt" | grep " openbao_${v}_linux_amd64.deb\$" | sha256sum -c -
systemctl start bao-snapshot
apt-get install -o Dpkg::Options::=--force-confold "./openbao_${v}_linux_amd64.deb"   # keeps our openbao.hcl
systemctl restart openbao && bao operator unseal && bao operator unseal
```

Then `openbao_version` and `openbao_deb_sha256` in `variables.tf`.

**Operators' addresses**: `admin_cidrs` in the tfvars and `tofu apply`
(the firewall), and the `remote_ip` line in `/etc/caddy/Caddyfile`, then
`systemctl reload caddy`.

**`/etc/openbao/openbao.hcl`**: never change the `audit "file" "file"`
block. OpenBao keeps a declared audit device's options in its storage and
refuses to become active when the file says otherwise (it stays in standby
and answers 429). Add another device under a new name instead.

## Rotating

- **The cluster's token**: make a new one (step 3), replace the Secret
  (`kubectl … create secret generic secret-store-token
  --from-literal=token=… --dry-run=client -o yaml | kubectl apply -f -`),
  check `kubectl get clustersecretstore` is Ready, then revoke the old one:
  `bao list auth/token/accessors`, `bao token lookup -accessor <a>` until the
  old one's `display_name` turns up, `bao token revoke -accessor <a>`.
- **The operator token**, before its year is up: `bao token renew
  -increment=8760h` with it.
- **The unseal keys**: `bao operator rekey -init -key-shares=3
  -key-threshold=2`, then `bao operator rekey` with two current keys.

## Root token

Policies, mounts and token roles take a root token, and none is kept. Make
one from two unseal keys, use it, revoke it:

```bash
bao operator generate-root -init                      # prints a nonce and an OTP
bao operator generate-root                            # once per key, twice
bao operator generate-root -decode=<encoded token> -otp=<OTP>
```

## Restore

Onto a new server, from a snapshot. Tested with OpenBao 2.7.2.

1. The server: `tofu apply` with the same tfvars (the same `name` is the
   same Raft node, and the same settings carry the same audit device; see
   "Upgrades"). Point DNS at its new address.
2. Copy the snapshot onto it (any S3 client, then `scp`).
3. A throwaway start, only to be able to restore:
   ```bash
   bao operator init -key-shares=1 -key-threshold=1   # throwaway key and root token
   bao operator unseal <throwaway key>
   BAO_TOKEN=<throwaway root token> bao operator raft snapshot restore -force /root/<file>.snap
   ```
4. A few seconds later the store seals itself (`journalctl -u openbao`:
   "marked as sealed"). Restart it so it reads the restored seal settings, and
   unseal with the original keys:
   ```bash
   systemctl restart openbao
   bao operator unseal   # twice, the original keys
   ```
   The original operator, cluster and snapshot tokens work again; the
   throwaway key and root token are gone.
5. Write `/etc/secret-store/snapshot.env` again ("Backups").

From one of Hetzner's backups instead: restore the image in the console,
then unseal.

## Not covered

- One node, no failover. It doesn't need one for the cluster to keep
  running, but nothing alerts yet on a sealed store (`/v1/sys/health` 503) or
  a snapshot that failed (`systemctl status bao-snapshot`).
- x86 only (`server_type` rejects `cax`): the pinned package is amd64.
