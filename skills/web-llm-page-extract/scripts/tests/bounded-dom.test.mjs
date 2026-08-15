import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cleanupBoundedDomArtifact,
  createBoundedTaskExtractSignals,
  normalizeTaskTermGroups,
  stageBoundedDomArtifact,
} from '../bounded-dom.mjs';
import { copyDomToClipboard } from '../copy-dom-to-clipboard.mjs';

const requestUrl = 'https://example.test/airdrop';
const taskTermGroups = [
  ['空投', 'airdrop'],
  ['奖励', 'reward'],
  ['参与', 'join'],
];

function extractedPayload(overrides = {}) {
  const domText = `<section><h2>空投奖励</h2><ul>${'<li>项目 USDT 奖池 可参与</li>'.repeat(20)}</ul></section>`;
  return {
    artifact: {
      domSource: 'controlled-browser-same-origin',
      sameContext: true,
      domComplete: false,
      sourceUrl: requestUrl,
      finalUrl: requestUrl,
      domScope: 'main > section:nth-of-type(2)',
      domText,
      risk: { level: 'low' },
      selection: { matchedTermGroups: 3, contentUnits: 20, visibleChildren: 2 },
    },
    signals: {
      pageTitle: 'fixture',
      visibleText: '空投奖励 USDT 奖池 可参与',
      imageCount: 0,
      canvasCount: 0,
      tableCount: 0,
      imageAlts: [],
      visualRegions: [],
      loadState: 'complete',
      location: { href: requestUrl, origin: 'https://example.test' },
    },
    metadata: {
      finalUrl: requestUrl,
      domScope: 'main > section:nth-of-type(2)',
      domBytes: Buffer.byteLength(domText),
      matchedTermGroups: 3,
      contentUnits: 20,
      visibleChildren: 2,
    },
    ...overrides,
  };
}

function makeTab(payload = extractedPayload()) {
  const events = [];
  return {
    events,
    async goto(url) { events.push(`goto:${url}`); },
    async url() { return requestUrl; },
    async close() { events.push('close'); },
    playwright: {
      async evaluate(_fn, args) { events.push(`evaluate:${args.sourceUrl}`); return payload; },
      async waitForLoadState() {},
      async waitForTimeout() {},
    },
  };
}

test('task term groups are explicit, bounded, and normalized', () => {
  assert.deepEqual(normalizeTaskTermGroups([[' 空投 ', 'AIRDROP'], ' 奖励 ']), [['空投', 'airdrop'], ['奖励']]);
  assert.throws(() => normalizeTaskTermGroups([['only-one-group']]), /task_term_groups_invalid/u);
  assert.throws(() => normalizeTaskTermGroups([['a'.repeat(81)], ['b']]), /task_term_group_invalid/u);
});

test('same-context hook writes one bounded DOM artifact without returning DOM in its signal receipt', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-web-llm-page-extract-'));
  const artifactPath = join(workspace, 'dom.json');
  try {
    const signals = await createBoundedTaskExtractSignals({
      requestUrl,
      taskTermGroups,
      artifactPath,
    })(makeTab());
    assert.equal(existsSync(artifactPath), true);
    assert.equal('domText' in signals, false);
    const clipboard = copyDomToClipboard(artifactPath, { dryRun: true });
    assert.equal(clipboard.clipboardWritten, false);
    assert.match(clipboard.sha256, /^[a-f0-9]{64}$/u);
    assert.equal('text' in clipboard, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('stage helper health-checks web-ingest, stages once, cleans its result, and retains only the bounded artifact', async () => {
  const tab = makeTab();
  const result = await stageBoundedDomArtifact({
    url: requestUrl,
    objective: '识别仍可参与且奖励较高的空投',
    taskTermGroups,
    browser: { tabs: { new: async () => tab } },
    browserChannel: 'chrome',
    webIngestRoot: new URL('../../../web-ingest', import.meta.url).pathname,
  });
  try {
    assert.equal(result.status, 'ready');
    assert.equal(result.receipt.webIngestHealth, true);
    assert.equal(result.receipt.stagedCleanup, true);
    assert.equal(result.receipt.matchedTermGroups, 3);
    assert.equal(existsSync(result.domArtifactPath), true);
    assert.deepEqual(tab.events.filter(event => event === 'close'), ['close']);
  } finally {
    const cleanup = cleanupBoundedDomArtifact(result.domArtifactPath);
    assert.equal(cleanup.domArtifactRemoved, true);
  }
});

test('same-context proof rejects a cross-origin artifact and removes its workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-web-llm-page-extract-'));
  const artifactPath = join(workspace, 'dom.json');
  const payload = extractedPayload({
    artifact: { ...extractedPayload().artifact, finalUrl: 'https://other.test/airdrop' },
  });
  try {
    await assert.rejects(
      createBoundedTaskExtractSignals({ requestUrl, taskTermGroups, artifactPath })(makeTab(payload)),
      /cross_origin_dom_artifact/u,
    );
    assert.equal(existsSync(artifactPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
