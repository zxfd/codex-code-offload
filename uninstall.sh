#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -L "${SCRIPT_PATH}" ]; do
  SCRIPT_DIR="$(cd -P "$(dirname "${SCRIPT_PATH}")" && pwd)"
  SCRIPT_TARGET="$(readlink "${SCRIPT_PATH}")"
  if [[ "${SCRIPT_TARGET}" != /* ]]; then
    SCRIPT_PATH="${SCRIPT_DIR}/${SCRIPT_TARGET}"
  else
    SCRIPT_PATH="${SCRIPT_TARGET}"
  fi
done
REPO_ROOT="$(cd -P "$(dirname "${SCRIPT_PATH}")" && pwd)"
SKILL_DIR="${HOME}/.codex/skills/agentchat-code-offload"
WEB_INGEST_SKILL_DIR="${HOME}/.agents/skills/web-ingest"
WEB_LLM_PAGE_EXTRACT_SKILL_DIR="${HOME}/.agents/skills/web-llm-page-extract"
ROUTING_SKILL_DIR="${HOME}/.agents/skills/luna-model-routing"
REPO_EXECUTION_SKILL_DIR="${HOME}/.agents/skills/repo-execution"
ADAPTER_DIR="${CODEX_CODE_OFFLOAD_HOME:-${HOME}/.local/share/codex-code-offload}"
STATE_DIR="${HOME}/.local/state/codex-web-reasoning"

log() { printf '\n[uninstall] %s\n' "$*"; }

remove_link() {
  local link="$1" expected_target="$2"
  if [ -L "$link" ]; then
    local actual_canonical expected_canonical
    actual_canonical="$(cd -P "$link" 2>/dev/null && pwd -P)" || {
      log "Skipping symlink with an unresolvable target: ${link}"
      return
    }
    expected_canonical="$(cd -P "$expected_target" 2>/dev/null && pwd -P)" || {
      log "Skipping link because expected target is unresolvable: ${link}"
      return
    }
    if [ "$actual_canonical" = "$expected_canonical" ]; then
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
remove_link "${WEB_LLM_PAGE_EXTRACT_SKILL_DIR}" "${REPO_ROOT}/skills/web-llm-page-extract"
remove_link "${ROUTING_SKILL_DIR}" "${REPO_ROOT}/skills/luna-model-routing"
remove_link "${REPO_EXECUTION_SKILL_DIR}" "${REPO_ROOT}/skills/repo-execution"
remove_link "${ADAPTER_DIR}" "${REPO_ROOT}/adapter"

if [ -d "${STATE_DIR}" ]; then
  rm -rf "${STATE_DIR}"
  log "Removed state directory: ${STATE_DIR}"
fi

log "Uninstall complete. The repository files were not modified."
