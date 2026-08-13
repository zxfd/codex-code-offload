#!/usr/bin/env bash
set -euo pipefail

# Canonical install locations (XDG-style, relative to $HOME).
# CODEX_CODE_OFFLOAD_HOME overrides only the adapter/config location; the Skill
# always lives under ~/.codex/skills/agentchat-code-offload.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${HOME}/.codex/skills/agentchat-code-offload"
ADAPTER_DIR="${CODEX_CODE_OFFLOAD_HOME:-${HOME}/.local/share/codex-code-offload}"
STATE_DIR="${HOME}/.local/state/codex-web-reasoning"

log() { printf '\n[install] %s\n' "$*"; }
warn() { printf '[install] WARN: %s\n' "$*"; }
die() { printf '\n[install] ERROR: %s\n' "$*" >&2; exit 1; }

log "Repo:    ${REPO_ROOT}"
log "Skill:   ${SKILL_DIR}"
log "Adapter: ${ADAPTER_DIR}"
log "State:   ${STATE_DIR}"

command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org)"
command -v npm >/dev/null 2>&1 || die "npm is required"
command -v rg >/dev/null 2>&1 || warn "ripgrep (rg) missing; adapter symbol/search requests will fail"
command -v pdftotext >/dev/null 2>&1 || warn "pdftotext missing; PDF document analysis will be unavailable"

link_dir() {
  local target="$1" link="$2"
  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ "$(readlink "$link" 2>/dev/null || true)" = "$target" ]; then
      log "Already linked: ${link} -> ${target}"
      return
    fi
    die "Refusing to overwrite existing path (not the expected symlink): ${link}"
  fi
  mkdir -p "$(dirname "$link")"
  ln -s "$target" "$link"
  log "Linked: ${link} -> ${target}"
}

link_dir "${REPO_ROOT}/skill" "${SKILL_DIR}"
link_dir "${REPO_ROOT}/adapter" "${ADAPTER_DIR}"

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

