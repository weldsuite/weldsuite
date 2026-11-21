#!/bin/bash
# Sets a new store up once it is initialised and unsealed (README, "First
# start"), and again after a change to the policies or token roles; every
# step can run twice. Needs a root token; makes no token itself.
#
#   BAO_TOKEN=<root token> bao-configure
#
# CLUSTER_TOKEN_CIDRS (optional, comma-separated): the cluster's outgoing
# addresses. Cluster tokens made afterwards work only from there, so a copy
# that leaks is useless elsewhere; a node with a new address then needs a new
# token. Unset: from anywhere (Caddy still lets only reads through).
set -euo pipefail
export BAO_ADDR="${BAO_ADDR:-http://127.0.0.1:8200}"
: "${BAO_TOKEN:?set BAO_TOKEN to a root token}"
policies="${POLICY_DIR:-/etc/secret-store/policies}"

# The values: KV version 2 at secret/, which the cluster's ClusterSecretStore
# reads (path: secret, version: v2).
if ! bao secrets list -format=json | grep -q '"secret/"'; then
  bao secrets enable -path=secret -version=2 kv
fi

for policy in cluster-read operator snapshot; do
  bao policy write "$policy" "$policies/$policy.hcl"
done

# Tokens may outlive OpenBao's default 32 days: nothing renews the cluster's
# (External Secrets Operator uses the token it is given as it is).
bao auth tune -max-lease-ttl=87600h token/

# The cluster's token: read-only, no parent (revoking the operator's token
# leaves it working), up to ten years (README, "The cluster's token").
bao write auth/token/roles/cluster \
  allowed_policies=cluster-read orphan=true renewable=true \
  token_explicit_max_ttl=87600h token_bound_cidrs="${CLUSTER_TOKEN_CIDRS:-}"

# The snapshot timer's token: periodic, renewed by every run.
bao write auth/token/roles/snapshot \
  allowed_policies=snapshot orphan=true renewable=true token_period=768h

echo "bao-configure: done"
