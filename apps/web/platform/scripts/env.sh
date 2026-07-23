#!/bin/sh
# Generate runtime environment variables for the client
# This script runs at container startup and creates a JS file with env vars

cat <<EOF > /app/apps/web/platform/public/__ENV.js
window.__ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}",
  NEXT_PUBLIC_API_BASE_URL: "${NEXT_PUBLIC_API_BASE_URL:-}",
  NEXT_PUBLIC_SIGNALR_HUB_URL: "${NEXT_PUBLIC_SIGNALR_HUB_URL:-}",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "${NEXT_PUBLIC_CLERK_SIGN_IN_URL:-/auth/login}",
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: "${NEXT_PUBLIC_CLERK_SIGN_UP_URL:-/auth/register}",
};
EOF

echo "Generated __ENV.js with runtime environment variables"

# Start the Next.js server
exec node apps/web/platform/server.js
