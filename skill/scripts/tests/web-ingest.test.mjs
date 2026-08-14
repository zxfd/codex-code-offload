import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  captureVisualArtifacts,
  ingestSingleUrlWithLocalContext,
} from '../web-ingest.mjs';

function makeTab({ finalUrl = 'https://example.com/page' } = {}) {
  const events = [];
  return {
    events,
    async goto(_url) {
      events.push(`goto:${_url}`);
    },
    async url() {
      return finalUrl;
    },
    async close() {
      events.push('close');
    },
  };
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'codex-web-reasoning-prompt-XXXXXX-dir'));
}

const REPO_ROOT = process.cwd();
const SKILL_PATH = join(REPO_ROOT, 'skills', 'luna-model-routing', 'SKILL.md');
const CONTRACT_PATH = join(REPO_ROOT, 'skills', 'luna-model-routing', 'references', 'communication-contract.md');
const ROUTING_PATH = join(REPO_ROOT, 'skills', 'luna-model-routing', 'references', 'routing-matrix.md');

function assertContains(filePath, substring, message) {
  const text = readFileSync(filePath, 'utf8');
  assert.ok(text.includes(substring), message || `expected "${substring}" in ${filePath}`);
  return text;
}

test('Luna routing skill contract: mandatory single-URL pre-ingest and approved single-provider transfer', async () => {
  const skill = assertContains(SKILL_PATH, 'Mandatory URL ingestion gate for new Chrome tasks', 'missing URL gate section');
  const contract = assertContains(CONTRACT_PATH, 'url_preingest', 'missing url_preingest contract transport');
  assertContains(ROUTING_PATH, 'Single explicit `http`/`https` URL that requires opening a fresh Chrome task tab', 'missing routing matrix single URL row');

  assert.ok(
    contract.toLowerCase().includes('do not continue to fallback providers'),
    'missing named-provider non-fallback guarantee',
  );
  assertContains(SKILL_PATH, 'allowExternalTransfer: false', 'missing default no-transfer');
  assertContains(SKILL_PATH, 'request explicit user approval', 'missing explicit approval boundary');
  assertContains(SKILL_PATH, 'two-step route', 'missing two-step approval flow');
  assertContains(SKILL_PATH, 'named provider', 'missing named-provider requirement');
  assertContains(SKILL_PATH, 'request a fresh named-provider approval', 'missing explicit re-approval requirement');
  assertContains(
    SKILL_PATH,
    'requires_user_approval',
    'missing pre-ingest default no-transfer state',
  );
  assertContains(
    SKILL_PATH,
    'allowExternalTransfer: true',
    'missing approval+reinvoke flow',
  );
  assertContains(SKILL_PATH, 'health check', 'missing installed-skill preflight health check requirement');
  assertContains(SKILL_PATH, 'fail-closed', 'missing fail-closed health-check requirement');
  assertContains(
    CONTRACT_PATH,
    'health check',
    'missing communication-contract health-check precondition',
  );
  assert.ok(
    /bounded receipt/i.test(skill),
    'missing bounded receipt language in skill contract',
  );
  assert.ok(
    /bound.*receipt/i.test(contract),
    'missing bounded receipt contract wording',
  );
});

test('Spark routing docs default to xhigh as the highest supported thinking level', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  const routing = readFileSync(ROUTING_PATH, 'utf8');

  assert.ok(skill.includes('`xhigh`'), 'missing Spark xhigh invocation in skill');
  assert.ok(
    routing.includes('Spark `xhigh`'),
    'routing matrix must mark Spark coding default as `xhigh`',
  );
  assert.ok(
    routing.includes('maximum supported Spark thinking level'),
    'routing matrix must document xhigh as Spark maximum supported level',
  );

  assert.ok(!/Spark\s+`medium`/.test(skill), 'no Spark medium default should remain');
  assert.ok(!/Spark\s+`medium`/.test(routing), 'no Spark medium default should remain');
  assert.ok(!/Prefer `medium`/.test(skill), 'no Spark medium preference should remain');
  assert.ok(!/use `high` only when the result has objective local checks/.test(skill), 'no Spark high preference should remain');
  assert.ok(!/Spark: `medium` default/.test(routing), 'no Spark medium default should remain');
  assert.ok(!/`high` only/.test(routing), 'no Spark high-only escalation should remain');
});

function makeSignals({
  visibleText = 'simple visible extraction',
  imageCount = 1,
  canvasCount = 0,
  tableCount = 0,
  imageAlts = ['hero'],
} = {}) {
  return {
    visibleText,
    imageCount,
    canvasCount,
    tableCount,
    imageAlts,
    loadState: 'complete',
    pageTitle: 'test',
    location: { href: 'https://example.com/page', origin: 'https://example.com' },
  };
}

function assertArtifactsRemoved({ workspace, expectRemoved }) {
  const promptPath = join(workspace, 'prompt.txt');
  assert.equal(existsSync(promptPath), !expectRemoved);
  assert.equal(existsSync(workspace), !expectRemoved);
}

test('ingestion rejects wildcard and multi-URL inputs', async () => {
  const tab = makeTab();
  await assert.rejects(
    ingestSingleUrlWithLocalContext({
      url: 'https://example.com/a,https://example.com/b',
      objective: 'read summary',
      browser: { tabs: { new: async () => tab } },
      openBrowserTab: async () => tab,
    }),
    /URL must be a single explicit URL/,
  );
  await assert.rejects(
    ingestSingleUrlWithLocalContext({
      url: 'https://example.com/*',
      objective: 'read summary',
      browser: { tabs: { new: async () => tab } },
      openBrowserTab: async () => tab,
    }),
    /URL must be a single explicit URL/,
  );
});

test('ingestion uses bounded prompt/image artifacts and blocks raw browser evidence from provider output', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  const providerArgs = [];
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/page',
    objective: 'summarize the visible information',
    processingPolicy: { allowExternalTransfer: true },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({
      visibleText: 'x'.repeat(9000),
      imageCount: 3,
      canvasCount: 0,
      imageAlts: ['hero', 'diagram'],
    }),
    runProvider: async (args) => {
      providerArgs.push(args);
      assert.equal(args.promptPath, join(workspace, 'prompt.txt'));
      assert.equal(args.imagePaths.length, 0);
      assert.equal(args.requestMetadata.packed_files, 1);
      assert.equal(args.requestMetadata.estimated_external_tokens > 0, true);
      assert.equal('promptPath' in args.requestMetadata, false);
      assert.equal('rawText' in args, false);
      return {
        provider: 'MockProvider',
        model: 'MockText',
        answer: `analysis:${'y'.repeat(40)}`,
      };
    },
  });
  assert.equal(response.status, 'completed');
  assert.equal(providerArgs.length, 1);
  assert.equal(response.result.answerPreview.includes('analysis'), true);
  assert.equal(response.pageSignals.visibleTextChars, 6000);
  for (const key of ['pageBody', 'dom', 'body', 'html', 'ocr', 'cookies', 'storage', 'uiDiagnostics', 'queryTokens']) {
    assert.equal(key in response, false);
    assert.equal(key in response.result, false);
  }
  assertArtifactsRemoved({ workspace, expectRemoved: true });
});

test('ingestion blocks cross-domain redirects and never calls provider', async () => {
  const tab = makeTab({ finalUrl: 'https://other.example/landing' });
  const runCalls = [];
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/page',
    objective: 'read summary',
    processingPolicy: { allowExternalTransfer: true },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    extractSignals: async () => makeSignals(),
    runProvider: async () => {
      runCalls.push('called');
      return {};
    },
  });
  assert.equal(response.status, 'failed');
  assert.equal(runCalls.length, 0);
});

test('ingestion text path is privacy-bounded and does not return raw extracted text', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  const longText = `SECRET_${'x'.repeat(8000)}_tail`;
  const runProviderArgs = [];
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/page',
    objective: 'summarize product risks',
    processingPolicy: { allowExternalTransfer: true },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({ visibleText: longText }),
    runProvider: async ({ requestMetadata }) => {
      runProviderArgs.push(requestMetadata.modality);
      return {
        provider: 'MockProvider',
        model: 'MockText',
        answer: `summary:${'x'.repeat(40)}`,
      };
    },
  });
  assert.equal(response.status, 'completed');
  assert.equal(response.modality, 'text');
  assert.equal(runProviderArgs.at(-1), 'text');
  assert.equal(response.pageSignals.visibleTextChars, 6000);
  assert.equal(response.result.answerPreview.includes(longText), false);
  assert.equal(response.result.answerPreview.includes('SECRET_'), false);
  assert.equal(response.result.answerPreview.includes('x'.repeat(20)), true);
  assert.equal(response.cleanup.captureArtifactsRemoved, true);
  assertArtifactsRemoved({ workspace, expectRemoved: true });
});

test('ingestion visual route sends only image paths and requires attachmentsReady', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  const createdPaths = [];
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/chart',
    objective: '请生成截图内容结论',
    processingPolicy: { allowExternalTransfer: true, allowText: false, allowVisual: true, maxImages: 2 },
    browser: { tabs: { new: async () => tab }, tabsCount: 0 },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({ visibleText: 'title', imageCount: 1, canvasCount: 2 }),
    captureVisual: async ({ artifactDir, maxImages }) => {
      const count = maxImages;
      const paths = [];
      for (let i = 0; i < count; i += 1) {
        const path = join(artifactDir, `visual-${String(i + 1).padStart(2, '0')}.png`);
        writeFileSync(path, `pixel-${i}`);
        createdPaths.push(path);
        paths.push(path);
      }
      return paths;
    },
    runProvider: async (args) => {
      assert.equal(args.imagePaths.length, 2);
      for (const imagePath of args.imagePaths) {
        const content = readFileSync(imagePath, 'utf8');
        assert.equal(content.startsWith('pixel-'), true);
      }
      return {
        provider: 'MockProvider',
        model: 'MockVision',
        attachmentsReady: true,
        answer: 'visual conclusion',
      };
    },
  });
  assert.equal(response.status, 'completed');
  assert.equal(response.modality, 'multimodal');
  assert.equal(response.externalTransfer.attachmentsReady, true);
  assert.equal(response.externalTransfer.provider, 'MockProvider');
  assert.equal(createdPaths.length > 0, true);
  assertArtifactsRemoved({ workspace, expectRemoved: true });
});

test('ingestion blocks high-risk extraction before provider', async () => {
  const tab = makeTab();
  const runCalls = [];
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/admin',
    objective: 'read login page',
    processingPolicy: { allowExternalTransfer: true },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    extractSignals: async () => makeSignals({ visibleText: 'Bearer token: abc123' }),
    runProvider: async () => {
      runCalls.push('called');
      return {};
    },
  });
  assert.equal(response.status, 'blocked');
  assert.equal(response.result.reason, 'sensitive content detected during local extraction');
  assert.equal(runCalls.length, 0);
});

test('ingestion preserves artifacts for NEED_MORE_CONTEXT continuations', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/page',
    objective: 'read summary',
    processingPolicy: { allowExternalTransfer: true },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({ visibleText: 'long but bounded text' }),
    runProvider: async () => ({
      provider: 'MockProvider',
      model: 'MockText',
      answer: 'NEED_MORE_CONTEXT: please provide one more bounded segment',
    }),
  });
  assert.equal(response.status, 'requires_user_approval');
  assert.equal(response.result.fullNeedsMoreContext, true);
  assert.equal(response.cleanup.captureArtifactsRemoved, false);
  assert.equal(existsSync(join(workspace, 'prompt.txt')), true);
  assert.equal(existsSync(workspace), true);
});

test('ingestion cleans artifacts after provider failure', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/page',
    objective: 'read summary',
    processingPolicy: { allowExternalTransfer: true },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({ visibleText: 'some extraction body' }),
    runProvider: async () => {
      throw new Error('provider runtime failed');
    },
  });
  assert.equal(response.status, 'failed');
  assert.equal(response.result.error.includes('provider runtime failed'), true);
  assertArtifactsRemoved({ workspace, expectRemoved: true });
});

test('ingestion with blocked multimodal transfer never retries and requires explicit user continuation', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  let runCalls = 0;
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/chart',
    objective: '我需要页面截图和图表OCR',
    processingPolicy: { allowExternalTransfer: true, allowText: false, allowVisual: true, maxImages: 2 },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({ visibleText: 'chart summary', canvasCount: 1, imageCount: 2, tableCount: 0 }),
    captureVisual: async ({ artifactDir }) => [join(artifactDir, 'visual-01.png')],
    runProvider: async () => {
      runCalls += 1;
      return {
        provider: 'MockProvider',
        model: 'MockVision',
        attachmentsReady: false,
        answer: 'visual failed',
      };
    },
  });
  assert.equal(response.status, 'failed');
  assert.equal(runCalls, 1);
  assert.equal(response.result.reason, 'provider did not confirm image attachments');
  assert.equal(response.externalTransfer.provider, 'MockProvider');
  assert.equal(response.externalTransfer.model, 'MockVision');
  assert.equal(response.externalTransfer.attachmentsReady, false);
  assertArtifactsRemoved({ workspace, expectRemoved: true });
});

test('ingestion defaults to local-first text route with no external transfer', async () => {
  const tab = makeTab();
  let runProviderCalls = 0;
  const response = await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/page',
    objective: 'read summary',
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    extractSignals: async () => makeSignals({ visibleText: 'short text', canvasCount: 0 }),
    runProvider: async () => {
      runProviderCalls += 1;
      return {
        provider: 'MockProvider',
        model: 'MockText',
        answer: 'ok',
      };
    },
  });
  assert.equal(response.status, 'requires_user_approval');
  assert.equal(runProviderCalls, 0);
  assert.equal(response.externalTransfer, null);
});

test('ingestion respects maxImages cap and modality wiring for multimodal', async () => {
  const tab = makeTab();
  const workspace = makeWorkspace();
  const captureCounts = [];
  await ingestSingleUrlWithLocalContext({
    url: 'https://example.com/chart',
    objective: '我需要截图和图表OCR',
    processingPolicy: { allowExternalTransfer: true, maxImages: 10 },
    browser: { tabs: { new: async () => tab } },
    openBrowserTab: async () => tab,
    createWorkspace: () => workspace,
    extractSignals: async () => makeSignals({ visibleText: 'some text', canvasCount: 1 }),
    captureVisual: async ({ maxImages }) => {
      captureCounts.push(maxImages);
      return [];
    },
    runProvider: async (args) => {
      assert.equal(args.requestMetadata.modality, 'multimodal');
      return {
        provider: 'MockProvider',
        model: 'MockVision',
        attachmentsReady: true,
        answer: 'visual reasoned result',
      };
    },
  });
  assert.equal(captureCounts.at(-1), 4);
});

test('default visual capture writes only clipped image bytes to the workspace', async () => {
  const workspace = makeWorkspace();
  const clips = [];
  try {
    const paths = await captureVisualArtifacts({
      artifactDir: workspace,
      maxImages: 4,
      regions: [{ x: 1, y: 2, width: 30, height: 40 }],
      tab: {
        screenshot: async ({ clip }) => {
          clips.push(clip);
          return new Uint8Array([137, 80, 78, 71]);
        },
      },
    });
    assert.deepEqual(clips, [{ x: 1, y: 2, width: 30, height: 40 }]);
    assert.equal(readFileSync(paths[0])[0], 137);
    assert.equal(paths.length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
