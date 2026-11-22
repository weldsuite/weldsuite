#!/usr/bin/env bash
# Point-in-time restore of one workspace's tenant database, on the
# CloudNativePG clusters of the Flux layers (configs/base/postgres.yaml).
#
# Postgres recovers a whole cluster, and a tenant shard holds many
# workspaces, so restoring the shard itself would roll every workspace on it
# back. Instead:
#
#   restore  recovers the workspace's shard to the chosen time in a temporary
#            Cluster (<shard>-pitr-<time>: one instance, bootstrapped from the
#            shard's barman-cloud backups, archiving no WAL of its own),
#            copies the workspace's database out of it into a new database
#            next to the live one (ws_<id>_pitr_<time>, same owner, PUBLIC
#            revoked as the provisioner does), checks the copy table for
#            table, and deletes the temporary Cluster. The live database is
#            not touched: look at the copy, or copy rows out of it by hand.
#   swap     makes a copy the workspace's live database: renames the live one
#            to ws_<id>_pre_<now> and the copy to ws_<id> in one transaction,
#            then runs `weldsuite migrate --tenants --only <workspace>` so the
#            copy has every tenant migration the running build expects. The
#            workspace's URL (role, database name, pooler) stays valid, so
#            nothing in the master changes. Swapping the _pre_ database back
#            undoes it.
#   list     the workspace's database, its copies, the shard's recovery
#            window and any temporary Clusters left running.
#   drop     drops one of the workspace's copies (never the live database).
#
# Only the tenant database goes back. The master's rows for the workspace
# (members, plan, settings kept there), its files in object storage and
# anything already sent (mail, webhooks) stay as they are now. During a swap
# that workspace gets errors for a few seconds (up to PgBouncer's
# server_login_retry, 15s, for a connection that raced the rename).
#
# The copy streams through the machine this runs on (pg_dump | pg_restore,
# both over kubectl exec), so run it close to the cluster for large
# workspaces. The temporary Cluster copies the shard's image, storage,
# resources and node placement, so the Postgres nodes need room for one more
# instance of the shard while it runs (rust/deploy/hetzner/README.md,
# "Restoring one workspace").
#
# Needs: kubectl, allowed to exec into pods and to create and delete Clusters
# in the Postgres namespace (and to exec into the weldsuite Deployment for
# swap). Runs from Linux, macOS and Git Bash.
set -euo pipefail

# Git Bash would turn /usr/local/bin/... into a Windows path for kubectl.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

usage() {
  cat <<'EOF'
usage: restore-workspace.sh <command> [options]

commands:
  restore --workspace <id> --to <time>   copy the workspace's database as it was
                                         at <time> next to the live one
  swap    --workspace <id> --database <copy>
                                         make <copy> the live database (and the
                                         live one ws_<id>_pre_<now>)
  list    --workspace <id>               the workspace's databases, the recovery
                                         window and temporary Clusters
  drop    --workspace <id> --database <copy> [--yes]
                                         drop one of the workspace's copies

  <id>    workspaces.id (ws_...)
  <time>  UTC, YYYY-MM-DDTHH:MM[:SS]Z, e.g. 2026-11-20T13:59:00Z: inside the
          recovery window (list) and at least 10 minutes ago

options:
  --context <name>       kubectl context (default: the current one)
  --namespace <ns>       namespace of the Postgres Clusters (default postgres)
  --master <cluster>     the master database's Cluster (default master)
  --master-db <name>     the master database (default weldsuite_master)
  --server-name <name>   restore: the barman serverName to recover from
                         (default: the one the shard archives to now)
  --timeout <duration>   restore: how long to wait for the recovery (default 60m)
  --keep                 restore: leave the temporary Cluster running (a second
                         restore to the same time on the same shard reuses it)
  --app-namespace <ns>   swap: namespace of the weldsuite Deployment (default weldsuite)
  --app-deployment <n>   swap: the Deployment to run migrations in (default weldsuite)
  --no-migrate           swap: skip `weldsuite migrate` after the swap
  --yes                  drop: don't ask
  -h, --help             this message
EOF
}

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*" >&2; }

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  restore | swap | list | drop) ;;
  -h | --help | help | "") usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

context="" ns="postgres" master="master" master_db="weldsuite_master"
workspace="" to="" database="" server_name="" timeout="60m" keep=false
app_ns="weldsuite" app_deploy="weldsuite" migrate=true yes=false
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) workspace="${2:-}"; shift 2 ;;
    --to) to="${2:-}"; shift 2 ;;
    --database) database="${2:-}"; shift 2 ;;
    --context) context="${2:-}"; shift 2 ;;
    --namespace) ns="${2:-}"; shift 2 ;;
    --master) master="${2:-}"; shift 2 ;;
    --master-db) master_db="${2:-}"; shift 2 ;;
    --server-name) server_name="${2:-}"; shift 2 ;;
    --timeout) timeout="${2:-}"; shift 2 ;;
    --keep) keep=true; shift ;;
    --app-namespace) app_ns="${2:-}"; shift 2 ;;
    --app-deployment) app_deploy="${2:-}"; shift 2 ;;
    --no-migrate) migrate=false; shift ;;
    --yes) yes=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[[ "$workspace" =~ ^[A-Za-z0-9_]{1,64}$ ]] || die "--workspace needs a workspace id (ws_...)"

kc() { kubectl ${context:+--context "$context"} "$@"; }

# psql in a Cluster's pod, as the postgres superuser over the local socket:
# SQL on stdin (so :'var' and :"var" are quoted by psql), one row per line,
# columns separated by |.
psql_in() {
  local pod="$1" db="$2"
  shift 2
  kc -n "$ns" exec -i "$pod" -c postgres -- \
    psql -X -q -At -F '|' -v ON_ERROR_STOP=1 -d "$db" "$@"
}

primary_of() {
  local pod
  pod="$(kc -n "$ns" get cluster "$1" -o jsonpath='{.status.currentPrimary}')"
  [ -n "$pod" ] || die "Cluster $ns/$1 has no current primary"
  echo "$pod"
}

# Seconds since 1970 for YYYY-MM-DDTHH:MM:SSZ, without GNU or BSD date flags.
epoch() {
  local y=$((10#${1:0:4})) m=$((10#${1:5:2})) d=$((10#${1:8:2}))
  local hh=$((10#${1:11:2})) mm=$((10#${1:14:2})) ss=$((10#${1:17:2}))
  if [ "$m" -le 2 ]; then y=$((y - 1)); m=$((m + 12)); fi
  local days=$((365 * y + y / 4 - y / 100 + y / 400 + (153 * (m - 3) + 2) / 5 + d - 719469))
  echo $((days * 86400 + hh * 3600 + mm * 60 + ss))
}

json_str() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }

# The workspace's placement from the master: database, role and shard
# (neon_project_id is cnpg:<Cluster name> for a database on a CloudNativePG
# shard; adapters-oss/src/cnpg.rs).
master_pod="" db="" role="" shard="" moving=""
load_placement() {
  master_pod="$(primary_of "$master")"
  local row
  row="$(psql_in "$master_pod" "$master_db" -v ws="$workspace" <<'SQL'
select w.neon_database_name, w.neon_role_name, substr(w.neon_project_id, 6),
       exists (select 1 from workspace_database_moves m
               where m.workspace_id = w.id
                 and m.status in ('queued', 'preparing', 'soft_locked', 'locked',
                                  'copying', 'verifying', 'switching', 'cancelling'))
from workspaces w
where w.id = :'ws' and w.neon_project_id like 'cnpg:%';
SQL
  )"
  [ -n "$row" ] || die "no workspace $workspace with a database on a CloudNativePG shard"
  IFS='|' read -r db role shard moving <<<"$row"
  [[ "$db" =~ ^[a-z0-9_]{1,40}$ ]] || die "unexpected database name '$db'"
  [[ "$role" =~ ^[a-z0-9_]{1,63}$ ]] || die "unexpected role name '$role'"
  [[ "$shard" =~ ^[a-z0-9-]{1,40}$ ]] || die "unexpected shard name '$shard'"
  [ "$moving" = "f" ] || die "workspace $workspace has a database move in progress"
}

# A copy of this workspace's database: what restore makes and swap leaves.
is_copy() { [[ "$1" =~ ^${db}_(pitr|pre)_[0-9]{14}$ ]]; }

# Tables and rows in a database, to compare a copy with its source.
count_rows() {
  psql_in "$1" "$2" <<'SQL'
select count(*),
       coalesce(sum((xpath('/row/c/text()', query_to_xml(
         format('select count(*) as c from %I.%I', n.nspname, c.relname),
         false, true, '')))[1]::text::bigint), 0)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname <> 'information_schema'
  and n.nspname not like 'pg\_%';
SQL
}

# The shard's barman-cloud ObjectStore and the serverName it archives to.
backup_source() {
  local filter='{.spec.plugins[?(@.name=="barman-cloud.cloudnative-pg.io")].parameters'
  object_store="$(kc -n "$ns" get cluster "$shard" -o jsonpath="$filter.barmanObjectName}")"
  [ -n "$object_store" ] || die "Cluster $shard archives no WAL through the barman-cloud plugin"
  if [ -z "$server_name" ]; then
    server_name="$(kc -n "$ns" get cluster "$shard" -o jsonpath="$filter.serverName}")"
    server_name="${server_name:-$shard}"
  fi
  window_start="$(kc -n "$ns" get objectstore "$object_store" \
    -o jsonpath="{.status.serverRecoveryWindow.$server_name.firstRecoverabilityPoint}")"
  last_backup="$(kc -n "$ns" get objectstore "$object_store" \
    -o jsonpath="{.status.serverRecoveryWindow.$server_name.lastSuccessfulBackupTime}")"
}

cmd_list() {
  load_placement
  local live_pod
  live_pod="$(primary_of "$shard")"
  backup_source
  echo "workspace $workspace: database $db, role $role, shard $ns/$shard"
  echo "recovery window ($object_store, server $server_name): ${window_start:-unknown} until about 5 minutes ago"
  echo "last base backup: ${last_backup:-unknown}"
  echo
  psql_in "$live_pod" postgres -v db="$db" <<'SQL' | while IFS='|' read -r name size; do
select datname, pg_size_pretty(pg_database_size(datname))
from pg_database
where datname = :'db'
   or (left(datname, length(:'db') + 1) = :'db' || '_'
       and datname ~ '_(pitr|pre)_[0-9]{14}$')
order by datname;
SQL
    if [ "$name" = "$db" ]; then echo "  $name  $size  (live)"; else echo "  $name  $size"; fi
  done
  local temps
  temps="$(kc -n "$ns" get cluster -l weldsuite.org/pitr-restore=true \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.phase}{"\n"}{end}')"
  if [ -n "$temps" ]; then
    echo
    echo "temporary Clusters (delete with: kubectl -n $ns delete cluster <name>):"
    echo "$temps" | sed 's/^/  /'
  fi
}

cmd_restore() {
  [[ "$to" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})[T\ ]([0-9]{2}:[0-9]{2})(:[0-9]{2})?Z$ ]] \
    || die "--to needs a UTC time, YYYY-MM-DDTHH:MM[:SS]Z"
  local target="${BASH_REMATCH[1]}T${BASH_REMATCH[2]}${BASH_REMATCH[3]:-:00}Z"
  local target_s now_s
  target_s="$(epoch "$target")"
  now_s="$(date -u +%s)"
  # WAL reaches the object store within archive_timeout (5 minutes); a target
  # past the newest archived WAL can't be reached and the recovery fails.
  [ "$target_s" -le $((now_s - 600)) ] || die "--to must be at least 10 minutes ago"

  load_placement
  local live_pod
  live_pod="$(primary_of "$shard")"
  backup_source
  [ -n "$window_start" ] || die "ObjectStore $object_store has no recovery window for server $server_name (pass --server-name)"
  [ "$target_s" -ge "$(epoch "$window_start")" ] \
    || die "$target is before the recovery window, which starts at $window_start"

  local stamp="${target:0:4}${target:5:2}${target:8:2}${target:11:2}${target:14:2}${target:17:2}"
  local temp="$shard-pitr-$stamp"
  local copy="${db}_pitr_${stamp}"
  [ "${#copy}" -le 63 ] || die "copy name $copy is longer than Postgres allows"

  local exists
  exists="$(psql_in "$live_pod" postgres -v copy="$copy" <<<"select count(*) from pg_database where datname = :'copy';")"
  [ "$exists" = "0" ] || die "database $copy already exists on $shard (list, drop)"

  if kc -n "$ns" get cluster "$temp" >/dev/null 2>&1; then
    local annotated
    annotated="$(kc -n "$ns" get cluster "$temp" -o jsonpath='{.metadata.annotations.weldsuite\.org/pitr-target}')"
    [ "$annotated" = "$target" ] || die "Cluster $temp exists but was not recovered to $target"
    say "reusing the temporary Cluster $temp"
  else
    say "recovering $shard to $target in a temporary Cluster $temp (server $server_name)"
    local get="kc -n $ns get cluster $shard -o"
    local image params="" key value resources storage wal node_selector tolerations
    image="$($get jsonpath='{.spec.imageName}')"
    [ -n "$image" ] || die "Cluster $shard has no imageName (an image catalog isn't supported here)"
    # Recovery needs these at least as high as on the shard (hot standby).
    for key in max_connections max_worker_processes max_wal_senders \
      max_prepared_transactions max_locks_per_transaction shared_buffers; do
      value="$($get jsonpath="{.spec.postgresql.parameters.$key}")"
      [ -z "$value" ] || params="$params${params:+,}$(json_str "$key"):$(json_str "$value")"
    done
    resources="$($get jsonpath='{.spec.resources}')"
    storage="$($get jsonpath='{.spec.storage}')"
    wal="$($get jsonpath='{.spec.walStorage}')"
    node_selector="$($get jsonpath='{.spec.affinity.nodeSelector}')"
    tolerations="$($get jsonpath='{.spec.affinity.tolerations}')"
    [ -n "$storage" ] || die "Cluster $shard has no storage section"
    # Sections the shard leaves out stay out: an empty nodeSelector ({})
    # differs from the operator's own pod spec, which then rolls the
    # instance over and over.
    local extra="" placement=""
    [ -z "$wal" ] || extra="$extra, \"walStorage\": $wal"
    [ -z "$resources" ] || extra="$extra, \"resources\": $resources"
    [ -z "$node_selector" ] || placement="$placement, \"nodeSelector\": $node_selector"
    [ -z "$tolerations" ] || placement="$placement, \"tolerations\": $tolerations"
    # No `plugins`: the temporary Cluster archives nothing, so the shard's
    # backups are only read.
    kc create -f - <<EOF
{
  "apiVersion": "postgresql.cnpg.io/v1",
  "kind": "Cluster",
  "metadata": {
    "name": $(json_str "$temp"),
    "namespace": $(json_str "$ns"),
    "labels": {"weldsuite.org/pitr-restore": "true", "weldsuite.org/pitr-shard": $(json_str "$shard")},
    "annotations": {"weldsuite.org/pitr-target": $(json_str "$target")}
  },
  "spec": {
    "instances": 1,
    "imageName": $(json_str "$image"),
    "postgresql": {"parameters": {$params}},
    "bootstrap": {
      "recovery": {
        "source": "origin",
        "recoveryTarget": {"targetTime": $(json_str "${target:0:10} ${target:11:8}+00")}
      }
    },
    "externalClusters": [{
      "name": "origin",
      "plugin": {
        "name": "barman-cloud.cloudnative-pg.io",
        "parameters": {"barmanObjectName": $(json_str "$object_store"), "serverName": $(json_str "$server_name")}
      }
    }],
    "storage": $storage$extra,
    "affinity": {"enablePodAntiAffinity": false$placement}
  }
}
EOF
  fi

  say "waiting for the recovery (up to $timeout; WAL replay from the nightly base backup before $target)"
  # Ready comes first; the operator may still restart the promoted instance
  # once after that, so wait for the healthy phase too.
  if ! kc -n "$ns" wait --for=condition=Ready "cluster/$temp" --timeout="$timeout" ||
    ! kc -n "$ns" wait "--for=jsonpath={.status.phase}=Cluster in healthy state" \
      "cluster/$temp" --timeout="$timeout"; then
    kc -n "$ns" get pods -l "cnpg.io/cluster=$temp" >&2 || true
    kc -n "$ns" logs -l "cnpg.io/cluster=$temp" --all-containers --tail=20 >&2 || true
    die "the recovery did not finish; Cluster $temp is left for a look (kubectl -n $ns delete cluster $temp)"
  fi
  local temp_pod
  temp_pod="$(primary_of "$temp")"

  exists="$(psql_in "$temp_pod" postgres -v db="$db" <<<"select count(*) from pg_database where datname = :'db';")"
  [ "$exists" = "1" ] || die "$db did not exist at $target (Cluster $temp is still running)"

  say "copying $db as of $target into $copy on $shard"
  psql_in "$live_pod" postgres -v copy="$copy" -v role="$role" <<'SQL'
CREATE DATABASE :"copy" OWNER :"role" TEMPLATE template1;
REVOKE ALL ON DATABASE :"copy" FROM PUBLIC;
SQL
  # As the superuser, so owners and grants come back as they were; the
  # extensions are already there from template1 (CREATE EXTENSION IF NOT EXISTS).
  if ! kc -n "$ns" exec "$temp_pod" -c postgres -- pg_dump -Fc -d "$db" \
    | kc -n "$ns" exec -i "$live_pod" -c postgres -- \
      pg_restore --single-transaction --exit-on-error -d "$copy"; then
    psql_in "$live_pod" postgres -v copy="$copy" <<<'DROP DATABASE IF EXISTS :"copy";' || true
    die "the copy failed and was dropped (Cluster $temp is still running)"
  fi

  local source_rows copy_rows
  source_rows="$(count_rows "$temp_pod" "$db")"
  copy_rows="$(count_rows "$live_pod" "$copy")"
  [ "$source_rows" = "$copy_rows" ] \
    || die "the copy has ${copy_rows/|/ tables, } rows, the recovered database ${source_rows/|/ tables, } (both kept)"

  if [ "$keep" = true ]; then
    say "kept the temporary Cluster $temp (kubectl -n $ns delete cluster $temp)"
  else
    say "deleting the temporary Cluster $temp"
    kc -n "$ns" delete cluster "$temp" --wait=false >/dev/null
  fi

  local self="$0" ctx="${context:+ --context $context}"
  cat <<EOF

$copy is $db as it was at $target (${copy_rows/|/ tables, } rows), next to the live
database on $shard. The workspace still runs on the live one.

Look at it:   kubectl${context:+ --context $context} -n $ns exec -it $live_pod -c postgres -- psql -d $copy
Make it live: $self swap --workspace $workspace --database $copy$ctx
Drop it:      $self drop --workspace $workspace --database $copy$ctx
EOF
}

cmd_swap() {
  load_placement
  is_copy "$database" || die "--database must be one of $workspace's copies (${db}_pitr_... or ${db}_pre_...)"
  local live_pod
  live_pod="$(primary_of "$shard")"
  local owner
  owner="$(psql_in "$live_pod" postgres -v copy="$database" <<<"select pg_get_userbyid(datdba) from pg_database where datname = :'copy';")"
  [ -n "$owner" ] || die "no database $database on $shard"
  [ "$owner" = "$role" ] || die "$database is owned by $owner, not $role"

  local pre="${db}_pre_$(date -u +%Y%m%d%H%M%S)"
  say "making $database the live database of $workspace; the live one becomes $pre"
  # One transaction for both renames. A rename waits up to 5s for the
  # sessions it needs gone; PgBouncer may reconnect between tries.
  psql_in "$live_pod" postgres -v live="$db" -v copy="$database" -v pre="$pre" <<'SQL'
select set_config('weldsuite.pitr_live', :'live', false),
       set_config('weldsuite.pitr_copy', :'copy', false),
       set_config('weldsuite.pitr_pre', :'pre', false);
DO $swap$
DECLARE
  live text := current_setting('weldsuite.pitr_live');
  copy text := current_setting('weldsuite.pitr_copy');
  pre text := current_setting('weldsuite.pitr_pre');
  tries int := 0;
BEGIN
  LOOP
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname IN (live, copy) AND pid <> pg_backend_pid();
    BEGIN
      EXECUTE format('ALTER DATABASE %I RENAME TO %I', live, pre);
      EXECUTE format('ALTER DATABASE %I RENAME TO %I', copy, live);
      RETURN;
    EXCEPTION WHEN object_in_use THEN
      tries := tries + 1;
      IF tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;
END
$swap$;
SQL

  if [ "$migrate" = true ]; then
    say "bringing $db up to the running build's tenant migrations"
    if ! kc -n "$app_ns" exec "deploy/$app_deploy" -c api -- \
      /usr/local/bin/weldsuite migrate --tenants --only "$workspace"; then
      echo "warning: the migrations failed; run them again with:" >&2
      echo "  kubectl${context:+ --context $context} -n $app_ns exec deploy/$app_deploy -c api -- /usr/local/bin/weldsuite migrate --tenants --only $workspace" >&2
    fi
  fi

  local self="$0" ctx="${context:+ --context $context}"
  cat <<EOF

$workspace now runs on what was $database.
The database it ran on until now is $pre.

Undo:     $self swap --workspace $workspace --database $pre$ctx
Drop it:  $self drop --workspace $workspace --database $pre$ctx
EOF
}

cmd_drop() {
  load_placement
  is_copy "$database" || die "--database must be one of $workspace's copies (${db}_pitr_... or ${db}_pre_...); the live database is never dropped here"
  local live_pod
  live_pod="$(primary_of "$shard")"
  local exists
  exists="$(psql_in "$live_pod" postgres -v copy="$database" <<<"select count(*) from pg_database where datname = :'copy';")"
  [ "$exists" = "1" ] || die "no database $database on $shard"
  if [ "$yes" != true ]; then
    [ -t 0 ] || die "pass --yes to drop $database without a prompt"
    local answer
    read -r -p "Drop $database on $shard for good? Type its name: " answer
    [ "$answer" = "$database" ] || die "not dropped"
  fi
  psql_in "$live_pod" postgres -v copy="$database" <<<'DROP DATABASE :"copy" WITH (FORCE);'
  say "dropped $database"
}

"cmd_$command"
