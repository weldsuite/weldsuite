#!/usr/bin/env bash
# Usage: bash .github/scripts/vercel-unset-sensitive.sh .vercel/.env.<target>.local
#
# `vercel pull` cannot read env vars marked Sensitive on the Vercel project. It
# writes them as the literal string "[SENSITIVE]", and `vercel build` hands that
# string to the app as the value: @weldsuite/db parses MASTER_DATABASE_URL when
# it is imported, so booking-portal and meeting-portal failed with "Invalid URL"
# while collecting page data.
#
# Drop those lines so the build sees the variables unset, the state CI's `Build`
# job builds every app in. Vercel still gives the deployment the real values at
# runtime. NEXT_PUBLIC_* is the exception: Next.js inlines it into the client
# bundle at build time, so such a variable must not be Sensitive.
set -euo pipefail

env_file="${1:?usage: vercel-unset-sensitive.sh <env file>}"
[ -f "$env_file" ] || exit 0

pattern='^[A-Za-z_][A-Za-z0-9_]*="?\[SENSITIVE\]"?$'
names=$(grep -E "$pattern" "$env_file" | cut -d= -f1 || true)
[ -n "$names" ] || exit 0

grep -vE "$pattern" "$env_file" > "$env_file.tmp" || true
mv "$env_file.tmp" "$env_file"

echo "Unset for the build (Sensitive on Vercel, set at runtime): $(echo $names)"
for name in $names; do
  case "$name" in
    NEXT_PUBLIC_*)
      echo "::warning title=Sensitive public env var::$name is Sensitive on the Vercel project, so the build cannot read it and the client bundle ships without it. Public values are not secret: mark it non-Sensitive."
      ;;
  esac
done
