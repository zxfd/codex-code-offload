import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  cleanupStagedIngestResult,
  extractAndStageSingleUrl,
  readStagedIngestResult,
} from '../web-ingest.mjs';

function makeTab(finalUrl = 'https://example.com/page') {
  return {
    async goto() {},
    async url() { return finalUrl; },
    async close() {},
    async screenshot() { return new Uint8Array([137, 80, 78, 71]); },
  };
}

function signals(overrides = {}) {
  return {
    pageTitle: 'Example', visibleText: 'bounded visible text', imageCount: 1,
    canvasCount: 0, tableCount: 0, imageAlts: ['hero'],
    visualRegions: [], loadState: 'complete', ...overrides,
  };
}

test('extract, read, and clean use a bounded temporary result', async () => {
  const response = await extractAndStageSingleUrl({
    url: 'https://example.com/page', objective: 'read the visible summary',
    openBrowserTab: async () => makeTab(), extractSignals: async () => signals(),
  });
  assert.equal(response.status, 'staged');
  assert.equal(response.modality, 'text');
  assert.equal(typeof response.temporaryFilePath, 'string');
  assert.equal(statSync(response.temporaryFilePath).mode & 0o777, 0o600);
  const staged = readStagedIngestResult(response.temporaryFilePath);
  assert.equal(staged.status, 'available');
  assert.equal(staged.visibleTextExcerpt, 'bounded visible text');
  assert.equal('html' in staged, false);
  const cleaned = cleanupStagedIngestResult(response.temporaryFilePath);
  assert.equal(cleaned.temporaryFileRemoved, true);
  assert.equal(existsSync(response.temporaryFilePath), false);
});

test('multimodal results keep visual signals in JSON and pixels as bounded files', async () => {
  const response = await extractAndStageSingleUrl({
    url: 'https://example.com/chart', objective: 'inspect the screenshot and chart',
    openBrowserTab: async () => makeTab(),
    extractSignals: async () => signals({ canvasCount: 1, visualRegions: [{ x: 1, y: 2, width: 30, height: 40 }] }),
  });
  assert.equal(response.status, 'staged');
  assert.equal(response.modality, 'multimodal');
  const staged = readStagedIngestResult(response.temporaryFilePath);
  assert.equal(staged.visualArtifacts.length, 1);
  assert.deepEqual(staged.visualRegions, [{ x: 1, y: 2, width: 30, height: 40 }]);
  assert.deepEqual([...readFileSync(staged.visualArtifacts[0])], [137, 80, 78, 71]);
  cleanupStagedIngestResult(response.temporaryFilePath);
});

test('cross-domain redirects and high-risk text never create a staged result', async () => {
  const redirect = await extractAndStageSingleUrl({
    url: 'https://example.com/page', objective: 'read summary',
    openBrowserTab: async () => makeTab('https://other.example/page'), extractSignals: async () => signals(),
  });
  assert.equal(redirect.status, 'failed');
  assert.equal(redirect.temporaryFilePath, null);
  const sensitive = await extractAndStageSingleUrl({
    url: 'https://example.com/page', objective: 'read summary',
    openBrowserTab: async () => makeTab(), extractSignals: async () => signals({ visibleText: 'Bearer token: abc' }),
  });
  assert.equal(sensitive.status, 'blocked');
  assert.equal(sensitive.temporaryFilePath, null);
});

test('read and clean reject paths outside managed temporary workspaces', () => {
  assert.throws(() => readStagedIngestResult('/tmp/result.json'), /outside the managed temporary workspace/);
  assert.throws(() => cleanupStagedIngestResult('/tmp/result.json'), /outside the managed temporary workspace/);
});
