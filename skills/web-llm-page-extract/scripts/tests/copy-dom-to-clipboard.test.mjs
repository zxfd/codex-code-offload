import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_DOM_BYTES,
  copyDomToClipboard,
  parseArgs,
  readBoundedDomArtifact,
} from '../copy-dom-to-clipboard.mjs';

function fixture(payload, name = 'dom.json') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-web-llm-page-extract-'));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(payload));
  return { dir, path };
}

function validPayload(overrides = {}) {
  return {
    domSource: 'controlled-browser-same-origin',
    sameContext: true,
    domComplete: false,
    sourceUrl: 'https://example.test/article',
    finalUrl: 'https://example.test/article',
    domScope: 'article[data-task-section]',
    domText: '<article data-task-section>必要数据</article>',
    ...overrides,
  };
}

test('valid bounded same-origin artifact passes dry-run without clipboard I/O', () => {
  const { dir, path } = fixture(validPayload());
  try {
    const result = copyDomToClipboard(path, { dryRun: true });
    assert.equal(result.clipboardWritten, false);
    assert.equal(result.sourceUrl, 'https://example.test/article');
    assert.equal(result.domScope, 'article[data-task-section]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('standard web-ingest result without domText is rejected', () => {
  const { dir, path } = fixture({ schemaVersion: 1, source: 'https://example.test/article', modality: 'text' });
  try {
    assert.throws(() => readBoundedDomArtifact(path), /intentionally omits complete DOM/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-origin, sensitive, full-document, and oversized inputs fail closed', () => {
  const cases = [
    [validPayload({ finalUrl: 'https://other.test/article' }), /cross-origin/u],
    [validPayload({ sourceUrl: 'https://example.test/login' }), /sensitive page path/u],
    [validPayload({ domText: '<html><body>all page content</body></html>' }), /full-document/u],
    [validPayload({ domText: 'x'.repeat(MAX_DOM_BYTES) }), /exceeds/u],
  ];
  for (const [payload, pattern] of cases) {
    const { dir, path } = fixture(payload);
    try {
      assert.throws(() => readBoundedDomArtifact(path), pattern);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('argument parser requires one input and caps the configured size', () => {
  assert.throws(() => parseArgs([]), /--input is required/u);
  assert.deepEqual(parseArgs(['--input', '/tmp/example.json', '--dry-run']), {
    input: '/tmp/example.json', maxBytes: MAX_DOM_BYTES, dryRun: true, help: false,
  });
  assert.throws(() => parseArgs(['--input', '/tmp/a.json', '--input', '/tmp/b.json']), /only once/u);
  assert.throws(() => parseArgs(['--input', '/tmp/example.json', '--max-bytes', String(MAX_DOM_BYTES + 1)]), /maxBytes/u);
});

test('clipboard command failure is surfaced without a Web-LLM fallback', () => {
  const { dir, path } = fixture(validPayload());
  try {
    if (process.platform !== 'darwin') {
      assert.throws(() => copyDomToClipboard(path), /requires macOS/u);
      return;
    }
    assert.throws(() => copyDomToClipboard(path, {
      spawn: () => ({ status: 1, stderr: 'simulated pbcopy failure' }),
    }), /pbcopy failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
