#!/usr/bin/env bash
# Make the Talos snapshot the servers boot from. Hetzner Cloud has no Talos
# image, so this builds one from Talos' Image Factory (no extensions) and
# uploads it as a snapshot labelled os=talos,talos_version=<version>, which
# servers.tf selects. Run once per Talos release, per Hetzner project.
#
# Needs: HCLOUD_TOKEN, curl, and hcloud-upload-image
# (https://github.com/apricote/hcloud-upload-image; `go install` or a release
# binary). Usage: TALOS_VERSION=v1.14.3 scripts/upload-talos-image.sh
set -euo pipefail

: "${HCLOUD_TOKEN:?set HCLOUD_TOKEN}"
version="${TALOS_VERSION:-v1.14.3}"
location="${LOCATION:-fsn1}"
here="$(cd "$(dirname "$0")" && pwd)"

# The schematic says which extensions go into the image (none: Talos on
# Hetzner needs no extra drivers). Its id is a hash of the file.
schematic="$(curl -fsS -X POST --data-binary @"$here/schematic.yaml" https://factory.talos.dev/schematics \
  | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')"
[ -n "$schematic" ] || { echo "Image Factory returned no schematic id" >&2; exit 1; }
echo "schematic $schematic, Talos $version"

hcloud-upload-image upload \
  --image-url "https://factory.talos.dev/image/$schematic/$version/hcloud-amd64.raw.xz" \
  --compression xz \
  --architecture x86 \
  --location "$location" \
  --description "Talos $version ($schematic)" \
  --labels "os=talos,talos_version=$version,schematic=${schematic:0:32}"
