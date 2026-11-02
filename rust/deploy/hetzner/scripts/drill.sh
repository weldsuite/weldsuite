#!/usr/bin/env bash
# The monthly drill (DRILL.md): build a throwaway cluster on Hetzner, let
# Flux install everything with Postgres restored from production's latest
# backup, check it, and tear it all down. Runs on the drill runner (an EU
# machine holding the Hetzner token), never on GitHub.
#
# Needs: tofu, talosctl, kubectl, flux, and
#   HCLOUD_TOKEN            the drill's Hetzner project token
#   DRILL_TFVARS            a tfvars file (domain, admin_cidrs, ...)
#   DRILL_AGE_KEY           the drill's age private key file (SOPS)
#   DEPLOY_KEY              read-only deploy key file for the repository
#   DRILL_BRANCH            branch to test (default: main)
# KEEP=1 leaves the cluster up for inspection (destroy it yourself).
set -euo pipefail

: "${HCLOUD_TOKEN:?}" "${DRILL_TFVARS:?}" "${DRILL_AGE_KEY:?}" "${DEPLOY_KEY:?}"
branch="${DRILL_BRANCH:-main}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
log() { printf '\n== %s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }

export TF_VAR_hcloud_token="$HCLOUD_TOKEN"
tofu_drill() { tofu -chdir="$here" "$@" -var-file="$DRILL_TFVARS" -var cluster_name=weldsuite-drill; }

teardown() {
  status=$?
  if [ "${KEEP:-0}" = "1" ]; then
    log "KEEP=1: cluster left running (kubeconfig in $work)"
  else
    log "teardown"
    tofu_drill destroy -auto-approve -input=false || echo "DESTROY FAILED: clean up the drill project by hand" >&2
  fi
  log "drill $([ $status -eq 0 ] && echo PASSED || echo FAILED)"
  exit $status
}
trap teardown EXIT

log "infrastructure (OpenTofu, workspace drill)"
tofu -chdir="$here" init -input=false >/dev/null
tofu -chdir="$here" workspace select -or-create drill
tofu_drill apply -auto-approve -input=false
tofu -chdir="$here" output -raw kubeconfig >"$work/kubeconfig"
tofu -chdir="$here" output -raw talosconfig >"$work/talosconfig"
export KUBECONFIG="$work/kubeconfig" TALOSCONFIG="$work/talosconfig"

log "nodes"
kubectl wait --for=condition=Ready nodes --all --timeout=20m
kubectl get nodes -L topology.kubernetes.io/zone,node.weldsuite.org/pool

log "Flux (read only: the cluster pulls, nothing is pushed)"
flux install --version=v2.9.6
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey="$DRILL_AGE_KEY"
flux create secret git flux-system \
  --url=ssh://git@github.com/weldsuite/weldsuite --private-key-file="$DEPLOY_KEY"
flux create source git flux-system \
  --url=ssh://git@github.com/weldsuite/weldsuite --branch="$branch" --secret-ref=flux-system
flux create kustomization flux-system \
  --source=GitRepository/flux-system --path=./rust/deploy/flux/clusters/drill --prune=true

log "waiting for every layer (restores included)"
for layer in sources controllers secrets configs services apps; do
  kubectl -n flux-system wait kustomization/"$layer" --for=condition=Ready --timeout=60m
done

log "checks"
kubectl -n postgres wait cluster.postgresql.cnpg.io/master --for=condition=Ready --timeout=10m
kubectl -n postgres wait cluster.postgresql.cnpg.io/tenants-1 --for=condition=Ready --timeout=10m
kubectl -n zitadel wait cluster.postgresql.cnpg.io/zitadel-db --for=condition=Ready --timeout=10m
workspaces="$(kubectl -n postgres exec master-1 -c postgres -- \
  psql -tA -d weldsuite_master -c 'select count(*) from workspaces')"
echo "restored master: $workspaces workspaces"
[ "$workspaces" -gt 0 ] || { echo "the restored master database has no workspaces" >&2; exit 1; }

kubectl -n weldsuite rollout status deployment/weldsuite --timeout=10m
kubectl -n weldsuite port-forward service/weldsuite 18080:80 >/dev/null 2>&1 &
forward=$!
sleep 3
curl -fsS http://127.0.0.1:18080/readyz
curl -fsS http://127.0.0.1:18080/health
echo
kill "$forward"

log "server types used (Hetzner availability changes)"
tofu -chdir="$here" output -json nodes
