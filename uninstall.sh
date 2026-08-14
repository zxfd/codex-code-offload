#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${HOME}/.codex/skills/agentchat-code-offload"
ROUTING_SKILL_DIR="${HOME}/.agents/skills/luna-model-routing"
REPO_EXECUTION_SKILL_DIR="${HOME}/.agents/skills/repo-execution"
ADAPTER_DIR="${CODEX_CODE_OFFLOAD_HOME:-${HOME}/.local/share/codex-code-offload}"
STATE_DIR="${HOME}/.local/state/codex-web-reasoning"

log() { printf '\n[uninstall] %s\n' "$*"; }

remove_link() {
  local link="$1"
  if [ -L "$link" ]; then
    rm -f "$link"
    log "Removed link: ${link}"
  elif [ -e "$link" ]; then
    log "Skipping (not a symlink, left untouched): ${link}"
  fi
}

remove_link "${SKILL_DIR}"
remove_link "${ROUTING_SKILL_DIR}"
remove_link "${REPO_EXECUTION_SKILL_DIR}"
remove_link "${ADAPTER_DIR}"

if [ -d "${STATE_DIR}" ]; then
  rm -rf "${STATE_DIR}"
  log "Removed state directory: ${STATE_DIR}"
fi

log "Uninstall complete. The repository files were not modified."
