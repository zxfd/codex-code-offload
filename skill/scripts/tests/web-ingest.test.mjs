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
const OPENAI_YAML_PATH = join(REPO_ROOT, 'skills', 'luna-model-routing', 'agents', 'openai.yaml');

function assertContains(filePath, substring, message) {
  const text = readFileSync(filePath, 'utf8');
  assert.ok(text.includes(substring), message || `expected "${substring}" in ${filePath}`);
  return text;
}

test('routing skill contract: mandatory single-URL pre-ingest and approved single-provider transfer', () => {
  const skill = assertContains(SKILL_PATH, '新 Chrome 任务的 URL 摄取门', 'missing URL gate section');
  const contract = assertContains(CONTRACT_PATH, 'url_preingest', 'missing url_preingest contract transport');
  assertContains(ROUTING_PATH, '对明确批准的单个 `http` 或 `https` URL', 'missing routing matrix single URL rule');

  assert.ok(contract.includes('不得沿用旧审批调用其他 Provider'), 'missing named-provider non-fallback guarantee');
  assertContains(SKILL_PATH, 'allowExternalTransfer: false', 'missing default no-transfer');
  assertContains(SKILL_PATH, '请求用户明确批准', 'missing explicit approval boundary');
  assertContains(SKILL_PATH, '这是一个两步路由', 'missing two-step approval flow');
  assertContains(SKILL_PATH, '具名 Provider', 'missing named-provider requirement');
  assertContains(SKILL_PATH, '请求新的具名 Provider 审批', 'missing explicit re-approval requirement');
  assertContains(SKILL_PATH, 'requires_user_approval', 'missing pre-ingest approval state');
  assertContains(SKILL_PATH, 'allowExternalTransfer: true', 'missing approved transfer flow');
  assertContains(SKILL_PATH, '健康检查', 'missing installed-skill health check requirement');
  assertContains(SKILL_PATH, 'fail-closed', 'missing fail-closed health-check requirement');
  assertContains(SKILL_PATH, '协调 Agent 不运行健康检查、不打开 Chrome、不调用摄取函数和 Provider', 'coordinator must delegate URL gate');
  assert.ok(/有界.*回执/.test(skill), 'missing bounded receipt language in skill contract');
  assert.ok(/有界.*回执/.test(contract), 'missing bounded receipt wording');
});

test('routing docs enforce one-to-one Thread binding and the fixed lifecycle', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  const contract = readFileSync(CONTRACT_PATH, 'utf8');
  const routing = readFileSync(ROUTING_PATH, 'utf8');
  const docs = [skill, contract, routing];

  assert.ok(skill.includes('把“当前会话窗口”“主 Agent”“协调 Agent”视为同一角色'), 'missing coordinator role identity');
  assert.ok(skill.includes('`Worker` 只是逻辑职责'), 'Worker must be a logical responsibility');
  assert.ok(skill.includes('一对一绑定一个由 `codex_app__create_thread` 创建的后台 `Codex App Thread`'), 'missing one-to-one Thread binding');
  assert.ok(skill.includes('所有内部 `work_class` 的 `transport` 统一为 `codex_thread`'), 'missing unified transport rule');
  assert.ok(skill.includes('回执记录 `model_source=web_provider`'), 'Web-LLM must be hosted by a Codex Thread');

  const lifecycle = [
    '`codex_app__list_projects`',
    '`codex_app__create_thread(model, thinking, project, task packet)`',
    '确认真实 `threadId` 和 `hostId`',
    '`codex_app__wait_threads`',
    '`codex_app__read_thread`',
    '`codex_app__send_message_to_thread`',
    '主 Agent 验收',
    '`codex_app__set_thread_archived`',
  ];
  let previousIndex = -1;
  for (const item of lifecycle) {
    const currentIndex = skill.indexOf(item);
    assert.ok(currentIndex > previousIndex, `lifecycle step is missing or out of order: ${item}`);
    previousIndex = currentIndex;
  }

  assert.ok(skill.includes('只有 `codex_app__create_thread` 返回且可被后续 Thread 工具解析的真实 `threadId` 与 `hostId` 才算创建成功'), 'real identifiers must be required');
  assert.ok(skill.includes('`clientThreadId` 都只能表示准备中'), 'clientThreadId must remain preparation state');
  assert.ok(skill.includes('不能传给要求 `threadId` 的工具'), 'clientThreadId must not be passed to threadId tools');
  assert.ok(skill.includes('协调 Agent 不接管'), 'coordinator must not take over unresolved routes');
  assert.ok(contract.includes('`clientThreadId` 只能表示准备中'), 'contract must reject client-only success');
  assert.ok(routing.includes('确认真实 `threadId` 与 `hostId`'), 'matrix must require real Thread identifiers');
});

test('routing docs reject non-Thread workers and preserve typed responsibilities', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  const contract = readFileSync(CONTRACT_PATH, 'utf8');
  const routing = readFileSync(ROUTING_PATH, 'utf8');
  const docs = [skill, contract, routing];

  for (const forbidden of ['`subagent`', '`spawn_agent`', '等价 `Worker`', '本地直做', '协调窗口执行', '非 Thread 兜底']) {
    assert.ok(docs.every(doc => doc.includes(forbidden)), `missing explicit rejection: ${forbidden}`);
  }
  for (const staleTransport of [
    'local_exec',
    'current_write',
    'analysis_thread',
    'repository_write_thread',
    'execution_thread',
    'skill_validation_thread',
    'browser_operation_thread',
    'web_llm_thread',
    'verification_thread',
    'domain_action_thread',
  ]) {
    assert.ok(docs.every(doc => !doc.includes(staleTransport)), `obsolete transport remains: ${staleTransport}`);
  }

  for (const field of [
    'work_class',
    'owner',
    'transport',
    'scope',
    'inputs_by_reference',
    'owned_paths',
    'approval_source',
    'one_required_output',
    'acceptance_criteria',
    'coordinator_forbidden',
    'constraints',
  ]) {
    assert.ok(contract.includes(`${field}:`), `missing mandatory packet field: ${field}`);
  }

  for (const workClass of [
    'routing_consultation',
    'repository_read_analysis',
    'repository_write',
    'command_execution',
    'git_operation',
    'skill_lifecycle_validation',
    'browser_local_operation',
    'web_llm_reasoning',
    'verification',
    'domain_external_action',
  ]) {
    assert.ok(contract.includes(`| \`${workClass}\` |`), `missing work-class mapping: ${workClass}`);
  }

  const workClassRows = contract
    .split('\n')
    .filter(line => /^\| `(routing_consultation|repository_read_analysis|repository_write|command_execution|git_operation|skill_lifecycle_validation|browser_local_operation|web_llm_reasoning|verification|domain_external_action)` \|/.test(line));
  assert.ok(workClassRows.length >= 10, 'expected the complete typed work-class table');
  assert.ok(workClassRows.every(line => line.includes('| `codex_thread` |')), 'every work class must use codex_thread');
  assert.ok(skill.includes('如果无法确定 `work_class`、`owner`、`transport` 或拆分方式，主 Agent 仍必须创建 `routing_consultation` Codex App Thread'), 'unknown routes must still create a Thread');
  assert.ok(contract.includes('Web-LLM Provider 只返回 `work_class`、`owner`、`transport`、拆分顺序和验收字段建议'), 'consultation must be advisory only');
});

test('routing docs keep current-model wording and provider-source separation', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  const contract = readFileSync(CONTRACT_PATH, 'utf8');
  const routing = readFileSync(ROUTING_PATH, 'utf8');
  const docs = [skill, contract, routing];

  assert.ok(docs.every(doc => doc.includes('当前模型')), 'missing current-model wording');
  assert.match(skill, /不要把[^。]*当成当前模型身份/u, 'routing must keep model identity independent from route or owner names');
  assert.ok(skill.includes('后台 Thread 的 `model` 和 `thinking` 由用户明确要求、路由策略或当前配置决定'), 'backend model and thinking must remain configurable');
  assert.ok(contract.includes('`web_provider` 只允许出现在 `model_source`'), 'provider source must not become transport');
  assert.ok(docs.every(doc => !doc.includes('gpt-5.6-luna')), 'obsolete fixed Luna model must not return');
  assert.ok(skill.includes('`deepseek-v4-pro-deepseek`'), 'V4 fallback model must be explicit');
  assert.ok(skill.includes('该次回退失败后返回 `blocked`，不得重新进入 Provider 链，也不得由协调 Agent 接管'), 'fallback must fail closed');
  for (const staleHeading of ['# Model Routing', '## Lifecycle', '## Approval boundary', 'Route before reading task evidence']) {
    assert.ok(docs.every(doc => !doc.includes(staleHeading)), `obsolete English prose remains: ${staleHeading}`);
  }
});

test('openai metadata matches the Thread-only skill contract', () => {
  const metadata = readFileSync(OPENAI_YAML_PATH, 'utf8');
  const shortDescription = metadata.match(/short_description: "([^"]+)"/u)?.[1];

  assert.ok(metadata.includes('display_name: "Thread-only 模型路由"'), 'metadata display name is stale');
  assert.ok(shortDescription, 'metadata short description is missing');
  assert.ok([...shortDescription].length >= 25 && [...shortDescription].length <= 64, 'metadata short description length is invalid');
  assert.ok(metadata.includes('default_prompt: "使用 $luna-model-routing'), 'metadata default prompt must invoke the skill');
  assert.ok(metadata.includes('独立 Codex App Thread'), 'metadata must describe the Thread-only carrier');
  assert.ok(!metadata.includes('gpt-5.6-luna'), 'metadata must not fix a Luna model');
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
