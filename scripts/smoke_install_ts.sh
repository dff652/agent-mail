#!/usr/bin/env bash
# Install the packed TypeScript package into an isolated prefix and exercise
# the installed CLI. This never publishes, tags, or writes outside its mktemp
# directory.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/agent-mail"
TMP_BASE="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
SMOKE_ROOT="$(mktemp -d "$TMP_BASE/agent-mail-ts-install.XXXXXX")"

ok()   { printf '  [OK]   %s\n' "$*"; }
info() { printf '  --     %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*" >&2; }

cleanup() {
  if [[ -n "${SMOKE_ROOT:-}" && -d "$SMOKE_ROOT" ]]; then
    case "$SMOKE_ROOT" in
      "$TMP_BASE"/agent-mail-ts-install.*)
        rm -rf -- "$SMOKE_ROOT"
        ;;
      *)
        bad "refusing to clean unexpected smoke path: $SMOKE_ROOT"
        ;;
    esac
  fi
}
trap cleanup EXIT

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  bad "node and npm are required"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  bad "node $(node -v) is too old; package requires >= 20"
  exit 1
fi

TARBALL_INPUT="${1:-}"
if [[ -n "$TARBALL_INPUT" ]]; then
  if [[ ! -f "$TARBALL_INPUT" ]]; then
    bad "tarball not found: $TARBALL_INPUT"
    exit 1
  fi
  TARBALL="$(cd "$(dirname "$TARBALL_INPUT")" && pwd -P)/$(basename "$TARBALL_INPUT")"
else
  info "build package for standalone install smoke"
  npm --prefix "$PKG" ci --silent
  npm --prefix "$PKG" run --silent build
  PACKED_NAME="$(cd "$PKG" && npm pack --silent --pack-destination "$SMOKE_ROOT")"
  TARBALL="$SMOKE_ROOT/$PACKED_NAME"
fi

PACKAGE_JSON="$PKG/package.json"
EXPECTED_VERSION="$(node -p 'require(process.argv[1]).version' "$PACKAGE_JSON")"
INSTALL_ROOT="$SMOKE_ROOT/install"
PROJECT_ROOT="$SMOKE_ROOT/project"

info "install packed npm artifact into isolated prefix"
npm install \
  --prefix "$INSTALL_ROOT" \
  --no-audit \
  --no-fund \
  --loglevel=error \
  "$TARBALL"

BIN_DIR="$INSTALL_ROOT/node_modules/.bin"
while IFS= read -r executable; do
  [[ -n "$executable" ]] || continue
  if [[ ! -x "$BIN_DIR/$executable" ]]; then
    bad "installed package is missing executable: $executable"
    exit 1
  fi
done < <(
  node -p 'Object.keys(require(process.argv[1]).bin || {}).join("\n")' "$PACKAGE_JSON"
)

AGENT_MAIL_BIN="$BIN_DIR/agent-mail"
VERSION_OUTPUT="$("$AGENT_MAIL_BIN" version)"
if [[ "$VERSION_OUTPUT" != *"agent-mail $EXPECTED_VERSION (typescript"* ]]; then
  bad "installed CLI reported unexpected version: $VERSION_OUTPUT"
  exit 1
fi

info "exercise installed CLI lifecycle and dry-run wake"
"$AGENT_MAIL_BIN" init --path "$PROJECT_ROOT" >/dev/null
SEND_OUTPUT="$(
  "$AGENT_MAIL_BIN" send \
    --path "$PROJECT_ROOT" \
    --as claude-code@local \
    --to codex@local \
    --type task \
    --body "tarball install smoke" \
    --effect read
)"
printf '%s' "$SEND_OUTPUT" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    if (!String(result.id || "").startsWith("msg_") || !result.task_id) process.exit(1);
  });
'

INBOX_OUTPUT="$("$AGENT_MAIL_BIN" inbox --path "$PROJECT_ROOT" --as codex@local)"
printf '%s' "$INBOX_OUTPUT" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    if (result.count !== 1 || result.items?.[0]?.type !== "task") process.exit(1);
  });
'

BRIDGE_OUTPUT="$(
  "$AGENT_MAIL_BIN" bridge \
    --path "$PROJECT_ROOT" \
    --recipient codex@local \
    --runner codex \
    --dry-run
)"
printf '%s' "$BRIDGE_OUTPUT" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    if (result.count !== 1 || result.results?.[0]?.action !== "run") process.exit(1);
  });
'

ok "TypeScript tarball install smoke ($EXPECTED_VERSION)"
