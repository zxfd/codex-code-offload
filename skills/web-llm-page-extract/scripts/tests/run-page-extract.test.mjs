import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildStructuredExtractionInstruction,
  createSingleProviderConfig,
  runWebLlmPageExtract,
} from '../run-page-extract.mjs';

const requestUrl = 'https://example.test/airdrop';
const target = '当前高价值空投';
const selector = 'main > section:nth-of-type(2)';
const sha256 = 'b'.repeat(64);

function baseConfigFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-page-extract-base-config-'));
  const path = join(dir, 'providers.json');
  writeFileSync(path, JSON.stringify({
    version: 3,
    health_ttl_seconds: 300,
    routes: {
      text: { priority: ['chatgpt-only'], local_fallback: false },
      multimodal: { priority: ['chatgpt-only'], local_fallback: false },
    },
    providers: {
      'chatgpt-only': {
        adapter: 'chatgpt-web',
        url: 'https://chatgpt.com/',
        target: { model: 'GPT-5.6 Sol', reasoning_tiers: ['最高', '极高', '高', '中'] },
      },
    },
  }));
  return { dir, path };
}

test('structured instruction fixes source, target, and selector without embedding page DOM', () => {
  const instruction = buildStructuredExtractionInstruction({
    requestUrl,
    objective: '列出仍可参与且价值较高的空投',
    target,
    selector,
  });
  assert.ok(instruction.includes(requestUrl));
  assert.ok(instruction.includes(target));
  assert.ok(instruction.includes(selector));
  assert.equal(instruction.includes('<section>'), false);
  assert.ok(instruction.length < 4_000);
});

test('single-provider config narrows both routes and disables local fallback', () => {
  const base = baseConfigFixture();
  let narrowed;
  try {
    narrowed = createSingleProviderConfig({ baseConfigPath: base.path, providerId: 'chatgpt-only' });
    const configured = JSON.parse(readFileSync(narrowed.configPath, 'utf8'));
    assert.deepEqual(configured.routes.text, { priority: ['chatgpt-only'], local_fallback: false });
    assert.deepEqual(configured.routes.multimodal, { priority: ['chatgpt-only'], local_fallback: false });
    assert.deepEqual(Object.keys(configured.providers), ['chatgpt-only']);
  } finally {
    if (narrowed) rmSync(narrowed.providerDir, { recursive: true, force: true });
    rmSync(base.dir, { recursive: true, force: true });
  }
});

test('complete orchestrator returns only a bounded structured receipt and confirms every cleanup', async () => {
  const base = baseConfigFixture();
  const captured = {};
  const structured = {
    source_url: requestUrl,
    extraction_summary: '筛选出仍可参与且页面内奖励依据较明确的项目',
    data: { target, selector, items: [{ name: 'fixture' }], uncertainties: [] },
  };
  try {
    const result = await runWebLlmPageExtract({
      url: requestUrl,
      objective: '列出仍可参与且价值较高的空投',
      target,
      taskTermGroups: [['空投', 'airdrop'], ['奖励', 'reward']],
      browser: { tabs: { new: async () => ({}) } },
      browserChannel: 'chrome',
      webIngestRoot: '/unused/by-test',
      baseProviderConfigPath: base.path,
      providerId: 'chatgpt-only',
      dependencies: {
        async stageBoundedDomArtifact() {
          return {
            status: 'ready',
            domArtifactPath: '/tmp/codex-web-llm-page-extract-fixture/dom.json',
            receipt: {
              webIngestHealth: true,
              stagedCleanup: true,
              domScope: selector,
              domBytes: 512,
              domSha256: sha256,
              matchedTermGroups: 2,
              contentUnits: 6,
            },
          };
        },
        copyDomToClipboard() {
          return { clipboardWritten: true, bytes: 512, sha256 };
        },
        cleanupBoundedDomArtifact() {
          captured.domCleanup = true;
          return { domArtifactRemoved: true };
        },
        async runProviderFallback(args) {
          captured.runnerArgs = args;
          captured.config = JSON.parse(readFileSync(args.configPath, 'utf8'));
          captured.prompt = readFileSync(args.promptPath, 'utf8');
          const parsed = args.responseValidator({ answer: JSON.stringify(structured) });
          return {
            providerId: 'chatgpt-only',
            responseConfirmed: true,
            response_confirmed: true,
            response_is_new: true,
            generationComplete: true,
            generation_complete: true,
            structuredJsonAvailable: true,
            structured_json_available: true,
            clipboardPasteConfirmed: true,
            clipboard_paste_confirmed: true,
            clipboardSha256Confirmed: true,
            clipboard_sha256_confirmed: true,
            responseConfirmation: 'new_assistant_message',
            response_confirmation: 'new_assistant_message',
            responseComplete: true,
            response_complete: true,
            attempt: 1,
            structuredResult: parsed,
            conversationCleanup: { action: 'archive', confirmed: true, verification: 'sidebar_link_absent_without_reload' },
          };
        },
      },
    });
    assert.equal(captured.runnerArgs.requestMetadata.text_transport, 'system_clipboard');
    assert.equal(captured.runnerArgs.requestMetadata.require_structured_response, true);
    assert.deepEqual(captured.config.routes.text, { priority: ['chatgpt-only'], local_fallback: false });
    assert.equal(captured.prompt.includes('<section>'), false);
    assert.equal(result.model_source, 'web_provider');
    assert.equal(result.response_is_new, true);
    assert.equal(result.clipboard_paste_confirmed, true);
    assert.deepEqual(result.data.items, [{ name: 'fixture' }]);
    assert.deepEqual(result.cleanup, {
      stagedResultRemoved: true,
      domArtifactRemoved: true,
      promptRemoved: true,
      providerConfigRemoved: true,
    });
    assert.equal('answer' in result, false);
    assert.equal('domArtifactPath' in result, false);
    assert.equal(captured.domCleanup, true);
    assert.equal(existsSync(captured.runnerArgs.configPath), false);
  } finally {
    rmSync(base.dir, { recursive: true, force: true });
  }
});
