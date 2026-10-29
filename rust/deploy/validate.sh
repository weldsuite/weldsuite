#!/usr/bin/env bash
# Checks the EU deploy configuration without a cloud account (CI job
# `Rust · deploy config`):
#   1. OpenTofu: formatting and `tofu validate` of rust/deploy/hetzner;
#   2. every Flux layer built with kustomize, ${SETTINGS} substituted from the
#      eu cluster's settings, and schema-checked with kubeconform (Flux,
#      CloudNativePG and cert-manager CRDs from the community catalog);
#   3. every HelmRelease's chart rendered at its pinned version with its own
#      values file and schema-checked, after checking the pin in the
#      HelmRelease matches the one here.
# Needs tofu, kubectl (kustomize), helm, kubeconform.
set -euo pipefail
cd "$(dirname "$0")"

catalog='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
kc() {
  kubeconform -strict -summary -ignore-missing-schemas \
    -schema-location default -schema-location "$catalog" "$@"
}

# ${NAME} -> the eu cluster's settings (Flux's postBuild substitution).
settings="flux/clusters/eu/cluster-settings.yaml"
substitute() {
  local script
  script="$(awk '/^data:/{d=1;next} d && /^  [A-Z_]+:/{k=$1; sub(":","",k); v=$0; sub(/^  [A-Z_]+: */,"",v); gsub(/[\/&]/,"\\\\&",v); printf "s/[$][{]%s[}]/%s/g;", k, v}' "$settings")"
  sed -e "$script"
}

echo "== OpenTofu"
tofu -chdir=hetzner fmt -check -recursive
tofu -chdir=hetzner init -backend=false -input=false >/dev/null
tofu -chdir=hetzner validate

echo "== Flux layers"
kc flux/clusters/eu/*.yaml flux/clusters/drill/*.yaml
for dir in \
  flux/infrastructure/sources \
  flux/infrastructure/controllers \
  flux/infrastructure/configs/eu \
  flux/infrastructure/configs/drill \
  flux/infrastructure/services \
  flux/apps/eu \
  flux/secrets/eu \
  flux/secrets/drill; do
  echo "-- $dir"
  kubectl kustomize "$dir" | substitute | kc -
done
echo "-- secret templates"
kc flux/secrets/examples/secrets.example.yaml

echo "== Helm releases (chart, version, values)"
# name  namespace  chart (repo/chart or oci://…)  version  values  release file
releases=(
  "openebs-localpv openebs https://openebs.github.io/dynamic-localpv-provisioner|localpv-provisioner 4.6.0 flux/infrastructure/controllers/values/openebs-localpv.yaml flux/infrastructure/controllers/releases.yaml"
  "cert-manager cert-manager https://charts.jetstack.io|cert-manager v1.21.2 flux/infrastructure/controllers/values/cert-manager.yaml flux/infrastructure/controllers/releases.yaml"
  "traefik traefik https://traefik.github.io/charts|traefik 41.7.1 flux/infrastructure/controllers/values/traefik.yaml flux/infrastructure/controllers/releases.yaml"
  "cloudnative-pg cnpg-system https://cloudnative-pg.github.io/charts|cloudnative-pg 0.29.1 flux/infrastructure/controllers/values/cloudnative-pg.yaml flux/infrastructure/controllers/releases.yaml"
  "plugin-barman-cloud cnpg-system https://cloudnative-pg.github.io/charts|plugin-barman-cloud 0.8.1 flux/infrastructure/controllers/values/plugin-barman-cloud.yaml flux/infrastructure/controllers/releases.yaml"
  "nats weldsuite https://nats-io.github.io/k8s/helm/charts|nats 2.15.0 flux/infrastructure/services/values/nats.yaml flux/infrastructure/services/releases.yaml"
  "valkey weldsuite https://valkey.io/valkey-helm|valkey 0.12.0 flux/infrastructure/services/values/valkey.yaml flux/infrastructure/services/releases.yaml"
  "restate weldsuite oci://ghcr.io/restatedev/restate-helm 1.7.13 flux/infrastructure/services/values/restate.yaml flux/infrastructure/sources/helm-repositories.yaml"
  "zitadel zitadel https://charts.zitadel.com|zitadel 10.4.0 flux/infrastructure/services/values/zitadel.yaml flux/infrastructure/services/releases.yaml"
)
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for entry in "${releases[@]}"; do
  read -r name namespace chart version values pinfile <<<"$entry"
  echo "-- $name $version"
  # The HelmRelease (or the OCIRepository tag) pins the same version.
  if ! grep -Eq "(version|tag): \"?$version\"?$" "$pinfile"; then
    echo "FAIL $name: $pinfile does not pin $version" >&2
    exit 1
  fi
  substitute <"$values" >"$work/values.yaml"
  if [[ "$chart" == oci://* ]]; then
    args=("$chart" --version "$version")
  else
    args=("${chart#*|}" --repo "${chart%%|*}" --version "$version")
  fi
  helm template "$name" "${args[@]}" --namespace "$namespace" --kube-version 1.34.0 \
    -f "$work/values.yaml" >"$work/rendered.yaml"
  kc "$work/rendered.yaml"
done

echo "-- weldsuite (rust/deploy/helm/weldsuite)"
substitute <flux/apps/eu/values/weldsuite.yaml >"$work/values.yaml"
helm template weldsuite helm/weldsuite --namespace weldsuite -f "$work/values.yaml" >"$work/rendered.yaml"
kc "$work/rendered.yaml"

echo "deploy config: ok"
