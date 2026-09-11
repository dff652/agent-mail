#!/bin/sh
# Install a pinned Agent Mail TypeScript release after verifying its SHA256.
#
# This installer intentionally does not install Node.js, initialize a project,
# edit MCP configuration, modify shell profiles, or start services.

set -eu

DEFAULT_AGENT_MAIL_VERSION=1.0.0-alpha.7

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

expand_home_path() {
  case "$1" in
    \~)
      : "${HOME:?HOME is required to expand a user path}"
      printf '%s\n' "$HOME"
      ;;
    \~/*)
      : "${HOME:?HOME is required to expand a user path}"
      printf '%s/%s\n' "$HOME" "${1#\~/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

installed_version() {
  "$1" version 2>/dev/null |
    awk 'NR == 1 && $1 == "agent-mail" { print $2 }'
}

sha256_value() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

is_semver() {
  node -e '
    const version = process.argv[1];
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
    if (!semver.test(version)) process.exit(1);
  ' "$1"
}

if [ "$#" -ne 0 ]; then
  die "install-ts.sh accepts configuration through AGENT_MAIL_VERSION, AGENT_MAIL_INSTALL_ROOT, and AGENT_MAIL_BIN_DIR"
fi

version=${AGENT_MAIL_VERSION:-$DEFAULT_AGENT_MAIL_VERSION}
version=${version#v}
case "$version" in
  '' | *[!0-9A-Za-z.+-]*) die "invalid AGENT_MAIL_VERSION: $version" ;;
esac

if [ "${AGENT_MAIL_INSTALL_ROOT+x}" = x ]; then
  install_root=$(expand_home_path "$AGENT_MAIL_INSTALL_ROOT")
else
  : "${HOME:?HOME is required when AGENT_MAIL_INSTALL_ROOT is unset}"
  data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
  install_root=$data_home/agent-mail
fi
if [ "${AGENT_MAIL_BIN_DIR+x}" = x ]; then
  bin_dir=$(expand_home_path "$AGENT_MAIL_BIN_DIR")
else
  : "${HOME:?HOME is required when AGENT_MAIL_BIN_DIR is unset}"
  bin_dir=$HOME/.local/bin
fi
[ -n "$install_root" ] || die "AGENT_MAIL_INSTALL_ROOT must not be empty"
[ -n "$bin_dir" ] || die "AGENT_MAIL_BIN_DIR must not be empty"
case "$install_root" in
  /*) ;;
  *) die "AGENT_MAIL_INSTALL_ROOT must be an absolute path" ;;
esac
case "$bin_dir" in
  /*) ;;
  *) die "AGENT_MAIL_BIN_DIR must be an absolute path" ;;
esac
[ "$install_root" != / ] || die "AGENT_MAIL_INSTALL_ROOT must not be /"
[ "$bin_dir" != / ] || die "AGENT_MAIL_BIN_DIR must not be /"
[ ! -L "$install_root" ] ||
  die "AGENT_MAIL_INSTALL_ROOT must not be a symlink"
[ ! -L "$bin_dir" ] ||
  die "AGENT_MAIL_BIN_DIR must not be a symlink"

need uname
case "$(uname -s)" in
  Linux) ;;
  *) die "only Linux amd64 is currently supported" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) die "only Linux amd64 is currently supported" ;;
esac

need node
need npm
need awk
need curl
need mktemp
need readlink
need realpath

node_major=$(node -p 'process.versions.node.split(".")[0]')
case "$node_major" in
  '' | *[!0-9]*) die "could not determine the Node.js version" ;;
esac
[ "$node_major" -ge 20 ] ||
  die "Node.js >= 20 is required (found $(node --version 2>/dev/null || echo unknown))"
is_semver "$version" ||
  die "AGENT_MAIL_VERSION must be valid SemVer: $version"

install_root=$(realpath -m -- "$install_root")
bin_dir=$(realpath -m -- "$bin_dir")
[ "$install_root" != / ] ||
  die "AGENT_MAIL_INSTALL_ROOT resolves to /"
[ "$bin_dir" != / ] ||
  die "AGENT_MAIL_BIN_DIR resolves to /"
case "$bin_dir/" in
  "$install_root/"*)
    die "AGENT_MAIL_BIN_DIR must not be inside AGENT_MAIL_INSTALL_ROOT"
    ;;
esac
case "$install_root/" in
  "$bin_dir/"*)
    die "AGENT_MAIL_INSTALL_ROOT must not be inside AGENT_MAIL_BIN_DIR"
    ;;
esac

versions_dir=$install_root/versions
current_link=$install_root/current
target_version=$versions_dir/$version
managed_bin_root=$install_root/current/node_modules/.bin
bin_names="agent-mail agent-mail-mcp"

for directory in "$install_root" "$versions_dir" "$bin_dir"; do
  [ ! -L "$directory" ] ||
    die "$directory is a symlink; refusing an ambiguous installation root"
done

if [ -e "$current_link" ] || [ -L "$current_link" ]; then
  [ -L "$current_link" ] ||
    die "$current_link exists and is not a managed symlink"
  current_target=$(readlink "$current_link")
  case "$current_target" in
    versions/*)
      current_version=${current_target#versions/}
      case "$current_version" in
        '' | */*) die "$current_link is not a managed version symlink" ;;
      esac
      is_semver "$current_version" ||
        die "$current_link is not a managed version symlink"
      ;;
    *) die "$current_link is not managed by this installer" ;;
  esac
fi
for name in $bin_names; do
  link=$bin_dir/$name
  expected=$managed_bin_root/$name
  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ ! -L "$link" ] || [ "$(readlink "$link")" != "$expected" ]; then
      die "$link exists and is not managed by this installer"
    fi
  fi
done

mkdir -p "$versions_dir" "$bin_dir"

created_agent_mail_link=0
created_agent_mail_mcp_link=0
installed_target=0
activation_complete=0

activate_version() {
  for name in $bin_names; do
    link=$bin_dir/$name
    expected=$managed_bin_root/$name
    if [ ! -L "$link" ]; then
      next_link=$bin_dir/.agent-mail.$name.$$.tmp
      rm -f "$next_link"
      ln -s "$expected" "$next_link"
      mv -Tf "$next_link" "$link"
      case "$name" in
        agent-mail) created_agent_mail_link=1 ;;
        agent-mail-mcp) created_agent_mail_mcp_link=1 ;;
      esac
    fi
  done

  next_current=$install_root/.current.$$.tmp
  rm -f "$next_current"
  ln -s "versions/$version" "$next_current"
  mv -Tf "$next_current" "$current_link"
  activation_complete=1
}

tmp_dir=
stage=
cleanup() {
  if [ -n "${stage:-}" ] && [ -d "$stage" ]; then
    case "$stage" in
      "$versions_dir"/.install."$version".*) rm -rf -- "$stage" ;;
      *) echo "warning: refusing to clean unexpected stage path: $stage" >&2 ;;
    esac
  fi
  if [ -n "$tmp_dir" ]; then
    rm -rf -- "$tmp_dir"
  fi
  rm -f "$install_root/.current.$$.tmp"
  for name in $bin_names; do
    rm -f "$bin_dir/.agent-mail.$name.$$.tmp"
  done
  if [ "$activation_complete" -ne 1 ]; then
    for entry in \
      "agent-mail:$created_agent_mail_link" \
      "agent-mail-mcp:$created_agent_mail_mcp_link"; do
      name=${entry%%:*}
      created=${entry##*:}
      link=$bin_dir/$name
      expected=$managed_bin_root/$name
      if [ "$created" -eq 1 ] && [ -L "$link" ] &&
        [ "$(readlink "$link")" = "$expected" ]; then
        rm -f "$link"
      fi
    done
    if [ "$installed_target" -eq 1 ] && [ -d "$target_version" ] &&
      [ ! -L "$target_version" ]; then
      rm -rf -- "$target_version"
    fi
  fi
}
trap cleanup EXIT HUP INT TERM

target_bin=$target_version/node_modules/.bin/agent-mail
if [ -L "$target_version" ]; then
  die "$target_version is a symlink; refusing to follow it"
elif [ -x "$target_bin" ]; then
  found_version=$(installed_version "$target_bin")
  [ "$found_version" = "$version" ] ||
    die "existing $target_version reports version ${found_version:-unknown}; refusing to overwrite it"
  activate_version
  echo "agent-mail $version is already installed at $target_version"
  exit 0
elif [ -e "$target_version" ]; then
  die "$target_version exists but is not a valid installation; refusing to overwrite it"
fi

tmp_dir=$(mktemp -d)
asset=agent-mail-$version.tgz
if [ "${AGENT_MAIL_RELEASE_BASE_URL+x}" = x ]; then
  release_base=${AGENT_MAIL_RELEASE_BASE_URL%/}
else
  release_base=https://github.com/dff652/agent-mail/releases/download/v$version
fi
checksums=$tmp_dir/SHA256SUMS
tarball=$tmp_dir/$asset

curl -fsSL "$release_base/SHA256SUMS" -o "$checksums"
curl -fsSL "$release_base/$asset" -o "$tarball"

expected_count=$(awk -v name="$asset" '$2 == name { count++ } END { print count + 0 }' \
  "$checksums")
[ "$expected_count" -eq 1 ] ||
  die "SHA256SUMS must contain exactly one entry for $asset"
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$checksums")
actual=$(sha256_value "$tarball")
[ "$actual" = "$expected" ] ||
  die "SHA256 verification failed for $asset"

stage=$(mktemp -d "$versions_dir/.install.$version.XXXXXX")
npm install \
  --prefix "$stage" \
  --omit=dev \
  --no-audit \
  --no-fund \
  --loglevel=error \
  "$tarball"

stage_bin=$stage/node_modules/.bin/agent-mail
[ -x "$stage_bin" ] || die "installed package is missing the agent-mail executable"
found_version=$(installed_version "$stage_bin")
[ "$found_version" = "$version" ] ||
  die "$asset reported version ${found_version:-unknown}, expected $version"
for name in $bin_names; do
  [ -x "$stage/node_modules/.bin/$name" ] ||
    die "installed package is missing the $name executable"
done

mv "$stage" "$target_version"
stage=
installed_target=1
activate_version

echo "installed agent-mail $version to $target_version"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) echo "hint: add $bin_dir to PATH" ;;
esac
