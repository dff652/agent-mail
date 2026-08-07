#!/usr/bin/env bash
# Build the release payload consumed by the draft GitHub Release.
# Run only after the TypeScript release gate has passed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/agent-mail"
OUTPUT_INPUT="${1:-$ROOT/dist}"
OUTPUT=""
SBOM_WORKDIR=""
SBOM_WORKDIR_ID=""

cleanup() {
  local status=$?
  local current_id

  trap - EXIT HUP INT TERM
  if [[ -n "$SBOM_WORKDIR" ]]; then
    case "$SBOM_WORKDIR" in
      / | "$ROOT" | "$PKG" | "$OUTPUT")
        echo "error: refusing unsafe SBOM cleanup path: $SBOM_WORKDIR" >&2
        exit 1
        ;;
    esac
    if [[ -L "$SBOM_WORKDIR" || ! -d "$SBOM_WORKDIR" ]]; then
      echo "error: refusing to clean replaced SBOM work directory: $SBOM_WORKDIR" >&2
      exit 1
    fi
    current_id="$(stat --format='%d:%i' -- "$SBOM_WORKDIR")"
    if [[ "$current_id" != "$SBOM_WORKDIR_ID" ]]; then
      echo "error: refusing to clean changed SBOM work directory: $SBOM_WORKDIR" >&2
      exit 1
    fi
    rm -rf --one-file-system -- "$SBOM_WORKDIR"
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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

SBOM_WORKDIR="$(mktemp -d)"
if [[ ! "$SBOM_WORKDIR" = /* || -L "$SBOM_WORKDIR" || ! -d "$SBOM_WORKDIR" ]]; then
  echo "error: mktemp did not create a safe SBOM work directory" >&2
  exit 1
fi
SBOM_WORKDIR_ID="$(stat --format='%d:%i' -- "$SBOM_WORKDIR")"
TARBALL="$OUTPUT/$PACKED_NAME"
ARCHIVE_LIST="$SBOM_WORKDIR/archive.list"
UNPACK_ROOT="$SBOM_WORKDIR/unpacked"
INSTALL_ROOT="$UNPACK_ROOT/package"
EMPTY_USER_CONFIG="$SBOM_WORKDIR/empty-user-npmrc"
EMPTY_GLOBAL_CONFIG="$SBOM_WORKDIR/empty-global-npmrc"
TREE_JSON="$SBOM_WORKDIR/production-tree.json"
SBOM_RAW="$SBOM_WORKDIR/sbom.raw.json"
SBOM_TMP="$SBOM_WORKDIR/sbom.normalized.json"

LC_ALL=C tar -tzf "$TARBALL" >"$ARCHIVE_LIST"
[[ -s "$ARCHIVE_LIST" ]] || {
  echo "error: release tarball is empty" >&2
  exit 1
}
while IFS= read -r entry; do
  case "$entry" in
    package/*) ;;
    *)
      echo "error: release tarball entry is outside the package/ root: $entry" >&2
      exit 1
      ;;
  esac
  if [[ "$entry" == */../* || "$entry" == ../* || "$entry" == */.. ||
        "$entry" == */./* || "$entry" == ./* || "$entry" == */. ||
        "$entry" == *//* ]]; then
    echo "error: release tarball contains an unsafe path: $entry" >&2
    exit 1
  fi
done <"$ARCHIVE_LIST"

DUPLICATE_ENTRY="$(LC_ALL=C sort "$ARCHIVE_LIST" | awk 'previous == $0 && !found++ { print } { previous = $0 }')"
if [[ -n "$DUPLICATE_ENTRY" ]]; then
  echo "error: release tarball contains a duplicate entry: $DUPLICATE_ENTRY" >&2
  exit 1
fi
if [[ "$(grep -Fxc 'package/package.json' "$ARCHIVE_LIST")" -ne 1 ||
      "$(grep -Fxc 'package/npm-shrinkwrap.json' "$ARCHIVE_LIST")" -ne 1 ]]; then
  echo "error: release tarball must contain one package.json and npm-shrinkwrap.json" >&2
  exit 1
fi
UNSAFE_TAR_TYPE="$(LC_ALL=C tar -tvzf "$TARBALL" | awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" && !found++ { print }')"
if [[ -n "$UNSAFE_TAR_TYPE" ]]; then
  echo "error: release tarball contains a link or unsupported entry type: $UNSAFE_TAR_TYPE" >&2
  exit 1
fi

mkdir "$UNPACK_ROOT"
tar -xzf "$TARBALL" \
  --directory "$UNPACK_ROOT" \
  --no-same-owner \
  --no-same-permissions
if [[ -L "$INSTALL_ROOT" || ! -d "$INSTALL_ROOT" ||
      "$(find "$UNPACK_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n')" != package ]]; then
  echo "error: release tarball did not extract to one regular package/ root" >&2
  exit 1
fi
if [[ -L "$INSTALL_ROOT/package.json" || ! -f "$INSTALL_ROOT/package.json" ||
      -L "$INSTALL_ROOT/npm-shrinkwrap.json" || ! -f "$INSTALL_ROOT/npm-shrinkwrap.json" ]]; then
  echo "error: release tarball package metadata is missing or unsafe" >&2
  exit 1
fi
if [[ -e "$INSTALL_ROOT/.npmrc" || -L "$INSTALL_ROOT/.npmrc" ]]; then
  echo "error: release tarball must not contain project npm configuration" >&2
  exit 1
fi

: >"$EMPTY_USER_CONFIG"
: >"$EMPTY_GLOBAL_CONFIG"
(
  cd "$INSTALL_ROOT"
  npm \
    --userconfig="$EMPTY_USER_CONFIG" \
    --globalconfig="$EMPTY_GLOBAL_CONFIG" \
    --registry=https://registry.npmjs.org \
    --cache="$SBOM_WORKDIR/npm-cache" \
    ci --omit=dev --ignore-scripts --no-audit --no-fund
)

# npm sbom treats declared-but-omitted dev dependencies as missing and can also
# omit a package (such as ajv) that is shared by the production closure. Change
# only the extracted temporary manifest so npm inventories the complete tree
# that npm ci actually installed.
node - "$INSTALL_ROOT/package.json" <<'NODE'
const fs = require("node:fs");
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
delete manifest.devDependencies;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

(
  cd "$INSTALL_ROOT"
  npm \
    --userconfig="$EMPTY_USER_CONFIG" \
    --globalconfig="$EMPTY_GLOBAL_CONFIG" \
    --registry=https://registry.npmjs.org \
    --cache="$SBOM_WORKDIR/npm-cache" \
    ls --omit=dev --all --json >"$TREE_JSON"
  npm \
    --userconfig="$EMPTY_USER_CONFIG" \
    --globalconfig="$EMPTY_GLOBAL_CONFIG" \
    --registry=https://registry.npmjs.org \
    --cache="$SBOM_WORKDIR/npm-cache" \
    sbom --sbom-format=cyclonedx >"$SBOM_RAW"
)

node "$ROOT/scripts/verify-production-sbom.mjs" "$TREE_JSON" "$SBOM_RAW" "$SBOM_TMP"

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
