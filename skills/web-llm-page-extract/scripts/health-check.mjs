#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_FILES = [
  'SKILL.md',
  'scripts/bounded-dom.mjs',
  'scripts/copy-dom-to-clipboard.mjs',
  'scripts/run-page-extract.mjs',
  'scripts/structured-response.mjs',
];
const REQUIRED_EXPORTS = {
  'scripts/bounded-dom.mjs': [
    'cleanupBoundedDomArtifact',
    'createBoundedTaskExtractSignals',
    'stageBoundedDomArtifact',
  ],
  'scripts/copy-dom-to-clipboard.mjs': ['copyDomToClipboard'],
  'scripts/run-page-extract.mjs': [
    'buildStructuredExtractionInstruction',
    'createSingleProviderConfig',
    'runWebLlmPageExtract',
  ],
  'scripts/structured-response.mjs': ['parseStructuredAssistantResponse'],
};

function check(report, name, ok, message) {
  report.checks.push({ name, status: ok ? 'pass' : 'fail', message });
  if (!ok) report.ok = false;
}

function frontmatterKeys(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/u);
  if (!match) return null;
  return match[1].split('\n').map(line => line.match(/^([A-Za-z0-9_-]+):/u)?.[1]).filter(Boolean);
}

export async function runPageExtractHealthCheck({ root = SCRIPT_ROOT } = {}) {
  const skillRoot = resolve(root);
  const report = { ok: true, skillRoot, checks: [] };
  check(report, 'skill_root', existsSync(skillRoot) && statSync(skillRoot).isDirectory(), `skill root: ${skillRoot}`);
  if (!report.ok) return report;
  for (const relativePath of REQUIRED_FILES) {
    const path = resolve(skillRoot, relativePath);
    check(report, `file:${relativePath}`, existsSync(path) && statSync(path).isFile(), `${relativePath} is present`);
  }
  const skillPath = resolve(skillRoot, 'SKILL.md');
  if (existsSync(skillPath)) {
    const keys = frontmatterKeys(readFileSync(skillPath, 'utf8'));
    check(report, 'frontmatter', Boolean(keys) && keys.length === 2 && keys.includes('name') && keys.includes('description'), 'SKILL.md frontmatter contains only name and description');
  }
  for (const [relativePath, names] of Object.entries(REQUIRED_EXPORTS)) {
    const path = resolve(skillRoot, relativePath);
    if (!existsSync(path)) continue;
    try {
      const module = await import(pathToFileURL(path).href);
      const missing = names.filter(name => typeof module[name] !== 'function');
      check(report, `exports:${relativePath}`, missing.length === 0, missing.length ? `missing exports: ${missing.join(', ')}` : 'required exports are available');
    } catch (error) {
      check(report, `import:${relativePath}`, false, `module import failed: ${error.message}`);
    }
  }
  return report;
}

function isMainModule() {
  if (typeof process === 'undefined' || !process?.argv?.[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1] : SCRIPT_ROOT;
  const report = await runPageExtractHealthCheck({ root });
  for (const item of report.checks) console.log(`[${item.status.toUpperCase()}] ${item.name}: ${item.message}`);
  console[report.ok ? 'log' : 'error'](`web-llm-page-extract health check ${report.ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = report.ok ? 0 : 1;
}
