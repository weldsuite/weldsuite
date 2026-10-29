#!/usr/bin/env bash
# Deploy the image and the Helm chart into a local kind cluster and check that
# the server comes up: probes, /health against the master database, and the
# API refusing a request without a session.
#
#   docker build -t weldsuite:dev rust
#   rust/deploy/kind/smoke-test.sh            (KEEP_CLUSTER=1 to leave it running)
#
# Needs docker, kind, kubectl and helm. CI runs the same script.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
chart="$here/../helm/weldsuite"
cluster="${KIND_CLUSTER:-weldsuite-smoke}"
image="${IMAGE:-weldsuite:dev}"

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --wait 120s
fi
if [ "${KEEP_CLUSTER:-0}" != "1" ]; then
  trap 'kind delete cluster --name "$cluster"' EXIT
fi
kubectl config use-context "kind-$cluster" >/dev/null

kind load docker-image "$image" --name "$cluster"

kubectl apply -f "$here/postgres.yaml"
kubectl rollout status deployment/postgres --timeout=180s

helm upgrade --install weldsuite "$chart" -f "$here/values.yaml" --wait --timeout 180s
kubectl rollout status deployment/weldsuite --timeout=120s

kubectl port-forward service/weldsuite 18080:80 >/dev/null 2>&1 &
forward=$!
trap 'kill $forward 2>/dev/null || true; [ "${KEEP_CLUSTER:-0}" = "1" ] || kind delete cluster --name "$cluster"' EXIT
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18080/livez >/dev/null 2>&1 && break
  sleep 1
done

check() {
  local path="$1" expected="$2" status
  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18080$path")"
  if [ "$status" != "$expected" ]; then
    echo "FAIL $path: $status, expected $expected" >&2
    kubectl logs deployment/weldsuite --tail=50 >&2 || true
    exit 1
  fi
  echo "ok   $path $status"
}

check /livez 200
check /readyz 200
check /health 200
check /api/me/permissions 401
check /nope 404
curl -s http://127.0.0.1:18080/health
echo
echo "smoke test passed"
