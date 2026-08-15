import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseStructuredAssistantResponse } from '../../../skills/web-llm-page-extract/scripts/structured-response.mjs';
import { runProviderFallback } from '../web-provider-runner.mjs';
import { confirmedAssistantResponseMetadata } from '../provider-response.mjs';

const requestUrl = 'https://example.test/article';

function validAnswer() {
  return JSON.stringify({
    source_url: requestUrl,
    extraction_summary: 'bounded structured result',
    data: { target: '稳定度', selector: '.stability' },
  });
}

function makePromptDir() {
  const promptDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-prompt-'));
  const promptPath = join(promptDir, 'prompt.txt');
  writeFileSync(promptPath, 'extract the bounded result', 'utf8');
  return { promptDir, promptPath };
}

function makeProviderConfig() {
  const providersDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-providers-'));
  const providersPath = join(providersDir, 'providers.json');
  writeFileSync(providersPath, JSON.stringify({
    version: 3,
    routes: {
      text: { priority: ['qwen-format-retry'] },
      multimodal: { priority: ['qwen-format-retry'] },
    },
    providers: {
      'qwen-format-retry': {
        adapter: 'qwen-web',
        url: 'https://chat.qwen.ai/',
        target: { models: ['Qwen3.8-Max', 'Qwen3.7-Max'] },
      },
    },
  }));
  return { providersDir, providersPath };
}

function makeTab(events) {
  return {
    events,
    async close() { events.push('close'); },
    async url() { return 'https://chat.qwen.ai/c/format-retry'; },
    async goto() {},
    playwright: {},
  };
}

async function runScenario({ answers, resultOverrides = {}, expectArchive = true, formatRetry = true }) {
  const prompt = makePromptDir();
  const providers = makeProviderConfig();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const events = [];
  const calls = [];
  const tab = makeTab(events);
  let answerIndex = 0;
  const adapter = {
    async run(args) {
      calls.push({ providerId: args.providerId, tab: args.tab, continuation: args.continuation, promptPath: args.promptPath });
      return {
        provider: 'Qwen',
        model: 'Qwen3.8-Max',
        ...confirmedAssistantResponseMetadata(),
        ...resultOverrides,
        answer: answers[Math.min(answerIndex++, answers.length - 1)],
      };
    },
    async archiveConversation() {
      events.push('archive');
      return { action: 'archive', confirmed: true, verification: 'sidebar_link_absent_without_reload' };
    },
  };
  const validator = ({ answer }) => parseStructuredAssistantResponse(answer, { requestUrl });
  let outcome;
  try {
    outcome = await runProviderFallback({
      browser: { tabs: { new: async () => tab } },
      browserChannel: 'chrome',
      promptPath: prompt.promptPath,
      role: 'assistant',
      configPath: providers.providersPath,
      stateDir,
      adapterLoader: async () => adapter,
      requestMetadata: {
        request_id: 'format-retry-test',
        require_structured_response: true,
        structured_response_format_retry: formatRetry,
      },
      responseValidator: validator,
    });
    if (!expectArchive) throw new Error('scenario unexpectedly succeeded');
  } catch (error) {
    outcome = error;
    if (expectArchive) throw error;
  } finally {
    rmSync(prompt.promptDir, { recursive: true, force: true });
    rmSync(providers.providersDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
  return { outcome, calls, events };
}

test('one malformed wrapper gets one same-provider continuation retry', async () => {
  const { outcome, calls, events } = await runScenario({ answers: ['not json', validAnswer()] });
  assert.equal(outcome.providerId, 'qwen-format-retry');
  assert.equal(outcome.attempt, 2);
  assert.equal(outcome.responseAttempt, 2);
  assert.equal(outcome.responseConfirmation, 'new_assistant_message');
  assert.equal(outcome.response_complete, true);
  assert.deepEqual(calls.map(call => ({ providerId: call.providerId, sameTab: call.tab === calls[0].tab, continuation: call.continuation })), [
    { providerId: 'qwen-format-retry', sameTab: true, continuation: false },
    { providerId: 'qwen-format-retry', sameTab: true, continuation: true },
  ]);
  assert.deepEqual(events, ['archive', 'close']);
});

test('a second malformed response fails without success state or cleanup', async () => {
  const prompt = makePromptDir();
  const providers = makeProviderConfig();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const events = [];
  const calls = [];
  const tab = makeTab(events);
  const adapter = {
    async run(args) {
      calls.push(args);
      return { provider: 'Qwen', ...confirmedAssistantResponseMetadata(), answer: 'not json' };
    },
    async archiveConversation() { events.push('archive'); return { action: 'archive', confirmed: true }; },
  };
  try {
    await assert.rejects(
      runProviderFallback({
        browser: { tabs: { new: async () => tab } },
        browserChannel: 'chrome',
        promptPath: prompt.promptPath,
        role: 'assistant',
        configPath: providers.providersPath,
        stateDir,
        adapterLoader: async () => adapter,
        requestMetadata: { request_id: 'format-retry-fail-test', require_structured_response: true },
        responseValidator: ({ answer }) => parseStructuredAssistantResponse(answer, { requestUrl }),
      }),
      /all configured Web Reasoning providers are unavailable/u,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].tab, calls[1].tab);
    assert.equal(calls[1].continuation, true);
    assert.deepEqual(events, ['close']);
    const health = JSON.parse(readFileSync(join(stateDir, 'provider-health.json'), 'utf8'));
    assert.equal(health.providers['qwen-format-retry'], undefined);
    const logLines = readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim().split('\n');
    const finalEvent = JSON.parse(logLines.at(-1));
    assert.equal(finalEvent.success, false);
    assert.equal(finalEvent.provider, null);
    assert.equal(finalEvent.provider_attempts.filter(item => item.status === 'structured_response_format_retry').length, 1);
  } finally {
    rmSync(prompt.promptDir, { recursive: true, force: true });
    rmSync(providers.providersDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('blocked response does not trigger format retry', async () => {
  const result = await runScenario({
    answers: [JSON.stringify({ status: 'blocked', reason: 'insufficient context' })],
    expectArchive: false,
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.events.includes('archive'), false);
});

test('old assistant response is rejected without format retry', async () => {
  const result = await runScenario({ answers: [validAnswer()], resultOverrides: { response_is_new: false }, expectArchive: false });
  assert.equal(result.calls.length, 1);
  assert.equal(result.events.includes('archive'), false);
});

test('valid code fence is accepted without format retry', async () => {
  const fence = String.fromCharCode(96).repeat(3);
  const result = await runScenario({ answers: [`说明\n\n${fence}json\n${validAnswer()}\n${fence}`] });
  assert.equal(result.outcome.attempt, 1);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.events, ['archive', 'close']);
});

test('format retry can be disabled but never expanded beyond one attempt', async () => {
  const result = await runScenario({ answers: ['not json', validAnswer()], expectArchive: false, formatRetry: false });
  assert.equal(result.calls.length, 1);
  assert.equal(result.events.includes('archive'), false);
});
