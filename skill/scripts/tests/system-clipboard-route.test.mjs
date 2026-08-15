import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseStructuredAssistantResponse } from '../../../skills/web-llm-page-extract/scripts/structured-response.mjs';
import { confirmedAssistantResponseMetadata } from '../provider-response.mjs';
import {
  resolveProviderRoute,
  runProviderFallback,
  validateSystemClipboardRoute,
} from '../web-provider-runner.mjs';

const requestUrl = 'https://example.test/airdrop';
const target = '当前高价值空投';
const selector = 'main > section';
const clipboardText = '<section>bounded DOM</section>';
const clipboardSha256 = 'a'.repeat(64);

function config(priority = ['chatgpt-only'], localFallback = false) {
  return {
    version: 3,
    health_ttl_seconds: 300,
    routes: {
      text: { priority, local_fallback: localFallback },
      multimodal: { priority: ['chatgpt-only'], local_fallback: false },
    },
    providers: {
      'chatgpt-only': {
        adapter: 'chatgpt-web',
        url: 'https://chatgpt.com/',
        target: { model: 'GPT-5.6 Sol', reasoning_tiers: ['最高', '极高', '高', '中'] },
      },
      second: {
        adapter: 'chatgpt-web',
        url: 'https://chatgpt.com/',
        target: { model: 'GPT-5.6 Sol', reasoning_tiers: ['最高'] },
      },
    },
  };
}

function metadata() {
  return {
    request_id: 'clipboard-route-test',
    modality: 'text',
    require_structured_response: true,
    structured_response_format_retry: true,
    text_transport: 'system_clipboard',
    clipboard_text_bytes: Buffer.byteLength(clipboardText),
    clipboard_text_sha256: clipboardSha256,
    clipboard_source_url: requestUrl,
  };
}

function makePrompt() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-prompt-'));
  const path = join(dir, 'prompt.txt');
  writeFileSync(path, 'Return the scoped structured result only.');
  return { dir, path };
}

function makeConfig(value) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-providers-'));
  const path = join(dir, 'providers.json');
  writeFileSync(path, JSON.stringify(value));
  return { dir, path };
}

test('system clipboard route requires one ChatGPT Provider, no local fallback, and a bounded receipt', () => {
  const configured = config();
  const route = resolveProviderRoute(configured, metadata());
  assert.deepEqual(validateSystemClipboardRoute({ config: configured, route, requestMetadata: metadata(), promptText: 'short' }), {
    providerId: 'chatgpt-only', sourceUrl: requestUrl,
  });
  assert.throws(
    () => validateSystemClipboardRoute({
      config: config(['chatgpt-only', 'second']),
      route: { modality: 'text', priority: ['chatgpt-only', 'second'], localFallback: false },
      requestMetadata: metadata(),
      promptText: 'short',
    }),
    /exactly one Provider/u,
  );
  assert.throws(
    () => validateSystemClipboardRoute({
      config: configured,
      route: { modality: 'text', priority: ['chatgpt-only'], localFallback: true },
      requestMetadata: metadata(),
      promptText: 'short',
    }),
    /local_fallback false/u,
  );
});

test('runner records a verified clipboard paste, validates JSON, archives, and closes the tab', async () => {
  const prompt = makePrompt();
  const providerConfig = makeConfig(config());
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const events = [];
  const calls = [];
  const tab = { async close() { events.push('close'); } };
  const answer = JSON.stringify({
    source_url: requestUrl,
    extraction_summary: 'bounded result',
    data: { target, selector, items: [] },
  });
  const adapter = {
    async run(args) {
      calls.push(args);
      return {
        provider: 'ChatGPT',
        answer,
        ...confirmedAssistantResponseMetadata(),
        clipboardPasteConfirmed: true,
        clipboard_paste_confirmed: true,
        clipboardSha256Confirmed: true,
        clipboard_sha256_confirmed: true,
      };
    },
    async archiveConversation() {
      events.push('archive');
      return { action: 'archive', confirmed: true, verification: 'sidebar_link_absent_without_reload' };
    },
  };
  try {
    const result = await runProviderFallback({
      browser: { tabs: { new: async () => tab } },
      browserChannel: 'chrome',
      promptPath: prompt.path,
      role: 'document_analysis',
      requestMetadata: metadata(),
      configPath: providerConfig.path,
      stateDir,
      adapterLoader: async () => adapter,
      responseValidator: ({ answer: raw }) => parseStructuredAssistantResponse(raw, {
        requestUrl,
        expectedTarget: target,
        expectedSelector: selector,
      }),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestMetadata.text_transport, 'system_clipboard');
    assert.equal(result.clipboardPasteConfirmed, true);
    assert.equal(result.structuredResult.data.selector, selector);
    assert.deepEqual(events, ['archive', 'close']);
    const event = JSON.parse(readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim());
    assert.equal(event.text_transport, 'system_clipboard');
    assert.equal(event.clipboard_paste_confirmed, true);
    assert.equal(event.clipboard_sha256_confirmed, true);
    assert.equal(event.conversation_cleanup_confirmed, true);
  } finally {
    rmSync(prompt.dir, { recursive: true, force: true });
    rmSync(providerConfig.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runner fails closed and does not archive when clipboard paste confirmation is absent', async () => {
  const prompt = makePrompt();
  const providerConfig = makeConfig(config());
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const events = [];
  const tab = { async close() { events.push('close'); } };
  try {
    await assert.rejects(
      runProviderFallback({
        browser: { tabs: { new: async () => tab } },
        browserChannel: 'chrome',
        promptPath: prompt.path,
        role: 'document_analysis',
        requestMetadata: metadata(),
        configPath: providerConfig.path,
        stateDir,
        adapterLoader: async () => ({
          async run() {
            return {
              provider: 'ChatGPT',
              answer: JSON.stringify({ source_url: requestUrl, extraction_summary: 'x', data: { target, selector } }),
              ...confirmedAssistantResponseMetadata(),
            };
          },
          async archiveConversation() { events.push('archive'); return { confirmed: true }; },
        }),
        responseValidator: ({ answer }) => parseStructuredAssistantResponse(answer, { requestUrl }),
      }),
      /all configured Web Reasoning providers are unavailable/u,
    );
    assert.deepEqual(events, ['close']);
  } finally {
    rmSync(prompt.dir, { recursive: true, force: true });
    rmSync(providerConfig.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
