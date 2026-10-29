#!/usr/bin/env bash
# Deploy the image and the Helm chart into a local kind cluster, with Postgres
# (master + tenant built by the chart's migration Job, `weldsuite migrate`),
# Valkey and NATS, and check the full request pipeline with a signed session
# token: auth → workspace → tenant DB → licence → flags → permission →
# envelope, a job run through Restate, the platform SPA from the image on the
# same origin, the sign portal's container calling the server, then the same
# with OIDC sign-in against a stand-in issuer, and (with a reachable Zitadel,
# SMOKE_ZITADEL_*) sign-up and the first workspace's provisioning.
#
#   docker build -f rust/Dockerfile -t weldsuite:dev .
#   docker build -f rust/Dockerfile --target sign-portal -t weldsuite-sign-portal:dev .
#   rust/deploy/kind/smoke-test.sh            (KEEP_CLUSTER=1 to leave it running)
#
# Needs docker, kind, kubectl, helm and node. CI runs the same script.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
chart="$here/../helm/weldsuite"
cluster="${KIND_CLUSTER:-weldsuite-smoke}"
image="${IMAGE:-weldsuite:dev}"
portal_image="${PORTAL_IMAGE:-weldsuite-sign-portal:dev}"
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
kind load docker-image "$image" "$portal_image" --name "$cluster"

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
base=http://127.0.0.1:18080
check() {
  local method="$1" path="$2" expected="$3" auth="${4:-}" body="${5:-}" status
  local args=(-s -o "$work/body" -D "$work/headers" -w '%{http_code}' -X "$method")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  status="$(curl "${args[@]}" "$base$path")"
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
# header <name> <text>: the last answer's header holds the text.
header() {
  if ! tr -d '\r' <"$work/headers" | grep -qi "^$1:.*$2"; then
    echo "FAIL the last answer's $1 has no $2: $(tr -d '\r' <"$work/headers" | grep -i "^$1:" || echo none)" >&2
    failed=1
  fi
}

check GET /livez 200
check GET /readyz 200
check GET /health 200
check GET /public/nope 404
contains '"NOT_FOUND"'
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

# ── The platform SPA (spa.rs) ───────────────────────────────────────────────
# The image's build, on the API's origin: index.html for the root and any
# client route, revalidated; hashed assets cached for good and precompressed;
# a missing asset a 404, never HTML; /config.json still the server's.
check GET / 200
contains '<div id="root">'
header cache-control no-cache
check GET /weldcrm/contacts 200
contains '<div id="root">'
asset="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$work/body" | head -n 1)"
check GET "${asset:-/assets/no-entry-chunk-in-index.js}" 200
header cache-control immutable
header content-type javascript
encoding="$(curl -s -o /dev/null -D - -H 'Accept-Encoding: br, gzip' "$base$asset" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2}')"
if [ "$encoding" = br ]; then
  echo "ok   GET $asset precompressed (br)"
else
  echo "FAIL GET $asset: content-encoding '$encoding', expected br" >&2
  failed=1
fi
check GET /assets/index-0ld0ld0l.js 404
header cache-control no-store
check GET /config.json 200
contains '"backend":"rust"'

# ── The sign portal (ADR FE-017) ────────────────────────────────────────────
# Its container renders the signer pages and calls the server's
# /public/sign-portal/* with the shared secret. Those endpoints are not
# ported yet (rust/modules/sign), so the server's 404 comes back through the
# portal for now; check for the portal's answers once they are.
kubectl rollout status deployment/weldsuite-sign-portal --timeout=120s
kubectl port-forward service/weldsuite-sign-portal 18081:80 >/dev/null 2>&1 &
forwards+=($!)
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:18081/healthz >/dev/null 2>&1 && break
  sleep 1
done
base=http://127.0.0.1:18081
check GET /healthz 200
check GET /r/smoke-link-token 200
contains '<html'
header x-frame-options DENY
check POST /api/session 404 "" '{"token":"smoke-link-token"}'
contains '"NOT_FOUND"'
base=http://127.0.0.1:18080

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

# ── Sign-up and the first workspace (P4 4a) ─────────────────────────────────
# Only with a Zitadel the cluster can reach (SMOKE_ZITADEL_URL as the pods
# see it, SMOKE_ZITADEL_LOCAL_URL as this script does, SMOKE_ZITADEL_HOST its
# instance's host, SMOKE_ZITADEL_TOKEN an IAM_OWNER service user's token,
# SMOKE_ZITADEL_PROJECT_ID the WeldSuite project with roles admin and
# member); CI has none and skips it. A person Zitadel knows, signed in
# without a workspace, creates one: the organization in Zitadel, the
# workspace row, then the workspace.provision job (on Restate) puts its
# database on the tenant shard (this Postgres) and makes them its owner; the
# identity sync then runs once.
if [ -n "${SMOKE_ZITADEL_URL:-}" ]; then
  zitadel_local="${SMOKE_ZITADEL_LOCAL_URL:-$SMOKE_ZITADEL_URL}"
  zitadel() {
    curl -fsS -H "Authorization: Bearer $SMOKE_ZITADEL_TOKEN" -H 'Content-Type: application/json' "$@"
  }
  signup_email="kind-signup-$@example.test"
  signup_user="$(zitadel -X POST "$zitadel_local/v2/users/human" --data \
    "{\"username\":\"$signup_email\",\"profile\":{\"givenName\":\"Kind\",\"familyName\":\"Signup\"},\"email\":{\"email\":\"$signup_email\",\"isVerified\":true}}" |
    sed -n 's/.*"userId":"\([0-9]*\)".*/\1/p')"
  # A token for them without an organization, from a fresh stand-in key.
  mkdir -p "$work/signup"
  node "$here/mint-token.mjs" "$work/signup" "$signup_user" - --oidc "$oidc_issuer" weldsuite-smoke
  kubectl create configmap oidc-issuer \
    --from-file=openid-configuration="$work/signup/openid-configuration" \
    --from-file=keys="$work/signup/jwks.json" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl rollout restart deployment/oidc-issuer
  kubectl rollout status deployment/oidc-issuer --timeout=120s
  helm upgrade weldsuite "$chart" --reuse-values \
    --set config.identity.zitadel.apiUrl="$SMOKE_ZITADEL_URL" \
    --set config.identity.zitadel.host="${SMOKE_ZITADEL_HOST:-}" \
    --set-string config.identity.zitadel.projectId="$SMOKE_ZITADEL_PROJECT_ID" \
    --set-string secret.values.ZITADEL_SERVICE_TOKEN="$SMOKE_ZITADEL_TOKEN" \
    --set-string secret.values.DATABASE_ENCRYPTION_KEY_V2=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    --set-string secret.values.TENANT_SHARDS='[{"name":"kind","adminUrl":"postgres://weldsuite:weldsuite@postgres:5432/master","poolerHost":"postgres","urlOptions":""}]' \
    --set cron.jobs.identity-sync.enabled=true \
    --wait --timeout 180s
  # The keys the server fetched at start are the old ones.
  kubectl rollout restart deployment/weldsuite
  kubectl rollout status deployment/weldsuite --timeout=120s
  kubectl port-forward service/weldsuite 18081:80 >/dev/null 2>&1 &
  forwards+=($!)
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:18081/livez >/dev/null 2>&1 && break
    sleep 1
  done
  base=http://127.0.0.1:18081
  token="$(cat "$work/signup/token")"
  check GET /api/onboarding/status 200 auth
  contains '"hasOrganization":false'
  check POST /api/onboarding/workspace 200 auth '{"name":"Kind Signup","country":"NL"}'
  contains '"success":true'
  signup_ws="$(sed -n 's/.*"workspaceId":"\([^"]*\)".*/\1/p' "$work/body")"
  signup_org="$(sed -n 's/.*"organizationId":"\([^"]*\)".*/\1/p' "$work/body")"
  provisioned=""
  for _ in $(seq 1 60); do
    provisioned="$(psql -d master -Atc "select provisioning_status from workspaces where id = '$signup_ws'")"
    if [ "$provisioned" = "ready" ] || [ "$provisioned" = "failed" ]; then break; fi
    sleep 2
  done
  if [ "$provisioned" = "ready" ]; then
    echo "ok   signup: workspace $signup_ws provisioned (organization $signup_org)"
  else
    echo "FAIL signup: workspace $signup_ws is $provisioned: $(psql -d master -Atc "select provisioning_error from workspaces where id = '$signup_ws'")" >&2
    failed=1
  fi
  signup_db="$(psql -d master -Atc "select neon_database_name from workspaces where id = '$signup_ws'")"
  owner="$(psql -d "$signup_db" -Atc "select role from workspace_members where user_id = '$signup_user'" 2>/dev/null || true)"
  if [ "$owner" = "OWNER" ]; then
    echo "ok   signup: $signup_db has its owner"
  else
    echo "FAIL signup: no owner in $signup_db ($owner)" >&2
    failed=1
  fi
  kubectl create job --from=cronjob/weldsuite-identity-sync identity-sync-smoke >/dev/null
  if kubectl wait --for=condition=complete job/identity-sync-smoke --timeout=120s >/dev/null; then
    echo "ok   identity sync: $(kubectl logs job/identity-sync-smoke | grep '"job"' | head -c 300)"
  else
    echo "FAIL the identity sync did not finish: $(kubectl logs job/identity-sync-smoke --tail=20)" >&2
    failed=1
  fi
  if [ -n "$signup_org" ]; then
    zitadel -X DELETE -H "x-zitadel-orgid: $signup_org" "$zitadel_local/management/v1/orgs/me" >/dev/null || true
  fi
  zitadel -X DELETE "$zitadel_local/v2/users/$signup_user" >/dev/null || true
  base=http://127.0.0.1:18080
else
  echo "skip sign-up: SMOKE_ZITADEL_URL is not set"
fi

if [ "$failed" != "0" ]; then
  kubectl logs deployment/weldsuite --tail=80 >&2 || true
  kubectl logs deployment/restate --tail=40 >&2 || true
  exit 1
fi
curl -s http://127.0.0.1:18080/health
echo
echo "smoke test passed"
