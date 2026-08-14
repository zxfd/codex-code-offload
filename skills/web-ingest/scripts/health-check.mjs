#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_EXPORTS = [
  'DEFAULT_PROCESSING_POLICY',
  'captureVisualArtifacts',
  'classifyModality',
  'collectSignalsFromTab',
  'ingestSingleUrlWithLocalContext',
  'isNeedMoreContext',
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = { root: SCRIPT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      options.root = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function check(report, name, ok, message) {
  report.checks.push({ name, status: ok ? 'pass' : 'fail', message });
  if (!ok) report.ok = false;
}

function frontmatterKeys(skillText) {
  const match = skillText.match(/^---\n([\s\S]*?)\n---/u);
  if (!match) return null;
  return match[1]
    .split('\n')
    .map(line => line.match(/^([A-Za-z0-9_-]+):/u)?.[1])
    .filter(Boolean);
}

export async function runWebIngestHealthCheck({ root = SCRIPT_ROOT } = {}) {
  const skillRoot = resolve(root);
  const report = { ok: true, skillRoot, checks: [], summary: [] };
  let rootStat;
  try {
    rootStat = lstatSync(skillRoot);
    check(report, 'skill_root', statSync(skillRoot).isDirectory(), `skill root is ${statSync(skillRoot).isDirectory() ? 'a directory' : 'not a directory'}: ${skillRoot}`);
  } catch {
    check(report, 'skill_root', false, `skill root not found: ${skillRoot}`);
    return report;
  }

  const skillPath = resolve(skillRoot, 'SKILL.md');
  const corePath = resolve(skillRoot, 'scripts', 'web-ingest.mjs');
  const healthPath = resolve(skillRoot, 'scripts', 'health-check.mjs');
  check(report, 'skill_file', existsSync(skillPath), `SKILL.md ${existsSync(skillPath) ? 'found' : 'missing'}`);
  check(report, 'core_file', existsSync(corePath), `scripts/web-ingest.mjs ${existsSync(corePath) ? 'found' : 'missing'}`);
  check(report, 'health_file', existsSync(healthPath), `scripts/health-check.mjs ${existsSync(healthPath) ? 'found' : 'missing'}`);

  if (existsSync(skillPath)) {
    const keys = frontmatterKeys(readFileSync(skillPath, 'utf8'));
    check(report, 'frontmatter', Boolean(keys) && keys.length === 2 && keys.includes('name') && keys.includes('description'), 'SKILL.md frontmatter contains only name and description');
  }

  if (existsSync(corePath)) {
    const source = readFileSync(corePath, 'utf8');
    check(report, 'provider_independence', !/web-provider-runner|runProviderFallback/u.test(source), 'canonical core has no concrete Provider runner dependency');
    try {
      const namespace = await import(pathToFileURL(corePath).href);
      const missing = REQUIRED_EXPORTS.filter(name => !(name in namespace));
      check(report, 'core_exports', missing.length === 0, missing.length ? `missing exports: ${missing.join(', ')}` : 'canonical core exports are available');
    } catch (error) {
      check(report, 'core_import', false, `canonical core import failed: ${error.message}`);
    }
  }

  report.summary = [
    `root=${rootStat.isSymbolicLink() ? 'symlink' : 'directory'}`,
    `checks=${report.checks.length}`,
    `failed=${report.checks.filter(item => item.status === 'fail').length}`,
  ];
  return report;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const report = await runWebIngestHealthCheck(parseArgs());
  for (const item of report.checks) console.log(`[${item.status.toUpperCase()}] ${item.name}: ${item.message}`);
  console[report.ok ? 'log' : 'error'](`web-ingest health check ${report.ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = report.ok ? 0 : 1;
}
