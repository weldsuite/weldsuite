#!/usr/bin/env bash
# Deploy the image and the Helm chart into a local kind cluster, with Postgres
# (master + tenant built by the chart's migration Job, `weldsuite migrate`),
# Valkey and NATS, and check the full request pipeline with a signed session
# token: auth → workspace → tenant DB → licence → flags → permission →
# envelope, a job run through Restate, then the same with OIDC sign-in against
# a stand-in issuer.
#
#   docker build --build-context drizzle=packages/core/db/drizzle -t weldsuite:dev rust
#   rust/deploy/kind/smoke-test.sh            (KEEP_CLUSTER=1 to leave it running)
#
# Needs docker, kind, kubectl, helm and node. CI runs the same script.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
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
for deployment in postgres valkey nats s3 restate mailpit; do
  kubectl rollout status "deployment/$deployment" --timeout=180s
done

psql() {
  kubectl exec -i deployment/postgres -- psql -v ON_ERROR_STOP=1 -U weldsuite "$@"
}
psql -d master -c "create database tenant" >/dev/null
# How many migrations a database's bookkeeping table records.
recorded() {
  psql -d "$1" -Atc "select count(*) from $2.__drizzle_migrations"
}

# ── the server and its migrations ───────────────────────────────────────────
# The install's pre-install hook Job (`weldsuite migrate --master --tenants`)
# builds the empty master database; there is no workspace yet.
node "$here/mint-token.mjs" "$work" user_smoke org_smoke
helm upgrade --install weldsuite "$chart" -f "$here/values.yaml" \
  --set-file "secret.values.CLERK_JWT_KEY=$work/public.pem" \
  --wait --timeout 300s
master_migrations="$(recorded master drizzle)"
echo "ok   install: the migration Job applied $master_migrations master migrations"
[ "$master_migrations" -gt 0 ] || { echo "FAIL the master database was not migrated" >&2; exit 1; }

# The smoke workspace, placed on the tenant database; an upgrade's
# pre-upgrade hook Job then migrates that database too (and finds nothing
# left to do on the master).
sed '/@@tenant@@/,$d' "$here/seed.sql" | psql -d master >/dev/null
helm upgrade weldsuite "$chart" --reuse-values --wait --timeout 300s
tenant_migrations="$(recorded tenant public)"
echo "ok   upgrade: the migration Job applied $tenant_migrations tenant migrations"
[ "$tenant_migrations" -gt 0 ] || { echo "FAIL the tenant database was not migrated" >&2; exit 1; }
[ "$(recorded master drizzle)" = "$master_migrations" ] || { echo "FAIL the master was migrated twice" >&2; exit 1; }
sed '1,/@@tenant@@/d' "$here/seed.sql" | psql -d tenant >/dev/null
kubectl rollout status deployment/weldsuite --timeout=120s

kubectl port-forward service/weldsuite 18080:80 >/dev/null 2>&1 &
api_forward=$!
forwards+=("$api_forward")
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

# Jobs: the pod registered its endpoint with Restate; a call through the
# ingress runs the no-op job and answers when it has finished.
kubectl port-forward service/restate 18180:8080 >/dev/null 2>&1 &
forwards+=($!)
job_ok=0
for _ in $(seq 1 60); do
  status="$(curl -s -o "$work/body" -w '%{http_code}' -X POST http://127.0.0.1:18180/WeldsuiteJobs/run \
    -H 'Content-Type: application/json' --data '{"name":"weldsuite.noop","key":"smoke","payload":{"from":"kind"}}' || true)"
  if [ "$status" = "200" ]; then job_ok=1; break; fi
  sleep 2
done
if [ "$job_ok" = "1" ]; then
  echo "ok   job weldsuite.noop ran on restate"
else
  echo "FAIL the no-op job did not run through restate: $status $(head -c 300 "$work/body")" >&2
  failed=1
fi

# ── OIDC sign-in (ADR SEC-012) ──────────────────────────────────────────────
# The same server switched to AUTH_PROVIDER=oidc against a stand-in issuer
# (oidc-issuer.yaml): discovery → JWKS → a Zitadel-shaped token whose
# organization claim is stored where the Clerk org id was.
oidc_issuer="http://oidc-issuer"
oidc_org="300000000000000001"
mkdir -p "$work/oidc"
node "$here/mint-token.mjs" "$work/oidc" user_smoke "$oidc_org" --oidc "$oidc_issuer" weldsuite-smoke
kubectl create configmap oidc-issuer \
  --from-file=openid-configuration="$work/oidc/openid-configuration" \
  --from-file=keys="$work/oidc/jwks.json" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$here/oidc-issuer.yaml"
kubectl rollout status deployment/oidc-issuer --timeout=120s
psql -d master -c "update workspaces set clerk_org_id = '$oidc_org' where id = 'ws_smoke'" >/dev/null
helm upgrade weldsuite "$chart" --reuse-values \
  --set config.auth.provider=oidc \
  --set config.auth.oidc.issuer="$oidc_issuer" \
  --set-string config.auth.oidc.audience=weldsuite-smoke \
  --set-string config.auth.oidc.webClientId=smoke-web \
  --wait --timeout 180s
kubectl rollout status deployment/weldsuite --timeout=120s
kill "$api_forward" 2>/dev/null || true
kubectl port-forward service/weldsuite 18080:80 >/dev/null 2>&1 &
forwards+=($!)
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18080/livez >/dev/null 2>&1 && break
  sleep 1
done
token="$(cat "$work/oidc/token")"
check GET /api/me/permissions 401
check GET /api/me/permissions 200 auth
contains '"billing:read"'
check GET /config.json 200
contains '"provider":"oidc"'
contains '"clientId":"smoke-web"'

if [ "$failed" != "0" ]; then
  kubectl logs deployment/weldsuite --tail=80 >&2 || true
  kubectl logs deployment/restate --tail=40 >&2 || true
  exit 1
fi
curl -s http://127.0.0.1:18080/health
echo
echo "smoke test passed"
