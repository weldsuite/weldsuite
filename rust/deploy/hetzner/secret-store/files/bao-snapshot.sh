#!/bin/bash
# A Raft snapshot of the store, uploaded to object storage at another
# provider (bao-snapshot.timer, daily). The snapshot is sealed with the
# store's own keys: restoring it takes the unseal keys (README, "Restore").
#
# /etc/secret-store/snapshot.env (README, "Backups"): BAO_TOKEN (a token of
# the snapshot role), S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID,
# S3_SECRET_ACCESS_KEY, and optionally S3_REGION, S3_PREFIX and
# SNAPSHOT_PING_URL, a dead-man's switch (a healthchecks.io check's ping URL)
# pinged after every uploaded snapshot, which notifies when the pings stop.
# The bucket's own lifecycle rule decides how long snapshots are kept.
set -euo pipefail
# shellcheck disable=SC1091
. /etc/secret-store/snapshot.env
export BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN

file="$(mktemp)"
trap 'rm -f "$file"' EXIT

# Renewing first keeps the periodic token alive while the timer runs.
bao token renew >/dev/null
bao operator raft snapshot save "$file"

export RCLONE_CONFIG_BACKUP_TYPE=s3 \
  RCLONE_CONFIG_BACKUP_PROVIDER=Other \
  RCLONE_CONFIG_BACKUP_ENDPOINT="$S3_ENDPOINT" \
  RCLONE_CONFIG_BACKUP_REGION="${S3_REGION:-us-east-1}" \
  RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" \
  RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true
target="backup:$S3_BUCKET/${S3_PREFIX:-openbao}/$(hostname)-$(date -u +%Y%m%dT%H%M%SZ).snap"
rclone copyto "$file" "$target"
echo "bao-snapshot: $target ($(stat -c %s "$file") bytes)"

# Only reached when the snapshot is in the bucket. A ping that fails leaves
# the snapshot and the run good; the check notifies once its grace is up.
if [ -n "${SNAPSHOT_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$SNAPSHOT_PING_URL" ||
    echo "bao-snapshot: the ping to SNAPSHOT_PING_URL failed" >&2
fi
