#!/usr/bin/env bash
# Build the release payload consumed by the draft GitHub Release.
# Run only after the TypeScript release gate has passed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/agent-mail"
OUTPUT_INPUT="${1:-$ROOT/dist}"

case "/$OUTPUT_INPUT/" in
  */../*)
    echo "error: release output path must not contain '..': $OUTPUT_INPUT" >&2
    exit 1
    ;;
esac
if [[ "$OUTPUT_INPUT" = /* ]]; then
  OUTPUT_LEXICAL="$OUTPUT_INPUT"
else
  OUTPUT_LEXICAL="$ROOT/$OUTPUT_INPUT"
fi

if [[ -L "$OUTPUT_LEXICAL" ]]; then
  echo "error: release output directory must not be a symlink: $OUTPUT_LEXICAL" >&2
  exit 1
fi
OUTPUT="$(realpath -m -- "$OUTPUT_LEXICAL")"

case "$OUTPUT" in
  / | "$ROOT" | "$PKG")
    echo "error: unsafe release output directory: $OUTPUT" >&2
    exit 1
    ;;
esac

if [[ -d "$OUTPUT" ]] && find "$OUTPUT" -mindepth 1 -print -quit | grep -q .; then
  echo "error: release output directory must be empty: $OUTPUT" >&2
  exit 1
fi
mkdir -p "$OUTPUT"

TS_VERSION="$(node -p 'require(process.argv[1]).version' "$PKG/package.json")"
EXPECTED_TARBALL="agent-mail-$TS_VERSION.tgz"
PACKED_NAME="$(cd "$PKG" && npm pack --silent --pack-destination "$OUTPUT")"
if [[ "$PACKED_NAME" != "$EXPECTED_TARBALL" ]]; then
  echo "error: npm produced $PACKED_NAME, expected $EXPECTED_TARBALL" >&2
  exit 1
fi

SBOM_TMP="$OUTPUT/.agent-mail-$TS_VERSION.sbom.tmp"
npm --prefix "$PKG" sbom \
  --omit=dev \
  --sbom-format=cyclonedx >"$SBOM_TMP"
mv "$SBOM_TMP" "$OUTPUT/agent-mail-$TS_VERSION.sbom.cdx.json"

(
  cd "$OUTPUT"
  CHECKSUM_TMP=.SHA256SUMS.tmp
  : >"$CHECKSUM_TMP"
  while IFS= read -r file; do
    sha256sum "$file" >>"$CHECKSUM_TMP"
  done < <(
    find . -maxdepth 1 -type f \
      ! -name SHA256SUMS \
      ! -name "$CHECKSUM_TMP" \
      -printf '%f\n' |
      LC_ALL=C sort
  )
  [[ -s "$CHECKSUM_TMP" ]] || {
    echo "error: no release artifacts were built" >&2
    exit 1
  }
  mv "$CHECKSUM_TMP" SHA256SUMS
  sha256sum --check SHA256SUMS
)

printf 'release artifacts:\n'
find "$OUTPUT" -maxdepth 1 -type f -printf '  %f\n' | LC_ALL=C sort
