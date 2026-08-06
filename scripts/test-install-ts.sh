#!/usr/bin/env bash
# Network-free regression tests for the versioned TypeScript release installer.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${INSTALLER:-$ROOT/scripts/install-ts.sh}"
TEST_ROOT="$(mktemp -d)"
REAL_PATH="$PATH"
EXPECTED_DEFAULT_VERSION="$(
  node -p 'require(process.argv[1]).version' "$ROOT/packages/agent-mail/package.json"
)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "error: $*" >&2
  exit 1
}

assert_link() {
  local path=$1
  local expected=$2
  [[ -L "$path" ]] || fail "$path is not a symlink"
  [[ "$(readlink "$path")" == "$expected" ]] ||
    fail "$path points to $(readlink "$path"), expected $expected"
}

make_fake_tools() {
  local bin_dir=$1
  mkdir -p "$bin_dir"

  cat >"$bin_dir/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "$AGENT_MAIL_TEST_UNAME_S" ;;
  -m) printf '%s\n' "$AGENT_MAIL_TEST_UNAME_M" ;;
  *) exit 2 ;;
esac
EOF

  cat >"$bin_dir/curl" <<'EOF'
#!/bin/sh
set -eu
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out=$2
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url=$1
      shift
      ;;
  esac
done
[ -n "$out" ] && [ -n "$url" ]
printf '%s\n' "$url" >>"$AGENT_MAIL_TEST_CURL_LOG"
case "$url" in
  */SHA256SUMS) cp "$AGENT_MAIL_TEST_CHECKSUMS" "$out" ;;
  */agent-mail-*.tgz) cp "$AGENT_MAIL_TEST_TARBALL" "$out" ;;
  *) exit 22 ;;
esac
EOF

  cat >"$bin_dir/npm" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$AGENT_MAIL_TEST_NPM_LOG"
[ "${AGENT_MAIL_TEST_NPM_FAIL:-0}" != 1 ] || exit 1
prefix=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$prefix" ]
mkdir -p "$prefix/node_modules/.bin"
reported=${AGENT_MAIL_TEST_REPORTED_VERSION:-$AGENT_MAIL_VERSION}
for name in agent-mail agent-mail-mcp; do
  cat >"$prefix/node_modules/.bin/$name" <<SCRIPT
#!/bin/sh
if [ "\${1:-}" = version ]; then
  echo "agent-mail $reported (typescript test)"
  exit 0
fi
exit 2
SCRIPT
  chmod +x "$prefix/node_modules/.bin/$name"
done
EOF

  chmod +x "$bin_dir/uname" "$bin_dir/curl" "$bin_dir/npm"
}

write_checksums() {
  local tarball=$1
  local asset=$2
  local output=$3
  local digest
  digest=$(sha256sum "$tarball" | awk '{print $1}')
  printf '%s  %s\n' "$digest" "$asset" >"$output"
}

run_installer() {
  local version=$1
  local install_root=$2
  local bin_dir=$3
  local tool_path="$FAKE_BIN:$REAL_PATH"
  if [[ -n "${AGENT_MAIL_TEST_PATH_PREFIX:-}" ]]; then
    tool_path="$AGENT_MAIL_TEST_PATH_PREFIX:$tool_path"
  fi
  AGENT_MAIL_VERSION="$version" \
    AGENT_MAIL_INSTALL_ROOT="$install_root" \
    AGENT_MAIL_BIN_DIR="$bin_dir" \
    AGENT_MAIL_RELEASE_BASE_URL="https://fixture.invalid/v$version" \
    AGENT_MAIL_TEST_UNAME_S="${AGENT_MAIL_TEST_UNAME_S:-Linux}" \
    AGENT_MAIL_TEST_UNAME_M="${AGENT_MAIL_TEST_UNAME_M:-x86_64}" \
    PATH="$tool_path" \
    sh "$INSTALLER"
}

FIXTURE=$TEST_ROOT/fixture
FAKE_BIN=$TEST_ROOT/fake-bin
mkdir -p "$FIXTURE"
make_fake_tools "$FAKE_BIN"
printf 'fake npm tarball\n' >"$FIXTURE/agent-mail.tgz"
export AGENT_MAIL_TEST_TARBALL=$FIXTURE/agent-mail.tgz
export AGENT_MAIL_TEST_CHECKSUMS=$FIXTURE/SHA256SUMS
export AGENT_MAIL_TEST_CURL_LOG=$TEST_ROOT/curl.log
export AGENT_MAIL_TEST_NPM_LOG=$TEST_ROOT/npm.log
: >"$AGENT_MAIL_TEST_CURL_LOG"
: >"$AGENT_MAIL_TEST_NPM_LOG"

install_root=$TEST_ROOT/success/root
bin_dir=$TEST_ROOT/success/bin
asset=agent-mail-$EXPECTED_DEFAULT_VERSION.tgz
write_checksums "$AGENT_MAIL_TEST_TARBALL" "$asset" "$AGENT_MAIL_TEST_CHECKSUMS"

# Successful verified installation uses a versioned prefix and stable links.
run_installer "$EXPECTED_DEFAULT_VERSION" "$install_root" "$bin_dir" >/dev/null
assert_link "$install_root/current" "versions/$EXPECTED_DEFAULT_VERSION"
for name in agent-mail agent-mail-mcp; do
  assert_link "$bin_dir/$name" "$install_root/current/node_modules/.bin/$name"
  [[ -x "$bin_dir/$name" ]] || fail "$name link is not executable"
done

# Same version is a zero-download, zero-npm no-op.
: >"$AGENT_MAIL_TEST_CURL_LOG"
: >"$AGENT_MAIL_TEST_NPM_LOG"
run_installer "$EXPECTED_DEFAULT_VERSION" "$install_root" "$bin_dir" >/dev/null
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "idempotent install performed a download"
[[ ! -s "$AGENT_MAIL_TEST_NPM_LOG" ]] ||
  fail "idempotent install invoked npm"

# A checksum mismatch for a distinct candidate preserves the active version.
# Keep the negative fixture independent of the current package version so a
# real version bump cannot silently turn this case into the idempotent no-op.
current_major=${EXPECTED_DEFAULT_VERSION%%.*}
[[ "$current_major" =~ ^[0-9]+$ ]] ||
  fail "package version has a non-numeric major: $EXPECTED_DEFAULT_VERSION"
next_version="$((current_major + 1)).0.0-install-fixture"
[[ "$next_version" != "$EXPECTED_DEFAULT_VERSION" ]] ||
  fail "negative fixture version must differ from the installer default"
printf '%064d  agent-mail-%s.tgz\n' 0 "$next_version" >"$AGENT_MAIL_TEST_CHECKSUMS"
if run_installer "$next_version" "$install_root" "$bin_dir" >/dev/null 2>&1; then
  fail "checksum mismatch was accepted"
fi
assert_link "$install_root/current" "versions/$EXPECTED_DEFAULT_VERSION"
[[ ! -e "$install_root/versions/$next_version" ]] ||
  fail "checksum failure left a version directory"

# Duplicate checksum entries are ambiguous and rejected.
write_checksums "$AGENT_MAIL_TEST_TARBALL" \
  "agent-mail-$next_version.tgz" "$AGENT_MAIL_TEST_CHECKSUMS"
checksum_line=$(cat "$AGENT_MAIL_TEST_CHECKSUMS")
printf '%s\n%s\n' "$checksum_line" "$checksum_line" >"$AGENT_MAIL_TEST_CHECKSUMS"
if run_installer "$next_version" "$install_root" "$bin_dir" >/dev/null 2>&1; then
  fail "duplicate checksum entries were accepted"
fi
assert_link "$install_root/current" "versions/$EXPECTED_DEFAULT_VERSION"

# npm failure and wrong package version both preserve the active version.
write_checksums "$AGENT_MAIL_TEST_TARBALL" \
  "agent-mail-$next_version.tgz" "$AGENT_MAIL_TEST_CHECKSUMS"
export AGENT_MAIL_TEST_NPM_FAIL=1
if run_installer "$next_version" "$install_root" "$bin_dir" >/dev/null 2>&1; then
  fail "npm failure was reported as success"
fi
unset AGENT_MAIL_TEST_NPM_FAIL
assert_link "$install_root/current" "versions/$EXPECTED_DEFAULT_VERSION"

export AGENT_MAIL_TEST_REPORTED_VERSION=9.9.9
if run_installer "$next_version" "$install_root" "$bin_dir" >/dev/null 2>&1; then
  fail "wrong package version was accepted"
fi
unset AGENT_MAIL_TEST_REPORTED_VERSION
assert_link "$install_root/current" "versions/$EXPECTED_DEFAULT_VERSION"

# Existing unmanaged commands fail before downloading.
collision_root=$TEST_ROOT/collision/root
collision_bin=$TEST_ROOT/collision/bin
mkdir -p "$collision_bin"
printf 'unmanaged\n' >"$collision_bin/agent-mail"
: >"$AGENT_MAIL_TEST_CURL_LOG"
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$collision_root" "$collision_bin" >/dev/null 2>&1; then
  fail "unmanaged command collision was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "command collision performed a download"

# An unmanaged current symlink and a traversal-like version are rejected before
# downloads or writes.
unmanaged_root=$TEST_ROOT/unmanaged-current/root
unmanaged_bin=$TEST_ROOT/unmanaged-current/bin
mkdir -p "$unmanaged_root" "$unmanaged_bin"
ln -s /tmp/not-agent-mail "$unmanaged_root/current"
: >"$AGENT_MAIL_TEST_CURL_LOG"
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$unmanaged_root" "$unmanaged_bin" >/dev/null 2>&1; then
  fail "unmanaged current symlink was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "unmanaged current symlink performed a download"

# A symlink in the version slot must never be treated as an installed package.
symlink_root=$TEST_ROOT/symlink-version/root
symlink_bin=$TEST_ROOT/symlink-version/bin
mkdir -p "$symlink_root/versions" "$symlink_bin"
ln -s "$install_root/versions/$EXPECTED_DEFAULT_VERSION" \
  "$symlink_root/versions/$EXPECTED_DEFAULT_VERSION"
: >"$AGENT_MAIL_TEST_CURL_LOG"
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$symlink_root" "$symlink_bin" >/dev/null 2>&1; then
  fail "symlinked version directory was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "symlinked version directory performed a download"

# Canonicalized roots must reject root resolution and any install/bin overlap
# before mkdir or download.
: >"$AGENT_MAIL_TEST_CURL_LOG"
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$TEST_ROOT/../.." "$TEST_ROOT/traversal-bin" \
  >/dev/null 2>&1; then
  fail "install root resolving to a broad ancestor was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "broad canonical install root performed a download"

overlap_root=$TEST_ROOT/overlap/root
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$overlap_root" "$overlap_root/current/bin" >/dev/null 2>&1; then
  fail "bin directory nested under install root was accepted"
fi
[[ ! -e "$overlap_root/current" ]] ||
  fail "overlapping bin directory poisoned the current path"

: >"$AGENT_MAIL_TEST_CURL_LOG"
if run_installer ".." "$TEST_ROOT/traversal/root" "$TEST_ROOT/traversal/bin" \
  >/dev/null 2>&1; then
  fail "invalid traversal-like version was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "invalid version performed a download"

# Unsupported platform checks happen before downloading.
: >"$AGENT_MAIL_TEST_CURL_LOG"
export AGENT_MAIL_TEST_UNAME_S=Darwin
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$TEST_ROOT/unsupported-os/root" "$TEST_ROOT/unsupported-os/bin" \
  >/dev/null 2>&1; then
  fail "unsupported operating system was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "unsupported operating system downloaded files"
unset AGENT_MAIL_TEST_UNAME_S

export AGENT_MAIL_TEST_UNAME_M=aarch64
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$TEST_ROOT/unsupported-arch/root" "$TEST_ROOT/unsupported-arch/bin" \
  >/dev/null 2>&1; then
  fail "unsupported architecture was accepted"
fi
[[ ! -s "$AGENT_MAIL_TEST_CURL_LOG" ]] ||
  fail "unsupported architecture downloaded files"
unset AGENT_MAIL_TEST_UNAME_M

# A failure during the final current switch must remove newly-created stable
# links and the new version directory.
activation_root=$TEST_ROOT/activation-failure/root
activation_bin=$TEST_ROOT/activation-failure/bin
fail_mv_bin=$TEST_ROOT/fail-current-mv
mkdir -p "$fail_mv_bin"
real_mv=$(command -v mv)
cat >"$fail_mv_bin/mv" <<EOF
#!/bin/sh
for arg in "\$@"; do
  destination=\$arg
done
case "\$destination" in
  */current) exit 1 ;;
esac
exec "$real_mv" "\$@"
EOF
chmod +x "$fail_mv_bin/mv"
export AGENT_MAIL_TEST_PATH_PREFIX=$fail_mv_bin

# Failed upgrade activation preserves the previously active version and its
# managed command links.
write_checksums "$AGENT_MAIL_TEST_TARBALL" \
  "agent-mail-$next_version.tgz" "$AGENT_MAIL_TEST_CHECKSUMS"
if run_installer "$next_version" "$install_root" "$bin_dir" >/dev/null 2>&1; then
  fail "failed upgrade activation was reported as success"
fi
assert_link "$install_root/current" "versions/$EXPECTED_DEFAULT_VERSION"
[[ ! -e "$install_root/versions/$next_version" ]] ||
  fail "failed upgrade activation left the new target version behind"
for name in agent-mail agent-mail-mcp; do
  assert_link "$bin_dir/$name" "$install_root/current/node_modules/.bin/$name"
done

# Failed first activation removes every path created by that attempt.
write_checksums "$AGENT_MAIL_TEST_TARBALL" \
  "$asset" "$AGENT_MAIL_TEST_CHECKSUMS"
if run_installer "$EXPECTED_DEFAULT_VERSION" \
  "$activation_root" "$activation_bin" >/dev/null 2>&1; then
  fail "failed current activation was reported as success"
fi
unset AGENT_MAIL_TEST_PATH_PREFIX
[[ ! -e "$activation_root/current" && ! -L "$activation_root/current" ]] ||
  fail "failed activation left current behind"
[[ ! -e "$activation_root/versions/$EXPECTED_DEFAULT_VERSION" ]] ||
  fail "failed activation left the target version behind"
for name in agent-mail agent-mail-mcp; do
  [[ ! -e "$activation_bin/$name" && ! -L "$activation_bin/$name" ]] ||
    fail "failed activation left $name behind"
done

installer_default=$(
  awk -F= '$1 == "DEFAULT_AGENT_MAIL_VERSION" { print $2 }' "$INSTALLER"
)
[[ "$installer_default" == "$EXPECTED_DEFAULT_VERSION" ]] ||
  fail "installer default is $installer_default, want $EXPECTED_DEFAULT_VERSION"

echo "install-ts.sh: OK"
