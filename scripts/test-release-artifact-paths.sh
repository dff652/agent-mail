#!/usr/bin/env bash
# Fast, network-free path-safety checks for build-release-artifacts.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILDER="${BUILDER:-$ROOT/scripts/build-release-artifacts.sh}"
TEST_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "error: $*" >&2
  exit 1
}

expect_rejected() {
  local output=$1
  if bash "$BUILDER" "$output" >/dev/null 2>&1; then
    fail "unsafe release output was accepted: $output"
  fi
}

# Lexical traversal must not be normalized into a broader empty parent and
# populated with release files.
traversal_parent=$TEST_ROOT/traversal-parent
mkdir -p "$traversal_parent/new"
expect_rejected "$traversal_parent/new/.."
if find "$traversal_parent" -maxdepth 1 -type f -print -quit | grep -q .; then
  fail "traversal rejection wrote release files into the parent"
fi

# Canonical aliases of protected repository paths are rejected.
expect_rejected "$ROOT/."
expect_rejected "$ROOT/packages/agent-mail/."

# An output symlink must not redirect the build into another directory.
symlink_target=$TEST_ROOT/symlink-target
symlink_output=$TEST_ROOT/symlink-output
mkdir -p "$symlink_target"
ln -s "$symlink_target" "$symlink_output"
expect_rejected "$symlink_output"
if find "$symlink_target" -mindepth 1 -print -quit | grep -q .; then
  fail "symlink rejection wrote release files into the target"
fi

echo "build-release-artifacts paths: OK"
