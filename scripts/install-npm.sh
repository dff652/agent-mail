#!/usr/bin/env bash
# Install Agent Mail TypeScript CLI from this repo (local) or npm (when published).
#
#   bash scripts/install-npm.sh              # from monorepo checkout
#   bash scripts/install-npm.sh --global     # npm link / npm install -g ./packages/agent-mail
#   npm install -g agent-mail@alpha          # after publish (future)
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/agent-mail"
GLOBAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global|-g) GLOBAL=1; shift ;;
    -h|--help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js >= 20 required" >&2
    exit 1
  fi
  ver="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$ver" -lt 20 ]]; then
    echo "Node.js >= 20 required (found $(node -v))" >&2
    exit 1
  fi
}

need_node
if [[ ! -f "$PKG/package.json" ]]; then
  echo "missing $PKG — run from agent-mail monorepo" >&2
  exit 1
fi

echo "Installing agent-mail from $PKG"
(
  cd "$PKG"
  npm install
  npm run build
  if [[ "$GLOBAL" -eq 1 ]]; then
    npm install -g .
    echo "Installed globally: $(command -v agent-mail || true)"
    agent-mail version || true
  else
    echo "Built. Run locally:"
    echo "  node $PKG/dist/cli.js version"
    echo "  npm --prefix $PKG run cli -- version"
    echo "Global install: bash scripts/install-npm.sh --global"
  fi
)
