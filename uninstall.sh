#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${HOME}/.codex/skills/agentchat-code-offload"
WEB_INGEST_SKILL_DIR="${HOME}/.agents/skills/web-ingest"
ROUTING_SKILL_DIR="${HOME}/.agents/skills/luna-model-routing"
REPO_EXECUTION_SKILL_DIR="${HOME}/.agents/skills/repo-execution"
ADAPTER_DIR="${CODEX_CODE_OFFLOAD_HOME:-${HOME}/.local/share/codex-code-offload}"
STATE_DIR="${HOME}/.local/state/codex-web-reasoning"

log() { printf '\n[uninstall] %s\n' "$*"; }

remove_link() {
  local link="$1" expected_target="$2"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link" 2>/dev/null || true)" = "$expected_target" ]; then
      rm -f "$link"
      log "Removed link: ${link}"
    else
      log "Skipping symlink with unexpected target: ${link}"
    fi
  elif [ -e "$link" ]; then
    log "Skipping (not a symlink, left untouched): ${link}"
  fi
}

remove_link "${SKILL_DIR}" "${REPO_ROOT}/skill"
remove_link "${WEB_INGEST_SKILL_DIR}" "${REPO_ROOT}/skills/web-ingest"
remove_link "${ROUTING_SKILL_DIR}" "${REPO_ROOT}/skills/luna-model-routing"
remove_link "${REPO_EXECUTION_SKILL_DIR}" "${REPO_ROOT}/skills/repo-execution"
remove_link "${ADAPTER_DIR}" "${REPO_ROOT}/adapter"

if [ -d "${STATE_DIR}" ]; then
  rm -rf "${STATE_DIR}"
  log "Removed state directory: ${STATE_DIR}"
fi

log "Uninstall complete. The repository files were not modified."
