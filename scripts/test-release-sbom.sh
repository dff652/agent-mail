#!/usr/bin/env bash
# Integration check for the production-only SBOM built from the npm tarball.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDER="${BUILDER:-$ROOT/scripts/build-release-artifacts.sh}"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT_ID="$(stat --format='%d:%i' -- "$TEST_ROOT")"

cleanup() {
  local status=$?
  local current_id

  trap - EXIT HUP INT TERM
  if [[ -L "$TEST_ROOT" || ! -d "$TEST_ROOT" ]]; then
    echo "error: refusing to clean replaced test directory: $TEST_ROOT" >&2
    exit 1
  fi
  current_id="$(stat --format='%d:%i' -- "$TEST_ROOT")"
  if [[ "$current_id" != "$TEST_ROOT_ID" ]]; then
    echo "error: refusing to clean changed test directory: $TEST_ROOT" >&2
    exit 1
  fi
  rm -rf --one-file-system -- "$TEST_ROOT"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

FAKE_BIN="$TEST_ROOT/fake-bin"
FAIL_ARTIFACTS="$TEST_ROOT/failed-artifacts"
REAL_NPM="$(command -v npm)"
mkdir "$FAKE_BIN"
# The single-quoted variables below must expand in the generated wrapper.
# shellcheck disable=SC2016
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'for argument in "$@"; do' \
  '  if [[ "$argument" == ci ]]; then exit 73; fi' \
  'done' \
  'exec "${REAL_NPM:?}" "$@"' >"$FAKE_BIN/npm"
chmod 700 "$FAKE_BIN/npm"
if PATH="$FAKE_BIN:$PATH" REAL_NPM="$REAL_NPM" \
    bash "$BUILDER" "$FAIL_ARTIFACTS" >"$TEST_ROOT/expected-failure.log" 2>&1; then
  echo "error: builder unexpectedly succeeded when isolated npm ci failed" >&2
  exit 1
fi
if find "$FAIL_ARTIFACTS" -maxdepth 1 -type f -name '*sbom*' -print -quit | grep -q .; then
  echo "error: failed builder left a partial or final SBOM artifact" >&2
  exit 1
fi

ARTIFACTS="$TEST_ROOT/artifacts"
bash "$BUILDER" "$ARTIFACTS"

VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/agent-mail/package.json")"
SBOM="$ARTIFACTS/agent-mail-$VERSION.sbom.cdx.json"
TARBALL="$ARTIFACTS/agent-mail-$VERSION.tgz"
[[ -f "$SBOM" && -f "$TARBALL" && -f "$ARTIFACTS/SHA256SUMS" ]] || {
  echo "error: expected release artifacts are missing" >&2
  exit 1
}
if find "$ARTIFACTS" -maxdepth 1 -type f -name '*.tmp' -print -quit | grep -q .; then
  echo "error: successful builder left a temporary artifact" >&2
  exit 1
fi

(
  cd "$ARTIFACTS"
  sha256sum --check SHA256SUMS
)

node - "$SBOM" "$VERSION" <<'NODE'
const fs = require("node:fs");
const sbom = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedRootVersion = process.argv[3];
const components = sbom.components || [];
const root = sbom.metadata?.component;
if (
  root?.name !== "agent-mail" ||
  root.version !== expectedRootVersion ||
  root["bom-ref"] !== `agent-mail@${expectedRootVersion}` ||
  root.purl !== `pkg:npm/agent-mail@${expectedRootVersion}`
) {
  throw new Error("release SBOM root identity is inconsistent");
}
const expected = new Map([
  ["@modelcontextprotocol/sdk", "1.30.0"],
  ["ajv", "8.20.0"],
  ["fast-uri", "3.1.5"],
  ["hono", "4.12.34"],
  ["ip-address", "10.3.1"],
]);

for (const [name, version] of expected) {
  const matches = components.filter((component) => component.name === name);
  if (matches.length !== 1 || matches[0].version !== version) {
    throw new Error(`expected one ${name}@${version} SBOM component`);
  }
}
for (const name of ["eslint", "typescript", "vitest"]) {
  if (components.some((component) => component.name === name)) {
    throw new Error(`development-only component present in release SBOM: ${name}`);
  }
}

const componentRefs = components.map((component) => component["bom-ref"]);
if (new Set(componentRefs).size !== componentRefs.length) {
  throw new Error("release SBOM contains duplicate component bom-ref values");
}
const graphRefs = (sbom.dependencies || []).map((dependency) => dependency.ref);
if (new Set(graphRefs).size !== graphRefs.length) {
  throw new Error("release SBOM contains duplicate dependency graph refs");
}
NODE

TREE_FIXTURE="$TEST_ROOT/verifier-tree.json"
MISSING_ROOT_SBOM="$TEST_ROOT/verifier-missing-root.json"
DISCONNECTED_SBOM="$TEST_ROOT/verifier-disconnected.json"
node - "$SBOM" "$TREE_FIXTURE" "$MISSING_ROOT_SBOM" "$DISCONNECTED_SBOM" <<'NODE'
const fs = require("node:fs");
const sbom = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = sbom.metadata.component;
const tree = { name: root.name, version: root.version, dependencies: {} };

// A nested chain preserves every real component name/version in npm-ls shape,
// including cases where different versions share a package name.
let cursor = tree;
for (const component of sbom.components) {
  const dependency = { version: component.version, dependencies: {} };
  cursor.dependencies[component.name] = dependency;
  cursor = dependency;
}
fs.writeFileSync(process.argv[3], `${JSON.stringify(tree, null, 2)}\n`);

const missingRoot = structuredClone(sbom);
missingRoot.dependencies = missingRoot.dependencies.filter(
  (dependency) => dependency.ref !== root["bom-ref"],
);
fs.writeFileSync(process.argv[4], `${JSON.stringify(missingRoot, null, 2)}\n`);

const disconnected = structuredClone(sbom);
const rootDependency = disconnected.dependencies.find(
  (dependency) => dependency.ref === root["bom-ref"],
);
if (!rootDependency) throw new Error("fixture SBOM is missing its root dependency entry");
rootDependency.dependsOn = [];
fs.writeFileSync(process.argv[5], `${JSON.stringify(disconnected, null, 2)}\n`);
NODE

VERIFIER="$ROOT/scripts/verify-production-sbom.mjs"
node "$VERIFIER" "$TREE_FIXTURE" "$SBOM" "$TEST_ROOT/verifier-valid-output.json"

expect_verifier_rejected() {
  local input=$1
  local output=$2
  local expected_error=$3
  local log=$4

  if node "$VERIFIER" "$TREE_FIXTURE" "$input" "$output" >"$log" 2>&1; then
    echo "error: SBOM verifier accepted invalid dependency graph" >&2
    exit 1
  fi
  if [[ -e "$output" ]]; then
    echo "error: failed SBOM verification created output: $output" >&2
    exit 1
  fi
  if ! grep -Fq "$expected_error" "$log"; then
    echo "error: SBOM verifier failed for an unexpected reason" >&2
    sed -n '1,20p' "$log" >&2
    exit 1
  fi
}

expect_verifier_rejected \
  "$MISSING_ROOT_SBOM" \
  "$TEST_ROOT/verifier-missing-root-output.json" \
  "dependency graph is missing root entry" \
  "$TEST_ROOT/verifier-missing-root.log"
expect_verifier_rejected \
  "$DISCONNECTED_SBOM" \
  "$TEST_ROOT/verifier-disconnected-output.json" \
  "components unreachable from root" \
  "$TEST_ROOT/verifier-disconnected.log"

echo "release SBOM: OK"
