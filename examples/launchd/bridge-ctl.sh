#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage
  bridge-ctl.sh [--path PROJECT] status
  bridge-ctl.sh [--path PROJECT] start
  bridge-ctl.sh [--path PROJECT] stop
  bridge-ctl.sh [--path PROJECT] kickstart [codex|antigravity|all]

PROJECT defaults to the current directory. AGENT_MAIL_BIN can select the CLI.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 2
}

project=.
action=
selected=
while (( $# )); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --path)
      (( $# >= 2 )) && [[ -n "$2" && "$2" != --* ]] || die "--path requires a project directory"
      project=$2
      shift
      ;;
    status|start|stop|kickstart)
      [[ -z "$action" ]] || die "Choose one subcommand"
      action=$1
      ;;
    codex|antigravity|all)
      [[ "$action" == kickstart && -z "$selected" ]] || die "Runner selection requires kickstart"
      selected=$1
      ;;
    *) die "Unknown argument: $1" ;;
  esac
  shift
done

[[ -n "$action" ]] || { usage; exit 2; }
[[ "$(uname -s)" == Darwin ]] || die "bridge-ctl.sh requires macOS"
project=$(cd -- "$project" && pwd -P) || die "Cannot open the project directory"
[[ -d "$project/.agent-mail" ]] || die "Initialize Agent Mail in $project first"

domain="gui/$(id -u)"
agents="$HOME/Library/LaunchAgents"
runners=(codex antigravity)
if [[ -n "$selected" && "$selected" != all ]]; then
  runners=("$selected")
fi

service_field() {
  awk -F ' = ' -v field="$1" '
    { key = $1; sub(/^[[:space:]]+/, "", key) }
    key == field { sub(/^[^=]+ = /, ""); print; exit }
  '
}

check_project() {
  local plist=$1 info=$2 configured loaded_path loaded_dir
  if ! configured=$(plutil -extract WorkingDirectory raw -- "$plist" 2>/dev/null); then
    printf 'Install an edited LaunchAgent at %s\n' "$plist" >&2
    return 1
  fi
  if [[ "$(cd -- "$configured" 2>/dev/null && pwd -P)" != "$project" ]]; then
    printf '%s has WorkingDirectory %s. Expected %s.\n' "$plist" "$configured" "$project" >&2
    return 1
  fi
  if [[ -n "$info" ]]; then
    loaded_path=$(service_field path <<< "$info")
    loaded_dir=$(service_field 'working directory' <<< "$info")
    if [[ "$loaded_path" != "$plist" ]] ||
      [[ -n "$loaded_dir" && "$(cd -- "$loaded_dir" 2>/dev/null && pwd -P)" != "$project" ]]
    then
      printf 'The loaded service does not match %s for %s\n' "$plist" "$project" >&2
      return 1
    fi
  fi
}

operate() {
  local runner=$1 label target plist info state
  label="org.agent-mail.bridge.$runner"
  target="$domain/$label"
  plist="$agents/$label.plist"
  info=$(launchctl print "$target" 2>/dev/null) || info=

  if [[ "$action" == status ]]; then
    printf '%s\n' "$label"
    if [[ -z "$info" ]]; then
      printf '  not loaded\n'
      return 0
    fi
    check_project "$plist" "$info" || return 1
    awk -F ' = ' '
      { key = $1; sub(/^[[:space:]]+/, "", key) }
      key ~ /^(state|pid|runs|last exit code|last terminating signal)$/ && !seen[key]++ { print "  " key " = " $2 }
    ' <<< "$info"
    if [[ "$(service_field 'last exit code' <<< "$info")" == 5 ]]; then
      printf '  Resolve the wake error, then use kickstart %s\n' "$runner"
    fi
    return 0
  fi

  if [[ -z "$info" ]]; then
    case "$action" in
      stop) printf '%s is already unloaded\n' "$label"; return 0 ;;
      kickstart) printf '%s is unloaded. Run start first.\n' "$label" >&2; return 1 ;;
      start)
        check_project "$plist" "" || return 1
        launchctl bootstrap "$domain" "$plist"
        return
        ;;
    esac
  fi

  check_project "$plist" "$info" || return 1
  if [[ "$action" == stop ]]; then
    launchctl bootout "$target"
  else
    state=$(service_field state <<< "$info")
    if [[ "$state" == running ]]; then
      printf '%s is already running\n' "$label"
    else
      launchctl kickstart "$target"
    fi
  fi
}

exit_code=0
for runner in "${runners[@]}"; do
  operate "$runner" || exit_code=1
done

if [[ "$action" == status ]]; then
  if [[ -n "${AGENT_MAIL_BIN:-}" ]]; then
    cli=("$AGENT_MAIL_BIN")
  elif command -v agent-mail >/dev/null 2>&1; then
    cli=(agent-mail)
  else
    here=$(cd -- "$(dirname -- "$0")" && pwd -P)
    cli=(node "$here/../../packages/agent-mail/dist/cli.js")
    if ! command -v node >/dev/null 2>&1 || [[ ! -f "${cli[1]}" ]]; then
      die "Put agent-mail on PATH, build the local package with Node on PATH, or set AGENT_MAIL_BIN"
    fi
  fi
  printf '\nPending approvals\n'
  "${cli[@]}" approvals --path "$project" --status pending || exit_code=1
  printf '\nRecent errors\n'
  "${cli[@]}" logs --path "$project" --outcome error --limit 10 || exit_code=1
fi

exit "$exit_code"
