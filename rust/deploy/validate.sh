#!/usr/bin/env bash
# Checks the Kubernetes deploy configuration without a cloud account (CI job
# `Rust · deploy config`, and the deploy repository's own validation):
#   1. OpenTofu: formatting and `tofu validate` of rust/deploy/hetzner;
#   2. every Flux base layer built with kustomize, ${NAME} substituted from
#      SETTINGS, and schema-checked with kubeconform (Flux, CloudNativePG,
#      cert-manager and External Secrets CRDs from the community catalog),
#      the secrets layer with each of its components, and that layer checked
#      against the store's values (flux/scripts/seed-secrets.mjs --check);
#   3. every cluster in CLUSTERS_DIR: its files and its own configs folders
#      schema-checked and, with the flux CLI, the whole cluster built the way
#      Flux builds it (both sources, every layer's patches, the cluster's own
#      settings substituted) and schema-checked;
#   4. with SECRETS_DIR, for clusters still on SOPS: every secrets folder in
#      it (and each subfolder of one with a kustomization.yaml, such as
#      weldid/) built and schema-checked, and every Secret in it encrypted
#      with SOPS (each data and stringData value ENC[...], and a sops block);
#   5. every HelmRelease's chart rendered at its pinned version with its own
#      values file and schema-checked, after checking the pin in the
#      HelmRelease matches the one here, and again with the weldid-switch
#      layer's values over them where it has some; WeldID's chart too when
#      WELDID_CHART names it (below); then every image the layers' own
#      manifests run (chart values aside) is one pinned here, at its version;
#   6. with an eu cluster: the weldsuite version production pins
#      (WELDSUITE_VERSION) is a release X.Y.Z or a main build X.Y.Z-main.N
#      (ADR OPS-020), and a drill cluster pins the same one; a cluster whose
#      sources.yaml follows a weldsuite-v tag follows its own release's, and
#      one that pins a commit runs a main build.
#
# By default it checks this repository: the base layers and the example
# cluster (flux/clusters/example). The deploy repository points it at its own
# folders (relative paths are taken from where it is started):
#   CLUSTERS_DIR  a folder of cluster folders (default: flux/clusters)
#   SECRETS_DIR   a folder of SOPS secrets folders, one per cluster not yet
#                 on a secret store (default: none)
#   CONFIG_ROOT   the repository the clusters' GitRepository flux-system reads
#                 (default: this one); GitRepository weldsuite is this one
#   SETTINGS      the cluster settings for steps 2 and 5 (default: the
#                 example cluster's)
#   WELDID_CHART  WeldID's chart for step 5: a folder (a checkout of
#                 weldsuite/weldid, deploy/helm/weldid) or oci://… (rendered
#                 at the settings' WELDID_VERSION; private until WeldID 1.0,
#                 so `helm registry login ghcr.io` first). Unset: not rendered.
# Needs tofu, kubectl (kustomize), helm, kubeconform, node; flux (v2.9) for
# the full cluster builds in step 3.
set -euo pipefail

# Absolute paths, in the form the tools take (Git Bash on Windows: E:/...).
abs() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
here="$(abs "$(dirname "$0")")"
repo="$(abs "$here/../..")"
clusters="$(abs "${CLUSTERS_DIR:-$here/flux/clusters}")"
secrets="${SECRETS_DIR:+$(abs "$SECRETS_DIR")}"
config_root="$(abs "${CONFIG_ROOT:-$repo}")"
settings="${SETTINGS:-$here/flux/clusters/example/cluster-settings.yaml}"
settings="$(abs "$(dirname "$settings")")/$(basename "$settings")"
weldid_chart="${WELDID_CHART:-}"
case "$weldid_chart" in
  "" | oci://*) ;;
  *) weldid_chart="$(abs "$weldid_chart")" ;;
esac
cd "$here"

catalog='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
kc() {
  kubeconform -strict -summary -ignore-missing-schemas \
    -schema-location default -schema-location "$catalog" "$@"
}

# ${NAME} and ${NAME:=default} -> a cluster's settings (Flux's postBuild
# substitution); a name the settings leave out takes its default.
substitute() {
  local script
  script="$(tr -d '\r' <"$1" | awk '/^data:/{d=1;next} d && /^  [A-Z0-9_]+:/{k=$1; sub(":","",k); v=$0; sub(/^  [A-Z0-9_]+: */,"",v); gsub(/^"|"$/,"",v); gsub(/[\/&]/,"\\\\&",v); printf "s/[$][{]%s(:=[^}]*)?[}]/%s/g;", k, v}')"
  sed -E -e "$script" -e 's/[$][{][A-Z0-9_]+:=([^}]*)[}]/\1/g'
}

# SOPS-encrypted Secrets carry a top-level `sops:` block that Flux removes
# when it decrypts them; the strict Secret schema would refuse it.
strip_sops() {
  awk '/^sops:/{skip=1; next} skip && /^[^ ]/{skip=0} !skip'
}

# Every Secret in a file is encrypted with SOPS: each data and stringData
# value is ENC[...] (comments too: #ENC[...]), and the document has a sops
# block.
encrypted() {
  tr -d '\r' <"$1" | awk -v file="$1" '
    function end_doc() {
      if (secret && !sops) { print "FAIL " file ": Secret " name " has no sops block" > "/dev/stderr"; bad = 1 }
      secret = 0; sops = 0; values = 0; meta = 0; name = "?"
    }
    BEGIN { name = "?" }
    /^---/ { end_doc(); next }
    /^kind: Secret *$/ { secret = 1 }
    /^sops:/ { sops = 1 }
    /^metadata:/ { meta = 1; next }
    meta && /^ +name:/ { name = $2; meta = 0 }
    /^(data|stringData):/ { values = ($0 !~ /\{\} *$/); next }
    /^[^ ]/ { values = 0; meta = 0 }
    values && NF && $0 !~ /^ +([^ #:]+: |#)ENC\[/ { print "FAIL " file ": a value or comment of Secret " name " is not ENC[...]" > "/dev/stderr"; bad = 1 }
    END { end_doc(); exit bad }'
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== OpenTofu"
tofu -chdir=hetzner fmt -check -recursive
tofu -chdir=hetzner init -backend=false -input=false >/dev/null
tofu -chdir=hetzner validate
# The cluster's secret store: a module of its own (its own state).
tofu -chdir=hetzner/secret-store init -backend=false -input=false >/dev/null
tofu -chdir=hetzner/secret-store validate

echo "== Flux base layers (settings: $settings)"
for dir in \
  flux/infrastructure/sources \
  flux/infrastructure/controllers \
  flux/infrastructure/configs/base \
  flux/infrastructure/services \
  flux/infrastructure/video \
  flux/infrastructure/monitoring \
  flux/infrastructure/monitoring-config \
  flux/infrastructure/logging \
  flux/infrastructure/offsite-copy \
  flux/infrastructure/network-policy \
  flux/infrastructure/weldid/namespace \
  flux/infrastructure/weldid \
  flux/apps/eu \
  flux/apps/marketing \
  flux/apps/weldid-switch; do
  echo "-- $dir"
  kubectl kustomize "$dir" | substitute "$settings" | kc -
done
# The example cluster's opt-in layers, which its kustomization.yaml leaves
# out (so step 3 doesn't build them).
echo "-- opt-in layers (flux/clusters/example)"
kc flux/clusters/example/weldid.yaml flux/clusters/example/weldid-switch.yaml \
  flux/clusters/example/offsite-copy.yaml flux/clusters/example/network-policy.yaml
# The secrets layer, and each component a cluster can add to it. Its one
# setting is SECRET_STORE_URL, which a cluster still on SOPS leaves empty (an
# empty server fails the schema), so the example cluster's settings; a
# cluster that runs the layer is built with its own in step 3.
for dir in flux/secrets flux/secrets/*/; do
  dir="${dir%/}"
  echo "-- $dir"
  kubectl kustomize "$dir" | substitute "$here/flux/clusters/example/cluster-settings.yaml" | kc -
done
node flux/scripts/seed-secrets.mjs --check

echo "== Clusters ($clusters)"
if command -v flux >/dev/null; then
  have_flux=1
else
  have_flux=0
  echo "(no flux CLI: the clusters' layers are not built with their patches)"
fi
for cluster in "$clusters"/*/; do
  cluster="${cluster%/}"
  own="$cluster/cluster-settings.yaml"
  echo "-- $(basename "$cluster")"
  if [ -f "$cluster/kustomization.yaml" ]; then
    kubectl kustomize "$cluster" | kc -
  else
    kc "$cluster"/*.yaml
  fi
  # Its own configs (configs-extra), with its settings.
  for sub in "$cluster"/*/; do
    [ -d "$sub" ] || continue
    kubectl kustomize "$sub" | substitute "$own" | kc -
  done
  [ "$have_flux" = 1 ] || continue
  case "$cluster" in
    "$config_root"/*) ;;
    *) echo "FAIL $cluster is not in CONFIG_ROOT ($config_root)" >&2; exit 1 ;;
  esac
  # The flux-system Kustomization the cluster is bootstrapped with, built
  # recursively: GitRepository flux-system is CONFIG_ROOT, weldsuite this
  # repository. A dry run: Secrets come out as **SOPS**, nothing is decrypted.
  cat >"$work/flux-system.yaml" <<YAML
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 10m
  path: ./${cluster#"$config_root"/}
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
YAML
  flux build kustomization flux-system --path "$cluster" \
    --kustomization-file "$work/flux-system.yaml" --recursive --dry-run \
    --local-sources "GitRepository/flux-system/flux-system=$config_root,GitRepository/flux-system/weldsuite=$repo" \
    | substitute "$own" | kc -
done

if [ -n "$secrets" ]; then
  echo "== SOPS secrets ($secrets)"
  # A cluster's secrets folder, and its own layers' folders in it (weldid/,
  # the weldid-secrets layer).
  for dir in "$secrets"/*/ "$secrets"/*/*/; do
    dir="${dir%/}"
    rel="${dir#"$secrets"/}"
    case "$rel" in
      */*) [ -f "$dir/kustomization.yaml" ] || continue ;;
    esac
    echo "-- $rel"
    for file in "$dir"/*.yaml; do
      [ "$(basename "$file")" = kustomization.yaml ] || encrypted "$file"
    done
    kubectl kustomize "$dir" | strip_sops | kc -
  done
fi

echo "== Helm releases (chart, version, values)"
# name  namespace  chart (repo/chart or oci://…)  version  values  release file
# [values the weldid-switch layer lays over them]
switch=flux/apps/weldid-switch/values
releases=(
  "openebs-localpv openebs https://openebs.github.io/dynamic-localpv-provisioner|localpv-provisioner 4.6.0 flux/infrastructure/controllers/values/openebs-localpv.yaml flux/infrastructure/controllers/releases.yaml"
  "cert-manager cert-manager https://charts.jetstack.io|cert-manager v1.21.2 flux/infrastructure/controllers/values/cert-manager.yaml flux/infrastructure/controllers/releases.yaml"
  "traefik traefik https://traefik.github.io/charts|traefik 41.7.1 flux/infrastructure/controllers/values/traefik.yaml flux/infrastructure/controllers/releases.yaml"
  "cloudnative-pg cnpg-system https://cloudnative-pg.github.io/charts|cloudnative-pg 0.29.1 flux/infrastructure/controllers/values/cloudnative-pg.yaml flux/infrastructure/controllers/releases.yaml"
  "plugin-barman-cloud cnpg-system https://cloudnative-pg.github.io/charts|plugin-barman-cloud 0.8.1 flux/infrastructure/controllers/values/plugin-barman-cloud.yaml flux/infrastructure/controllers/releases.yaml"
  "metrics-server kube-system https://kubernetes-sigs.github.io/metrics-server|metrics-server 3.14.0 flux/infrastructure/controllers/values/metrics-server.yaml flux/infrastructure/controllers/releases.yaml"
  "external-secrets external-secrets https://charts.external-secrets.io|external-secrets 2.14.0 flux/infrastructure/controllers/values/external-secrets.yaml flux/infrastructure/controllers/releases.yaml"
  "kube-prometheus-stack monitoring https://prometheus-community.github.io/helm-charts|kube-prometheus-stack 92.3.1 flux/infrastructure/monitoring/values/kube-prometheus-stack.yaml flux/infrastructure/monitoring/releases.yaml $switch/kube-prometheus-stack.yaml"
  "blackbox-exporter monitoring https://prometheus-community.github.io/helm-charts|prometheus-blackbox-exporter 11.20.2 flux/infrastructure/monitoring/values/blackbox-exporter.yaml flux/infrastructure/monitoring/releases.yaml"
  "loki logging https://grafana.github.io/helm-charts|loki 7.5.0 flux/infrastructure/logging/values/loki.yaml flux/infrastructure/logging/releases.yaml"
  "fluent-bit logging https://fluent.github.io/helm-charts|fluent-bit 0.58.3 flux/infrastructure/logging/values/fluent-bit.yaml flux/infrastructure/logging/releases.yaml"
  "fluent-bit-events logging https://fluent.github.io/helm-charts|fluent-bit 0.58.3 flux/infrastructure/logging/values/fluent-bit-events.yaml flux/infrastructure/logging/releases.yaml"
  "nats weldsuite https://nats-io.github.io/k8s/helm/charts|nats 2.15.0 flux/infrastructure/services/values/nats.yaml flux/infrastructure/services/releases.yaml"
  "valkey weldsuite https://valkey.io/valkey-helm|valkey 0.12.0 flux/infrastructure/services/values/valkey.yaml flux/infrastructure/services/releases.yaml"
  "restate weldsuite oci://ghcr.io/restatedev/restate-helm 1.7.13 flux/infrastructure/services/values/restate.yaml flux/infrastructure/services/releases.yaml"
  "zitadel zitadel https://charts.zitadel.com|zitadel 10.4.0 flux/infrastructure/services/values/zitadel.yaml flux/infrastructure/services/releases.yaml $switch/zitadel.yaml"
  "livekit livekit https://helm.livekit.io|livekit-server 1.9.0 flux/infrastructure/video/values/livekit.yaml flux/infrastructure/video/release.yaml"
)
for entry in "${releases[@]}"; do
  read -r name namespace chart version values pinfile overlay <<<"$entry"
  echo "-- $name $version"
  # The HelmRelease (or the OCIRepository tag) pins the same version.
  if ! grep -Eq "(version|tag): \"?$version\"?$" "$pinfile"; then
    echo "FAIL $name: $pinfile does not pin $version" >&2
    exit 1
  fi
  substitute "$settings" <"$values" >"$work/values.yaml"
  if [[ "$chart" == oci://* ]]; then
    args=("$chart" --version "$version")
  else
    args=("${chart#*|}" --repo "${chart%%|*}" --version "$version")
  fi
  helm template "$name" "${args[@]}" --namespace "$namespace" --kube-version 1.34.0 \
    -f "$work/values.yaml" >"$work/rendered.yaml"
  kc "$work/rendered.yaml"
  [ -n "${overlay:-}" ] || continue
  echo "-- $name $version, with $overlay"
  substitute "$settings" <"$overlay" >"$work/overlay.yaml"
  helm template "$name" "${args[@]}" --namespace "$namespace" --kube-version 1.34.0 \
    -f "$work/values.yaml" -f "$work/overlay.yaml" >"$work/rendered.yaml"
  kc "$work/rendered.yaml"
done

echo "-- weldsuite (rust/deploy/helm/weldsuite)"
substitute "$settings" <flux/apps/eu/values/weldsuite.yaml >"$work/values.yaml"
helm template weldsuite helm/weldsuite --namespace weldsuite -f "$work/values.yaml" >"$work/rendered.yaml"
kc "$work/rendered.yaml"
echo "-- weldsuite, with $switch/weldsuite.yaml"
substitute "$settings" <"$switch/weldsuite.yaml" >"$work/overlay.yaml"
helm template weldsuite helm/weldsuite --namespace weldsuite -f "$work/values.yaml" \
  -f "$work/overlay.yaml" >"$work/rendered.yaml"
kc "$work/rendered.yaml"

# WeldID's chart lives in its own repository, and its packages are private
# until WeldID 1.0: rendered only when WELDID_CHART says where it is.
if [ -n "$weldid_chart" ]; then
  if [[ "$weldid_chart" == oci://* ]]; then
    weldid_version="$(tr -d '\r' <"$settings" | awk '$1 == "WELDID_VERSION:" { v = $2; gsub(/"/, "", v); print v }')"
    args=("$weldid_chart" --version "$weldid_version")
  else
    args=("$weldid_chart")
  fi
  substitute "$settings" <flux/infrastructure/weldid/values/weldid.yaml >"$work/values.yaml"
  substitute "$settings" <"$switch/weldid.yaml" >"$work/overlay.yaml"
  echo "-- weldid ($weldid_chart)"
  helm template weldid "${args[@]}" --namespace weldid --kube-version 1.34.0 \
    -f "$work/values.yaml" >"$work/rendered.yaml"
  kc "$work/rendered.yaml"
  echo "-- weldid, with $switch/weldid.yaml"
  helm template weldid "${args[@]}" --namespace weldid --kube-version 1.34.0 \
    -f "$work/values.yaml" -f "$work/overlay.yaml" >"$work/rendered.yaml"
  kc "$work/rendered.yaml"
else
  echo "(no WELDID_CHART: WeldID's chart not rendered)"
fi

echo "== Images (the layers' own manifests)"
# image  the manifests that run it. Every image: and imageName: in a
# manifest under flux/infrastructure and flux/apps must be one of these, at
# this version; chart values (values/ folders) are pinned with their charts
# above.
images=(
  "docker.io/rclone/rclone:1.75.2 flux/infrastructure/offsite-copy/cronjob.yaml"
  "docker.io/cloudnativelabs/kube-router:v2.11.2 flux/infrastructure/network-policy/kube-router.yaml flux/infrastructure/network-policy/metadata-guard.yaml"
  "ghcr.io/alex1989hu/kubelet-serving-cert-approver:0.12.1 flux/infrastructure/controllers/kubelet-serving-cert-approver.yaml"
  "ghcr.io/cloudnative-pg/postgresql:17.8-standard-trixie flux/infrastructure/configs/base/postgres.yaml flux/infrastructure/weldid/database.yaml"
)
# The image references a manifest names, one per line.
image_refs() { tr -d '\r' <"$1" | sed -nE 's/^[ -]*(image|imageName): *"?([^" ]+)"?[[:space:]]*$/\2/p'; }
pinned=""
for entry in "${images[@]}"; do
  read -r image files <<<"$entry"
  echo "-- $image"
  pinned="$pinned$image"$'\n'
  for file in $files; do
    if ! image_refs "$file" | grep -Fx "$image" >/dev/null; then
      echo "FAIL $file does not run $image" >&2
      exit 1
    fi
  done
done
while IFS= read -r file; do
  while IFS= read -r ref; do
    if ! printf '%s' "$pinned" | grep -Fx "$ref" >/dev/null; then
      echo "FAIL $file runs $ref, which is not pinned here" >&2
      exit 1
    fi
  done < <(image_refs "$file")
done < <(grep -rlE --include='*.yaml' --exclude-dir=values '^[ -]*(image|imageName): ' flux/infrastructure flux/apps)

echo "== weldsuite version"
# A release from the "Rust release" workflow (.github/workflows/rust-release.yml),
# X.Y.Z, or a main build's chart from "Rust images" (rust-images.yml),
# X.Y.Z-main.N: EU production follows the main builds the test cluster ran
# (ADR OPS-020); self-hosted installs take the releases.
release_of() { tr -d '\r' <"$1" | awk '$1 == "WELDSUITE_VERSION:" { v = $2; gsub(/"/, "", v); print v }'; }
if [ -f "$clusters/eu/cluster-settings.yaml" ]; then
  production="$(release_of "$clusters/eu/cluster-settings.yaml")"
  if ! [[ "$production" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-main\.[0-9]+)?$ ]]; then
    echo "FAIL clusters/eu: WELDSUITE_VERSION '$production' is neither X.Y.Z nor X.Y.Z-main.N" >&2
    exit 1
  fi
  if [ -f "$clusters/drill/cluster-settings.yaml" ]; then
    drill="$(release_of "$clusters/drill/cluster-settings.yaml")"
    if [ "$drill" != "$production" ]; then
      echo "FAIL clusters/drill: WELDSUITE_VERSION '$drill' is not production's '$production'" >&2
      exit 1
    fi
  fi
  echo "production: $production"
else
  echo "(no eu cluster: production's release not checked)"
fi
# Base layers at a release tag (sources.yaml) follow the cluster's own
# release; base layers at a commit go with a main build (the build's commit,
# or the later commit on main whose passing CI vouched for the build: one that
# changed none of the paths the build is made from; ADR OPS-020).
for cluster in "$clusters"/*/; do
  cluster="${cluster%/}"
  [ -f "$cluster/sources.yaml" ] || continue
  commit="$(tr -d '\r' <"$cluster/sources.yaml" | awk '$1 == "commit:" { print $2; exit }')"
  if [ -n "$commit" ]; then
    version="$(release_of "$cluster/cluster-settings.yaml")"
    if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
      echo "FAIL $(basename "$cluster"): sources.yaml pins '$commit', not a 40-character commit" >&2
      exit 1
    fi
    if ! [[ "$version" =~ -main\.[0-9]+$ ]]; then
      echo "FAIL $(basename "$cluster"): base layers at a commit, but WELDSUITE_VERSION '$version' is not a main build" >&2
      exit 1
    fi
    echo "$(basename "$cluster"): base layers at $commit ($version)"
    continue
  fi
  tag="$(tr -d '\r' <"$cluster/sources.yaml" | awk '$1 == "tag:" { print $2; exit }')"
  case "$tag" in
    weldsuite-v*) ;;
    *) continue ;;
  esac
  want="weldsuite-v$(release_of "$cluster/cluster-settings.yaml")"
  if [ "$tag" != "$want" ]; then
    echo "FAIL $(basename "$cluster"): sources.yaml follows $tag, not $want (WELDSUITE_VERSION)" >&2
    exit 1
  fi
  echo "$(basename "$cluster"): base layers at $tag"
done

echo "deploy config: ok"
