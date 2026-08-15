#!/usr/bin/env bash
set -euo pipefail

# Canonical install locations (XDG-style, relative to $HOME).
# CODEX_CODE_OFFLOAD_HOME overrides only the adapter/config location; the Skill
# always lives under ~/.codex/skills/agentchat-code-offload.
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
ROUTING_SKILL_FILE="${ROUTING_SKILL_DIR}/SKILL.md"
REPO_EXECUTION_SKILL_DIR="${HOME}/.agents/skills/repo-execution"
REPO_EXECUTION_SKILL_FILE="${REPO_EXECUTION_SKILL_DIR}/SKILL.md"
ADAPTER_DIR="${CODEX_CODE_OFFLOAD_HOME:-${HOME}/.local/share/codex-code-offload}"
STATE_DIR="${HOME}/.local/state/codex-web-reasoning"

log() { printf '\n[install] %s\n' "$*"; }
warn() { printf '[install] WARN: %s\n' "$*"; }
die() { printf '\n[install] ERROR: %s\n' "$*" >&2; exit 1; }

log "Repo:    ${REPO_ROOT}"
log "Skill:   ${SKILL_DIR}"
log "Web ingest: ${WEB_INGEST_SKILL_DIR}"
log "Web page extract: ${WEB_LLM_PAGE_EXTRACT_SKILL_DIR}"
log "Routing: ${ROUTING_SKILL_DIR}"
log "Repo rules: ${REPO_EXECUTION_SKILL_DIR}"
log "Adapter: ${ADAPTER_DIR}"
log "State:   ${STATE_DIR}"

command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org)"
command -v npm >/dev/null 2>&1 || die "npm is required"
command -v rg >/dev/null 2>&1 || warn "ripgrep (rg) missing; adapter symbol/search requests will fail"
command -v pdftotext >/dev/null 2>&1 || warn "pdftotext missing; PDF document analysis will be unavailable"

link_dir() {
  local target="$1" link="$2"
  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ ! -L "$link" ]; then
      die "Refusing to overwrite existing non-symlink path: ${link}"
    fi
    local actual_target expected_target
    actual_target="$(cd -P "$link" 2>/dev/null && pwd -P)" \
      || die "Refusing to use symlink with an unresolvable target: ${link}"
    expected_target="$(cd -P "$target" 2>/dev/null && pwd -P)" \
      || die "Expected symlink target is not resolvable: ${target}"
    if [ "$actual_target" = "$expected_target" ]; then
      log "Already linked: ${link} -> ${target}"
      return
    fi
    die "Refusing to overwrite symlink with an unexpected target: ${link}"
  fi
  mkdir -p "$(dirname "$link")"
  ln -s "$target" "$link"
  log "Linked: ${link} -> ${target}"
}

link_dir "${REPO_ROOT}/skill" "${SKILL_DIR}"
link_dir "${REPO_ROOT}/skills/web-ingest" "${WEB_INGEST_SKILL_DIR}"
link_dir "${REPO_ROOT}/skills/web-llm-page-extract" "${WEB_LLM_PAGE_EXTRACT_SKILL_DIR}"
link_dir "${REPO_ROOT}/skills/luna-model-routing" "${ROUTING_SKILL_DIR}"
link_dir "${REPO_ROOT}/skills/repo-execution" "${REPO_EXECUTION_SKILL_DIR}"
link_dir "${REPO_ROOT}/adapter" "${ADAPTER_DIR}"

if [ ! -r "${ROUTING_SKILL_FILE}" ]; then
  die "Routing Skill entrypoint is not readable: ${ROUTING_SKILL_FILE}"
fi
log "Routing Skill entrypoint verified: ${ROUTING_SKILL_FILE}"

if [ ! -r "${REPO_EXECUTION_SKILL_FILE}" ]; then
  die "Repository execution Skill entrypoint is not readable: ${REPO_EXECUTION_SKILL_FILE}"
fi
log "Repository execution Skill entrypoint verified: ${REPO_EXECUTION_SKILL_FILE}"

SKILL_INTEGRITY_CHECK="${REPO_EXECUTION_SKILL_DIR}/scripts/verify-installed-skill.mjs"
if [ ! -r "${SKILL_INTEGRITY_CHECK}" ]; then
  die "Skill integrity checker is not readable: ${SKILL_INTEGRITY_CHECK}"
fi
node "${SKILL_INTEGRITY_CHECK}" \
  --source "${REPO_ROOT}/skills/repo-execution" \
  --installed "${REPO_EXECUTION_SKILL_DIR}" \
  || die "Repository execution Skill install integrity check failed"
node "${SKILL_INTEGRITY_CHECK}" \
  --source "${REPO_ROOT}/skills/luna-model-routing" \
  --installed "${ROUTING_SKILL_DIR}" \
  || die "Routing Skill install integrity check failed"
node "${SKILL_INTEGRITY_CHECK}" \
  --source "${REPO_ROOT}/skills/web-ingest" \
  --installed "${WEB_INGEST_SKILL_DIR}" \
  || die "Standalone web-ingest Skill install integrity check failed"
node "${SKILL_INTEGRITY_CHECK}" \
  --source "${REPO_ROOT}/skills/web-llm-page-extract" \
  --installed "${WEB_LLM_PAGE_EXTRACT_SKILL_DIR}" \
  || die "Web-LLM page-extract Skill install integrity check failed"
node "${ROUTING_SKILL_DIR}/scripts/health-check.mjs" \
  --root "${ROUTING_SKILL_DIR}" \
  || die "Routing Skill runtime entry health check failed"
node "${WEB_INGEST_SKILL_DIR}/scripts/health-check.mjs" \
  --root "${WEB_INGEST_SKILL_DIR}" \
  || die "Standalone web-ingest Skill runtime entry health check failed"
node "${WEB_LLM_PAGE_EXTRACT_SKILL_DIR}/scripts/health-check.mjs" \
  --root "${WEB_LLM_PAGE_EXTRACT_SKILL_DIR}" \
  || die "Web-LLM page-extract Skill runtime entry health check failed"
log "Installed Skill resources and runtime entries verified"

mkdir -p "${STATE_DIR}"
log "State directory ready: ${STATE_DIR}"

log "Installing adapter dependencies (npm install)..."
( cd "${ADAPTER_DIR}" && npm install --no-audit --no-fund )

log "Install complete."
cat <<'EOF'

Remaining one-time manual steps:
  1. Sign in to ChatGPT, DeepSeek, Qwen, and Gemini in the browser you want
     Codex to drive. The adapters reuse existing logged-in sessions; no API
     keys are used.
  2. To make Codex offload large tasks automatically, append the routing block
     from config/agents-md-offload-block.md to your global AGENTS.md.
  3. Optional: set CODEX_CODE_OFFLOAD_HOME if the adapter is installed outside
     ~/.local/share/codex-code-offload.

To remove the installation, run: ./uninstall.sh
EOF
