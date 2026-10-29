#!/usr/bin/env bash
# Deploy the image and the Helm chart into a local kind cluster, with Postgres
# (master + tenant built from the journaled migrations), Valkey and NATS, and
# check the full request pipeline with a signed session token:
# auth → workspace → tenant DB → licence → flags → permission → envelope.
#
#   docker build -t weldsuite:dev rust
#   rust/deploy/kind/smoke-test.sh            (KEEP_CLUSTER=1 to leave it running)
#
# Needs docker, kind, kubectl, helm, node and the repo's pnpm install (for the
# migrations script). CI runs the same script.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
chart="$here/../helm/weldsuite"
cluster="${KIND_CLUSTER:-weldsuite-smoke}"
image="${IMAGE:-weldsuite:dev}"
work="$(mktemp -d)"
forwards=()

cleanup() {
  for pid in "${forwards[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
  [ "${KEEP_CLUSTER:-0}" = "1" ] || kind delete cluster --name "$cluster"
}
trap cleanup EXIT

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --wait 120s
fi
kubectl config use-context "kind-$cluster" >/dev/null
kind load docker-image "$image" --name "$cluster"

# ── services ────────────────────────────────────────────────────────────────
kubectl apply -f "$here/postgres.yaml" -f "$here/services.yaml"
for deployment in postgres valkey nats s3; do
  kubectl rollout status "deployment/$deployment" --timeout=180s
done

psql() {
  kubectl exec -i deployment/postgres -- psql -v ON_ERROR_STOP=1 -U weldsuite "$@"
}
psql -d master -c "create database tenant" >/dev/null

kubectl port-forward service/postgres 15432:5432 >/dev/null 2>&1 &
forwards+=($!)
sleep 3
(cd "$repo" && pnpm exec tsx scripts/rust-test-db.ts \
  --master postgres://weldsuite:weldsuite@127.0.0.1:15432/master \
  --tenant postgres://weldsuite:weldsuite@127.0.0.1:15432/tenant)
sed '/@@tenant@@/,$d' "$here/seed.sql" | psql -d master >/dev/null
sed '1,/@@tenant@@/d' "$here/seed.sql" | psql -d tenant >/dev/null

# ── the server ──────────────────────────────────────────────────────────────
node "$here/mint-token.mjs" "$work" user_smoke org_smoke
helm upgrade --install weldsuite "$chart" -f "$here/values.yaml" \
  --set-file "secret.values.CLERK_JWT_KEY=$work/public.pem" \
  --wait --timeout 180s
kubectl rollout status deployment/weldsuite --timeout=120s

kubectl port-forward service/weldsuite 18080:80 >/dev/null 2>&1 &
forwards+=($!)
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18080/livez >/dev/null 2>&1 && break
  sleep 1
done

token="$(cat "$work/token")"
failed=0
check() {
  local method="$1" path="$2" expected="$3" auth="${4:-}" body="${5:-}" status
  local args=(-s -o "$work/body" -w '%{http_code}' -X "$method")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  status="$(curl "${args[@]}" "http://127.0.0.1:18080$path")"
  if [ "$status" != "$expected" ]; then
    echo "FAIL $method $path: $status, expected $expected: $(head -c 300 "$work/body")" >&2
    failed=1
  else
    echo "ok   $method $path $status"
  fi
}
contains() {
  if ! grep -q "$1" "$work/body"; then
    echo "FAIL the last body has no $1: $(head -c 300 "$work/body")" >&2
    failed=1
  fi
}

check GET /livez 200
check GET /readyz 200
check GET /health 200
check GET /nope 404
check GET /api/me/permissions 401
# The signed-in member: session → workspace → tenant database → permissions.
check GET /api/me/permissions 200 auth
contains '"billing:read"'
# Feature flags from the flag layer.
check GET /api/feature-flags 200 auth
contains '"upgrade-button":false'
# A write: notifications for the admins, published to Valkey.
check POST /api/access-requests 201 auth '{"permission":"team:read","pageLabel":"Team"}'
contains '"status":"pending"'
check POST /api/access-requests 400 auth '{"permission":"*"}'
# The permission gate: a member without team:update may not resolve.
check PATCH /api/access-requests/areq_smoke 403 auth '{"status":"approved"}'
contains '"FORBIDDEN"'
# The first ported module (know): a teamspace, a page in it, and the list
# with the member's private space created on first visit.
check POST /api/knowledge/spaces 201 auth '{"name":"Smoke space","visibility":"open"}'
space_id="$(sed -n 's/.*"id":"\(kspc_[a-z0-9]*\)".*/\1/p' "$work/body")"
check POST /api/knowledge/pages 201 auth "{\"spaceId\":\"$space_id\",\"title\":\"Runbook\"}"
contains '"title":"Runbook"'
check GET /api/knowledge/spaces 200 auth
contains '"kind":"personal"'
contains '"name":"Smoke space"'

if [ "$failed" != "0" ]; then
  kubectl logs deployment/weldsuite --tail=80 >&2 || true
  exit 1
fi
curl -s http://127.0.0.1:18080/health
echo
echo "smoke test passed"
