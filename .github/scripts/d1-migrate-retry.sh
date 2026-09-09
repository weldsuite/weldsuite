#!/usr/bin/env bash
# Retry wrapper for `wrangler d1 migrations apply`.
# D1 intermittently returns 7429 (storage timeout / object reset) or 504s on
# otherwise tiny CREATE TABLE migrations. Safe to retry: wrangler tracks applied
# files in d1_migrations, so a successful half-apply won't re-run.

d1_migrate_with_retry() {
  local label="$1"
  shift
  local attempt=1
  local max_attempts="${D1_MIGRATE_MAX_ATTEMPTS:-5}"
  local sleep_s="${D1_MIGRATE_INITIAL_SLEEP_S:-5}"

  while true; do
    echo "=== D1 ${label} (attempt ${attempt}/${max_attempts}) ==="
    if "$@"; then
      echo "=== D1 ${label} ok ==="
      return 0
    fi
    local status=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "::error::D1 ${label} failed after ${max_attempts} attempts (last exit ${status})"
      return "$status"
    fi
    echo "::warning::D1 ${label} failed (exit ${status}); retrying in ${sleep_s}s (often Cloudflare 7429/504)"
    sleep "$sleep_s"
    attempt=$((attempt + 1))
    sleep_s=$((sleep_s * 2))
  done
}
