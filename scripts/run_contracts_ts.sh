#!/usr/bin/env bash
# TypeScript-only language-neutral contracts gate.
#
#   bash scripts/run_contracts_ts.sh
#
# Env:
#   SKIP_NPM_CI=1 — reuse an existing node_modules tree (CI installs explicitly)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/agent-mail"

ok()   { printf '  [OK]   %s\n' "$*"; }
info() { printf '  --     %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*" >&2; }

if [[ "${SOP_ACTION_ID:-contracts.ts}" != "contracts.ts" ]]; then
  bad "SOP_ACTION_ID must be contracts.ts"
  exit 1
fi

if [[ ! -f "$PKG/package.json" ]]; then
  bad "packages/agent-mail/package.json missing"
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  bad "Node.js and npm are required for the TypeScript-only contracts gate"
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$node_major" -lt 20 ]]; then
  bad "Node.js >=20 required (found $(node --version))"
  exit 1
fi

if [[ "${SKIP_NPM_CI:-}" != "1" ]]; then
  info "install exact TypeScript dependencies"
  (cd "$PKG" && npm ci)
else
  if [[ ! -x "$PKG/node_modules/.bin/vitest" || ! -x "$PKG/node_modules/.bin/tsx" ]]; then
    bad "SKIP_NPM_CI=1 requires an existing complete node_modules tree"
    exit 1
  fi
  info "reuse existing node_modules (SKIP_NPM_CI=1)"
fi

info "language-neutral structure + TypeScript contract runners"
(cd "$PKG" && npm run test:contracts:ts-only)
ok "TypeScript-only contracts gate"
