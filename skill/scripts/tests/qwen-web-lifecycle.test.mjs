import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProviderFallback } from '../web-provider-runner.mjs';
import { confirmedAssistantResponseMetadata } from '../provider-response.mjs';

function makeMockProviderAdapter({ shouldFailArchive = false, events = [] } = {}) {
  const module = {
    async run() {
      events.push('run');
      return {
        provider: 'Qwen',
        model: 'Qwen3.8-Max',
        ...confirmedAssistantResponseMetadata(),
        answer: 'Qwen answer',
      };
    },
    async archiveConversation() {
      events.push('archive');
      if (shouldFailArchive) throw new Error('mock archive failed');
      return {
        action: 'archive',
        confirmed: true,
        verification: 'sidebar_link_absent_without_reload',
      };
    },
  };
  return { events, module };
}

function makeLifecycleTab(events) {
  return {
    events,
    async close() {
      events.push('close');
    },
    async goto() {},
    async url() { return 'https://chat.qwen.ai/c/adapter-test'; },
    async reload() {},
    playwright: {},
  };
}

function makePromptDir(text = 'archive-only test') {
  const promptDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-prompt-'));
  const promptPath = join(promptDir, 'prompt.txt');
  writeFileSync(promptPath, text, 'utf8');
  return { promptDir, promptPath };
}

function makeProviderConfig() {
  const state = {
    version: 3,
    routes: {
      text: {
        priority: ['qwen-terminal-lifecycle'],
      },
      multimodal: {
        priority: ['qwen-terminal-lifecycle'],
      },
    },
    providers: {
      'qwen-terminal-lifecycle': {
        adapter: 'qwen-web',
        url: 'https://chat.qwen.ai/',
        target: {
          models: ['Qwen3.8-Max', 'Qwen3.7-Max'],
        },
      },
    },
  };
  const providersDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-providers-'));
  const providersPath = join(providersDir, 'providers.json');
  writeFileSync(providersPath, JSON.stringify(state));
  return { providersDir, providersPath };
}

test('Qwen terminal lifecycle closes tab only after archive succeeds', async () => {
  const mockEvents = [];
  const { module: adapter } = makeMockProviderAdapter({ events: mockEvents });
  const { promptDir, promptPath } = makePromptDir();
  const { providersDir, providersPath } = makeProviderConfig();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const tab = makeLifecycleTab(mockEvents);

  const result = await runProviderFallback({
    browser: { tabs: { new: async () => tab } },
    browserChannel: 'chrome',
    promptPath,
    role: 'assistant',
    configPath: providersPath,
    stateDir,
    adapterLoader: async () => adapter,
    responseValidator: () => ({
      source_url: 'https://example.test/article',
      extraction_summary: 'bounded structured result',
      data: { target: '稳定度', selector: '.stability' },
    }),
  });

  assert.equal(result.provider, 'Qwen');
  assert.equal(result.conversationCleanup.action, 'archive');
  assert.equal(result.structuredJsonAvailable, true);
  assert.deepEqual(mockEvents, ['run', 'archive', 'close']);
  const successLog = JSON.parse(readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim());
  assert.equal(successLog.success, true);
  assert.equal(successLog.response_confirmed, true);
  assert.equal(successLog.response_is_new, true);
  assert.equal(successLog.structured_json_available, true);

  rmSync(promptDir, { recursive: true, force: true });
  rmSync(providersDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test('structured validation failure does not write provider success state', async () => {
  const mockEvents = [];
  const { module: adapter } = makeMockProviderAdapter({ events: mockEvents });
  const { promptDir, promptPath } = makePromptDir('structured failure test');
  const { providersDir, providersPath } = makeProviderConfig();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const tab = makeLifecycleTab(mockEvents);

  await assert.rejects(
    runProviderFallback({
      browser: { tabs: { new: async () => tab } },
      browserChannel: 'chrome',
      promptPath,
      role: 'assistant',
      configPath: providersPath,
      stateDir,
      adapterLoader: async () => adapter,
      responseValidator: () => {
        const error = new Error('structured response invalid: source_url_mismatch');
        error.code = 'STRUCTURED_RESPONSE_INVALID';
        error.cacheFailure = false;
        error.sendStarted = true;
        error.failureClass = 'structured_response_invalid';
        throw error;
      },
    }),
    /all configured Web Reasoning providers are unavailable/u,
  );

  const log = JSON.parse(readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim());
  assert.equal(log.success, false);
  assert.equal(log.provider, null);
  assert.equal(mockEvents.includes('archive'), false);
  assert.equal(mockEvents.includes('close'), true);
  const health = JSON.parse(readFileSync(join(stateDir, 'provider-health.json'), 'utf8'));
  assert.equal(health.providers['qwen-terminal-lifecycle'], undefined);

  rmSync(promptDir, { recursive: true, force: true });
  rmSync(providersDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});
test('Qwen terminal lifecycle keeps tab open when archive cannot be verified', async () => {
  const mockEvents = [];
  const { module: adapter } = makeMockProviderAdapter({ shouldFailArchive: true, events: mockEvents });
  const { promptDir, promptPath } = makePromptDir('archive failure test');
  const { providersDir, providersPath } = makeProviderConfig();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const tab = makeLifecycleTab(mockEvents);
  let caught;

  try {
    await runProviderFallback({
      browser: { tabs: { new: async () => tab } },
      browserChannel: 'chrome',
      promptPath,
      role: 'assistant',
      configPath: providersPath,
      stateDir,
      adapterLoader: async () => adapter,
    });
    throw new Error('expected failure did not happen');
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.name, 'ProviderUnavailableError');
  assert.equal(caught?.sendStarted, true);
  assert.equal(caught?.failureClass, 'conversation_cleanup_failed');
  assert.equal(caught?.keepTabOpen, true);
  assert.equal(mockEvents.includes('close'), false);
  assert.deepEqual(mockEvents, ['run', 'archive']);
  const logFile = join(stateDir, 'events.jsonl');
  const logLines = readFileSync(logFile, 'utf8').trim().split('\n');
  const finalLog = JSON.parse(logLines.at(-1));
  const terminalAttempt = finalLog.provider_attempts.find(entry => entry.status === 'conversation_cleanup_failed');
  assert.equal(terminalAttempt?.status, 'conversation_cleanup_failed');

  rmSync(promptDir, { recursive: true, force: true });
  rmSync(providersDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test('pending response resumes on the same tab without submitting again', async () => {
  const events = [];
  const tab = { ...makeLifecycleTab(events), id: 'pending-tab' };
  const adapter = {
    async run() {
      events.push('run');
      const error = new Error('answer still generating');
      error.cacheFailure = false;
      error.sendStarted = true;
      error.keepTabOpen = true;
      error.failureClass = 'post_send_response_unconfirmed';
      error.resumeState = { previousAnswerCount: 0 };
      throw error;
    },
    async resumePendingAnswer({ resumeState }) {
      events.push('resume');
      assert.deepEqual(resumeState, { previousAnswerCount: 0 });
      return { provider: 'Qwen', ...confirmedAssistantResponseMetadata(), answer: 'resumed answer' };
    },
    async archiveConversation() {
      events.push('archive');
      return { action: 'archive', confirmed: true, verification: 'sidebar_link_absent_without_reload' };
    },
  };
  const { providersDir, providersPath } = makeProviderConfig();
  const stateDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-state-'));
  const firstPrompt = makePromptDir('pending response test');
  const first = await runProviderFallback({
    browser: { tabs: { new: async () => tab, get: async () => tab } },
    browserChannel: 'chrome', promptPath: firstPrompt.promptPath, role: 'assistant',
    configPath: providersPath, stateDir, adapterLoader: async () => adapter,
    requestMetadata: { request_id: 'pending-request', cross_call_resume: true },
  });
  assert.equal(first.status, 'pending_response');
  assert.equal(first.pendingResponse.tabId, 'pending-tab');

  const secondPrompt = makePromptDir('resume response test');
  const second = await runProviderFallback({
    browser: { tabs: { new: async () => tab, get: async () => tab } },
    browserChannel: 'chrome', promptPath: secondPrompt.promptPath, role: 'assistant',
    configPath: providersPath, stateDir, adapterLoader: async () => adapter,
    requestMetadata: { request_id: 'pending-request', pending_response: first.pendingResponse },
  });
  assert.equal(second.answer, 'resumed answer');
  assert.equal(second.resumed, true);
  assert.deepEqual(events, ['run', 'resume', 'archive', 'close']);

  rmSync(firstPrompt.promptDir, { recursive: true, force: true });
  rmSync(secondPrompt.promptDir, { recursive: true, force: true });
  rmSync(providersDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});
