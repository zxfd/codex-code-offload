import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBrowserClientEntry } from '../browser-client-entry.mjs';

function prepareCandidate({ root, version, writable = true } = {}) {
  const candidateRoot = join(root, 'browser', version);
  mkdirSync(join(candidateRoot, 'scripts'), { recursive: true });
  if (writable) {
    mkdirSync(join(candidateRoot, 'skills'), { recursive: true });
    writeFileSync(join(candidateRoot, 'scripts', 'browser-client.mjs'), 'export default {};\n');
  }
  return join(candidateRoot, 'scripts', 'browser-client.mjs');
}

test('resolves the latest browser client entry from a valid cache root', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-cache-'));
  const cacheRoot = join(fixtureRoot, 'openai-bundled');
  try {
    prepareCandidate({ root: cacheRoot, version: '26.810.41047', writable: false });
    const expected = prepareCandidate({ root: cacheRoot, version: '26.810.50000' });
    assert.equal(resolveBrowserClientEntry({ pluginCacheRoot: cacheRoot }), expected);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('corrects a control-in-app-browser skill path back to its plugin cache root', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-cache-'));
  const cacheRoot = join(fixtureRoot, 'openai-bundled');
  const wrongRoot = join(cacheRoot, 'browser', '27.2.0', 'skills', 'control-in-app-browser');
  try {
    const expected = prepareCandidate({ root: cacheRoot, version: '27.2.0' });
    assert.equal(resolveBrowserClientEntry({ pluginCacheRoot: wrongRoot }), expected);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('throws with candidate paths when no browser client is available', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-cache-'));
  const cacheRoot = join(fixtureRoot, 'openai-bundled');
  mkdirSync(cacheRoot, { recursive: true });
  try {
    assert.throws(
      () => resolveBrowserClientEntry({ pluginCacheRoot: cacheRoot, exists: () => false }),
      error => error.message.includes(join(cacheRoot, 'browser', '<version>', 'scripts', 'browser-client.mjs'))
        && error.message.includes(join(cacheRoot, 'browser', '<version>', 'skills')),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
