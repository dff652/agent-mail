#!/usr/bin/env bash
# Pre-release gate for the TypeScript package.
#
#   bash scripts/release_check_ts.sh
#
# Env:
#   NODE_BIN  — node binary to use (default: node on PATH; must be >= 20)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/agent-mail"
cd "$PKG"

ok()   { printf '  [OK]   %s\n' "$*"; }
info() { printf '  --     %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*" >&2; }

if ! command -v node >/dev/null 2>&1; then
  bad "node not found (need >= 20)"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  bad "node $(node -v) is too old; package requires >= 20"
  exit 1
fi
info "node $(node -v)"

info "version declarations"
node - "$PKG/package.json" "$PKG/src/version.ts" <<'NODE'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = fs.readFileSync(process.argv[3], "utf8");
const match = source.match(/AGENT_MAIL_VERSION\s*=\s*"([^"]+)"/);
if (!match || match[1] !== pkg.version) {
  console.error(`version mismatch: package=${pkg.version} runtime=${match?.[1] ?? "missing"}`);
  process.exit(1);
}
NODE
ok "package and runtime versions match"

info "license files match the repository root"
for f in LICENSE NOTICE; do
  if [[ ! -f "$PKG/$f" ]]; then
    bad "packages/agent-mail/$f missing (npm packs relative to the package dir, so the root copy is NOT included)"
    exit 1
  fi
  if ! cmp -s "$ROOT/$f" "$PKG/$f"; then
    bad "packages/agent-mail/$f differs from the repository root copy"
    exit 1
  fi
done
ok "LICENSE + NOTICE present and identical to root"

info "published dependency lock"
if [[ ! -f "$PKG/npm-shrinkwrap.json" ]]; then
  bad "packages/agent-mail/npm-shrinkwrap.json missing"
  exit 1
fi
node - "$PKG/npm-shrinkwrap.json" <<'NODE'
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rejected = [];
for (const [name, metadata] of Object.entries(lock.packages || {})) {
  if (!metadata.resolved) continue;
  let host;
  try {
    host = new URL(metadata.resolved).host;
  } catch {
    rejected.push(`${name || "<root>"}: invalid resolved URL`);
    continue;
  }
  if (host !== "registry.npmjs.org") {
    rejected.push(`${name || "<root>"}: ${host}`);
  }
}
if (rejected.length) {
  console.error(`unapproved npm-shrinkwrap resolved hosts:\n${rejected.join("\n")}`);
  process.exit(1);
}
NODE
ok "npm-shrinkwrap.json present"
ok "npm-shrinkwrap.json resolves only through registry.npmjs.org"

info "npm ci"
npm ci --silent

info "release installer regression"
shellcheck "$ROOT/scripts/install-ts.sh" "$ROOT/scripts/test-install-ts.sh" \
  "$ROOT/scripts/build-release-artifacts.sh" \
  "$ROOT/scripts/test-release-artifact-paths.sh" \
  "$ROOT/scripts/test-release-sbom.sh"
bash "$ROOT/scripts/test-install-ts.sh"
bash "$ROOT/scripts/test-release-artifact-paths.sh"
bash "$ROOT/scripts/test-release-sbom.sh"

info "lint"
npm run --silent lint

info "typecheck (src + test)"
npm run --silent typecheck

info "build"
npm run --silent build

info "test"
npm test --silent

info "pack"
TARBALL="$(npm pack --silent)"
trap 'rm -f "$PKG/$TARBALL"' EXIT
CONTENTS="$(tar -tzf "$TARBALL")"

fail=0
require_in_tarball() {
  if grep -qx "package/$1" <<<"$CONTENTS"; then
    ok "tarball contains $1"
  else
    bad "tarball is missing $1"
    fail=1
  fi
}

# Apache-2.0 section 4(d): redistributions must carry the NOTICE file.
require_in_tarball LICENSE
require_in_tarball NOTICE
require_in_tarball package.json
require_in_tarball README.md
require_in_tarball settings.json
require_in_tarball npm-shrinkwrap.json

# Every declared bin entry must actually exist in the tarball, or `npm i -g`
# installs a package whose command is a dangling symlink.
while IFS= read -r rel; do
  require_in_tarball "$rel"
done < <(node -p '
  const p = require("./package.json");
  Object.values(p.bin || {}).map(v => v.replace(/^\.\//, "")).join("\n")
')

# The published entry points must resolve too.
while IFS= read -r rel; do
  [[ -n "$rel" ]] && require_in_tarball "$rel"
done < <(node -p '
  const p = require("./package.json");
  const out = new Set();
  if (p.main) out.add(p.main.replace(/^\.\//, ""));
  if (p.types) out.add(p.types.replace(/^\.\//, ""));
  const e = p.exports && p.exports["."];
  if (e) for (const v of Object.values(e)) if (typeof v === "string") out.add(v.replace(/^\.\//, ""));
  [...out].join("\n")
')

printf '  --     tarball: %s (%s files)\n' "$TARBALL" "$(wc -l <<<"$CONTENTS")"

if [[ "$fail" -ne 0 ]]; then
  bad "release_check_ts failed"
  exit 1
fi

info "isolated tarball install smoke"
bash "$ROOT/scripts/smoke_install_ts.sh" "$PKG/$TARBALL"

printf '\n  [OK]   release_check_ts complete\n'
