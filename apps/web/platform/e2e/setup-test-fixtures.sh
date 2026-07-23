#!/usr/bin/env bash
#
# One-shot setup for the E2E test-fixtures infrastructure.
#
# Idempotent — safe to re-run. Generates a fresh TEST_FIXTURES_TOKEN if you
# don't pass --token=…, writes the wrangler secret on the test + preview
# envs, then prints the values you need to paste into the three GitHub
# Actions secrets.
#
# What you still need to do by hand (Clerk has no public API for this):
#   1. Create a dedicated test workspace in the test-env Clerk dashboard.
#   2. Note its `org_…` id and pass it via --workspace-id=… OR paste it
#      into the prompts.
#   3. Add the printed values to GitHub Actions → Settings → Secrets.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
APP_API_DIR="$SCRIPT_DIR/../../app-api"
ENV_FILE="$SCRIPT_DIR/../.env.test"

TOKEN=""
WORKSPACE_ID=""
API_URL="https://app-api-test.weldsuite.org"
SKIP_WRANGLER=0

print_usage() {
  cat <<EOF
Usage: $0 [options]

  --token=TOKEN              Use this token instead of generating one.
  --workspace-id=ORG_ID      Clerk org id of the dedicated test workspace.
  --api-url=URL              app-api hostname (default: $API_URL).
  --skip-wrangler            Skip the \`wrangler secret put\` calls.
  -h, --help                 Show this help.
EOF
}

for arg in "$@"; do
  case $arg in
    --token=*) TOKEN="${arg#*=}";;
    --workspace-id=*) WORKSPACE_ID="${arg#*=}";;
    --api-url=*) API_URL="${arg#*=}";;
    --skip-wrangler) SKIP_WRANGLER=1;;
    -h|--help) print_usage; exit 0;;
    *) echo "Unknown arg: $arg"; print_usage; exit 1;;
  esac
done

# 1. Token
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(node -e "console.log(crypto.randomBytes(32).toString('hex'))")"
  echo "→ Generated TEST_FIXTURES_TOKEN: $TOKEN"
else
  echo "→ Using provided TEST_FIXTURES_TOKEN"
fi

# 2. Workspace id
if [[ -z "$WORKSPACE_ID" ]]; then
  read -p "Clerk org id of the dedicated test workspace (org_…): " WORKSPACE_ID
fi
if [[ ! "$WORKSPACE_ID" =~ ^org_ ]]; then
  echo "✗ Workspace id should start with 'org_'. Got: $WORKSPACE_ID" >&2
  exit 1
fi

# 3. Worker secrets
if [[ $SKIP_WRANGLER -eq 0 ]]; then
  pushd "$APP_API_DIR" >/dev/null
  for env in test preview; do
    echo "→ wrangler secret put TEST_FIXTURES_TOKEN --env $env"
    echo "$TOKEN" | npx wrangler secret put TEST_FIXTURES_TOKEN --env "$env"
  done
  popd >/dev/null
else
  echo "→ --skip-wrangler set; skipping \`wrangler secret put\`."
fi

# 4. Local .env.test
{
  grep -v -e '^TEST_API_URL=' -e '^TEST_FIXTURES_TOKEN=' -e '^TEST_WORKSPACE_ID=' "$ENV_FILE" 2>/dev/null || true
  echo "TEST_API_URL=$API_URL"
  echo "TEST_FIXTURES_TOKEN=$TOKEN"
  echo "TEST_WORKSPACE_ID=$WORKSPACE_ID"
} > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "→ Updated $ENV_FILE"

# 5. Print the GitHub Actions secrets to copy/paste.
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Paste these into GitHub → Settings → Secrets → Actions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TEST_FIXTURES_TOKEN  = $TOKEN"
echo "  TEST_API_URL         = $API_URL"
echo "  TEST_WORKSPACE_ID    = $WORKSPACE_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "→ Verify the setup:"
echo "  curl -H \"X-Test-Token: \$TEST_FIXTURES_TOKEN\" \\"
echo "       -H \"X-Test-Workspace-Id: \$TEST_WORKSPACE_ID\" \\"
echo "       $API_URL/test-fixtures/ping"
echo "  # Expected: { \"data\": { \"workspaceId\": \"$WORKSPACE_ID\", … } }"
echo
echo "Done. CI will use these on the next push."
