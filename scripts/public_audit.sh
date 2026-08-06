#!/usr/bin/env bash
# Read-only public-release audit for the current tree and every reachable Git revision.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

failures=0

ok() { printf '  [OK]   %s\n' "$*"; }
bad() {
  printf '  [!]    %s\n' "$*" >&2
  failures=$((failures + 1))
}

# Split repository-specific markers so the scanner source does not match itself.
private_marker_regex='dff''652@|dff''652-gpu|/home/dff''652|192\.168\.2\.(0|22|36)|23\.226\.133\.127|100\.64\.231\.114|~/ilabel/''dff'
secret_regex='BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|tskey-auth-[A-Za-z0-9-]{12,}|sk-[A-Za-z0-9_-]{20,}'

printf '%s\n' 'Public-release audit'

current_secret_hits=""
current_secret_status=0
current_secret_hits="$(
  git grep -I -l -E "$secret_regex" -- . \
    ':(exclude)scripts/public_audit.sh'
)" || current_secret_status=$?
if [[ "$current_secret_status" -gt 1 ]]; then
  bad "could not scan tracked files for high-signal secrets"
elif [[ -n "$current_secret_hits" ]]; then
  bad "tracked files contain high-signal secret candidates:"
  printf '%s\n' "$current_secret_hits" | sed 's/^/           /' >&2
else
  ok "tracked files contain no high-signal secret patterns"
fi

current_topology_hits=""
current_status=0
current_topology_hits="$(
  git grep -I -l -E "$private_marker_regex" -- . \
    ':(exclude)scripts/public_audit.sh'
)" || current_status=$?
if [[ "$current_status" -gt 1 ]]; then
  bad "could not scan tracked files for repository-specific private markers"
elif [[ -n "$current_topology_hits" ]]; then
  bad "tracked files still contain repository-specific private markers:"
  printf '%s\n' "$current_topology_hits" | sed 's/^/           /' >&2
else
  ok "tracked files contain no repository-specific private markers"
fi

revisions=()
while IFS= read -r revision; do
  revisions+=("$revision")
done < <(git rev-list --all)
if [[ "${#revisions[@]}" -eq 0 ]]; then
  bad "repository has no reachable revisions"
else
  history_secret_hits=""
  history_secret_status=0
  history_secret_hits="$(
    git grep -I -l -E "$secret_regex" "${revisions[@]}" -- . \
      ':(exclude)scripts/public_audit.sh' 2>/dev/null |
      sed 's/^[^:]*://' | sort -u
  )" || history_secret_status=$?
  if [[ "$history_secret_status" -gt 1 ]]; then
    bad "could not scan reachable history for high-signal secrets"
  elif [[ -n "$history_secret_hits" ]]; then
    bad "reachable history contains high-signal secret candidates in:"
    printf '%s\n' "$history_secret_hits" | sed 's/^/           /' >&2
  else
    ok "reachable history contains no unallowlisted high-signal secret patterns"
  fi

  history_topology_hits=""
  history_topology_status=0
  history_topology_hits="$(
    git grep -I -l -E "$private_marker_regex" "${revisions[@]}" -- . 2>/dev/null |
      sed 's/^[^:]*://' | sort -u
  )" || history_topology_status=$?
  if [[ "$history_topology_status" -gt 1 ]]; then
    bad "could not scan reachable history for repository-specific private markers"
  elif [[ -n "$history_topology_hits" ]]; then
    bad "reachable history still exposes repository-specific private markers in:"
    printf '%s\n' "$history_topology_hits" | sed 's/^/           /' >&2
  else
    ok "reachable history contains no repository-specific private markers"
  fi
fi

if [[ "$failures" -ne 0 ]]; then
  printf '  [!]    public-release audit failed (%d finding groups)\n' "$failures" >&2
  exit 1
fi

ok "public-release audit passed"
