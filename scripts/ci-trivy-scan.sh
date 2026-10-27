#!/usr/bin/env bash
# Scans each per-architecture image digest with Trivy for the publish workflow.
#
#   IMAGE=ghcr.io/owner/pasokh TRIVY_IMAGE=aquasec/trivy@sha256:... \
#     scripts/ci-trivy-scan.sh /tmp/digests
#
# Each file in the directory is named after an image digest (without "sha256:")
# and holds the platform it was built for (linux/amd64 or linux/arm64). The
# build pushes by digest and the registry returns an OCI index, which Trivy
# resolves for linux/amd64 unless told otherwise, so the platform is passed
# explicitly.
#
# Fails closed: no digests, an unknown platform, Trivy failing to open the image
# (no report written), a report for a different architecture than the one
# requested, or any fixable HIGH/CRITICAL finding all end in a non-zero exit.
set -euo pipefail

digests_dir=${1:?usage: ci-trivy-scan.sh <digests dir>}
image=${IMAGE:?IMAGE is required}
trivy_image=${TRIVY_IMAGE:?TRIVY_IMAGE is required}
workspace=${GITHUB_WORKSPACE:-$PWD}
out_dir=${TRIVY_OUT_DIR:-$(mktemp -d)}
mkdir -p "$out_dir"

shopt -s nullglob
files=("$digests_dir"/*)
if [ "${#files[@]}" -eq 0 ]; then
  echo "::error::No image digests in $digests_dir, nothing was scanned."
  exit 1
fi

failed=0
for file in "${files[@]}"; do
  digest="sha256:$(basename "$file")"
  platform=$(tr -d '[:space:]' < "$file")
  case "$platform" in
    linux/amd64 | linux/arm64) ;;
    *)
      echo "::error::Unexpected platform '$platform' in $file."
      exit 1
      ;;
  esac
  arch=${platform#linux/}
  report="$out_dir/trivy-$arch.json"
  rm -f "$report"

  echo "::group::Trivy $platform $image@$digest"
  rc=0
  docker run --rm -e TRIVY_USERNAME -e TRIVY_PASSWORD \
    -v "$workspace/.trivyignore:/.trivyignore:ro" \
    -v "$out_dir:/out" \
    "$trivy_image" \
    image --platform "$platform" --scanners vuln \
    --severity HIGH,CRITICAL --ignore-unfixed \
    --ignorefile /.trivyignore --skip-dirs usr/local/lib/node_modules/npm \
    --exit-code 1 --no-progress \
    --format json --output "/out/trivy-$arch.json" \
    "$image@$digest" || rc=$?
  echo "::endgroup::"

  # No report means Trivy never got as far as scanning (image not found, DB
  # error, ...): a failure, never a pass.
  if [ ! -s "$report" ]; then
    echo "::error::Trivy wrote no report for $platform (exit $rc); the image was not scanned."
    failed=1
    continue
  fi
  scanned=$(jq -r '.Metadata.ImageConfig.architecture // empty' "$report")
  if [ "$scanned" != "$arch" ]; then
    echo "::error::Asked Trivy for $platform but the report is for '${scanned:-unknown}'."
    failed=1
    continue
  fi

  jq -r --arg platform "$platform" --arg digest "$digest" '
    ([.Results[]?.Vulnerabilities[]?]) as $v
    | "Trivy \($platform) \($digest): \(.Results // [] | length) target(s) scanned, \($v | length) finding(s) "
      + "(CRITICAL=\($v | map(select(.Severity == "CRITICAL")) | length), HIGH=\($v | map(select(.Severity == "HIGH")) | length))"' "$report"
  jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]?
    | "  \(.Severity) \(.VulnerabilityID) \(.PkgName) \(.InstalledVersion) fixed in \(.FixedVersion) [\($t)]"' "$report"

  if [ "$rc" -ne 0 ]; then
    echo "::error::Trivy exited $rc for $platform: fixable HIGH or CRITICAL findings, or a scan error."
    failed=1
  fi
done

exit "$failed"
