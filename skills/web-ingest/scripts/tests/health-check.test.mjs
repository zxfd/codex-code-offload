import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { runWebIngestHealthCheck } from '../health-check.mjs';

const SOURCE_ROOT = join(process.cwd(), 'skills', 'web-ingest');

test('standalone health check validates source root without browser or Provider access', async () => {
  const report = await runWebIngestHealthCheck({ root: SOURCE_ROOT });
  assert.equal(report.ok, true);
  assert.equal(report.checks.some(item => item.name === 'provider_independence' && item.status === 'pass'), true);
  assert.equal(report.checks.some(item => item.name === 'core_exports' && item.status === 'pass'), true);
});

test('standalone health check supports an explicit installed root', () => {
  const result = spawnSync(process.execPath, [
    join(SOURCE_ROOT, 'scripts', 'health-check.mjs'),
    '--root',
    SOURCE_ROOT,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /web-ingest health check PASS/u);
});
