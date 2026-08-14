import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runLunaModelRoutingHealthCheck } from '../health-check.mjs';

function makeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-luna-health-check-'));
  const skillRoot = join(fixtureRoot, 'skills', 'luna-model-routing');
  const skillScripts = join(skillRoot, 'scripts');
  const genericScripts = join(fixtureRoot, 'skill', 'scripts');
  mkdirSync(skillScripts, { recursive: true });
  mkdirSync(genericScripts, { recursive: true });
  writeFileSync(join(genericScripts, 'web-ingest.mjs'), "export function ingestSingleUrlWithLocalContext() {}\nexport function captureVisualArtifacts() {}\n");
  writeFileSync(join(genericScripts, 'browser-client-entry.mjs'), "export function resolveBrowserClientEntry() {}\n");
  writeFileSync(join(skillScripts, 'web-ingest.mjs'), "export * from '../../../skill/scripts/web-ingest.mjs';\n");
  writeFileSync(join(skillScripts, 'browser-client-entry.mjs'), "export * from '../../../skill/scripts/browser-client-entry.mjs';\n");
  return { fixtureRoot, skillRoot, skillScripts };
}

test('health check passes with portable entry forwarding modules', async () => {
  const { fixtureRoot, skillRoot } = makeFixture();
  try {
    const report = await runLunaModelRoutingHealthCheck({ skillRoot });
    assert.equal(report.ok, true);
    assert.equal(report.checks.some(item => item.name === 'global_skill_root' && item.status === 'pass'), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('health check fails when browser-client-entry is missing', async () => {
  const { fixtureRoot, skillRoot, skillScripts } = makeFixture();
  try {
    rmSync(join(skillScripts, 'browser-client-entry.mjs'));
    const report = await runLunaModelRoutingHealthCheck({ skillRoot });
    assert.equal(report.ok, false);
    const failure = report.checks.find(item => item.name === 'entry:scripts/browser-client-entry.mjs' && item.status === 'fail');
    assert.equal(failure.message.includes('missing'), true);
    assert.equal(typeof failure.remediation, 'string');
    assert.equal(failure.remediation.includes('forwarding module'), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('health check fails when forwarding uses an absolute path', async () => {
  const { fixtureRoot, skillRoot, skillScripts } = makeFixture();
  try {
    const absoluteTarget = join(fixtureRoot, 'skill', 'scripts', 'web-ingest.mjs');
    writeFileSync(join(skillScripts, 'web-ingest.mjs'), `export * from '${absoluteTarget}';\n`);
    const report = await runLunaModelRoutingHealthCheck({ skillRoot });
    assert.equal(report.ok, false);
    const check = report.checks.find(item => item.name === 'forwarding:scripts/web-ingest.mjs' && item.status === 'fail');
    assert.equal(check.message.includes('absolute'), true);
    assert.equal(readFileSync(join(skillScripts, 'web-ingest.mjs'), 'utf8').startsWith('export * from'), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
