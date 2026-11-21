#!/bin/sh
# The offsite copy (cronjob.yaml): every bucket in OFFSITE_SOURCE_BUCKETS
# from rclone's remote `source:` to `destination:` under
# OFFSITE_BUCKET/<bucket>/, the two remotes defined by RCLONE_CONFIG_* in the
# environment. A bucket that fails doesn't stop the others, but the run
# fails if any did: the CronJob's last successful run (OffsiteCopyStale)
# means every bucket was copied.
set -u

case "$OFFSITE_MODE" in
  copy | sync) ;;
  *)
    echo "OFFSITE_MODE is '$OFFSITE_MODE', not copy or sync" >&2
    exit 2
    ;;
esac
if [ -z "$OFFSITE_SOURCE_BUCKETS" ] || [ -z "$OFFSITE_BUCKET" ]; then
  echo "OFFSITE_SOURCE_BUCKETS and OFFSITE_BUCKET must be set" >&2
  exit 2
fi

day="$(date -u +%Y-%m-%d)"
failed=""
for bucket in $OFFSITE_SOURCE_BUCKETS; do
  to="destination:$OFFSITE_BUCKET/$bucket"
  echo "$OFFSITE_MODE source:$bucket to $to"
  if [ "$OFFSITE_MODE" = sync ]; then
    # What sync would delete or overwrite moves to _replaced/<day>/<bucket>
    # instead. No bucket name has an underscore, so it never meets a bucket's
    # own folder.
    set -- sync "source:$bucket" "$to" --backup-dir "destination:$OFFSITE_BUCKET/_replaced/$day/$bucket"
  else
    set -- copy "source:$bucket" "$to"
  fi
  # OFFSITE_RCLONE_FLAGS is a list of flags, split into words on purpose.
  # shellcheck disable=SC2086
  if ! rclone "$@" $OFFSITE_RCLONE_FLAGS --stats 10m --stats-one-line --stats-log-level NOTICE; then
    failed="$failed $bucket"
  fi
done

if [ -n "$failed" ]; then
  echo "not copied:$failed" >&2
  exit 1
fi
echo "copied: $OFFSITE_SOURCE_BUCKETS"
