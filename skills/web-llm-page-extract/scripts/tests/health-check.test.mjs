import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPageExtractHealthCheck } from '../health-check.mjs';

test('page-extract health check validates the complete source runtime', async () => {
  const root = new URL('../..', import.meta.url).pathname;
  const report = await runPageExtractHealthCheck({ root });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.checks.some(item => item.name === 'exports:scripts/run-page-extract.mjs' && item.status === 'pass'), true);
  assert.equal(report.checks.some(item => item.name === 'exports:scripts/bounded-dom.mjs' && item.status === 'pass'), true);
});

test('page-extract health check fails closed for a missing root', async () => {
  const report = await runPageExtractHealthCheck({ root: '/tmp/codex-missing-web-llm-page-extract' });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].name, 'skill_root');
});

test('page-extract health check executes through an installed root symlink', () => {
  const sourceRoot = new URL('../..', import.meta.url).pathname;
  const temp = mkdtempSync(join(tmpdir(), 'codex-page-extract-health-'));
  const installedRoot = join(temp, 'web-llm-page-extract');
  try {
    symlinkSync(sourceRoot, installedRoot, 'dir');
    const result = spawnSync(process.execPath, [
      join(installedRoot, 'scripts', 'health-check.mjs'),
      '--root', installedRoot,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /web-llm-page-extract health check PASS/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
