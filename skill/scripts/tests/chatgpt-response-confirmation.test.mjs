import test from 'node:test';
import assert from 'node:assert/strict';

import {
  archiveConversation,
  locateNewAssistantAnswer,
  waitForNextAssistantAnswer,
} from '../providers/chatgpt-web.mjs';
import { isCoolingDown } from '../web-provider-runner.mjs';

function makeAnswer(text) {
  return {
    async count() { return 1; },
    first() { return this; },
    async isVisible() { return true; },
    async innerText() { return text; },
  };
}

function makeTab(counts, answer = makeAnswer('PROVIDER_OK:ChatGPT')) {
  let reads = 0;
  const groups = {
    async count() {
      const index = Math.min(reads++, counts.length - 1);
      return counts[index];
    },
    nth() { return answer; },
  };
  return {
    playwright: {
      locator() { return groups; },
      getByRole() {
        return { count: async () => 0 };
      },
      async waitForTimeout() {},
    },
  };
}

function makeArchiveTab({ listed = false, historyBlocked = false } = {}) {
  const events = [];
  const locator = ({ visible = true, onClick = async () => {}, href = null } = {}) => ({
    async count() { return visible ? 1 : 0; },
    first() { return this; },
    nth() { return this; },
    async isVisible() { return visible; },
    async click() { events.push('click'); await onClick(); },
    async getAttribute(name) { return name === 'href' ? href : null; },
  });
  const tab = {
    events,
    reloads: 0,
    async url() { return 'https://chatgpt.com/c/test-conversation'; },
    async reload() { this.reloads += 1; events.push('reload'); },
    playwright: {
      getByRole(role, options = {}) {
        if (role === 'button' && options.name === '更多') return locator();
        if (role === 'menuitem' && options.name === '归档') return locator();
        if (role === 'dialog' && historyBlocked) {
          return {
            ...locator(),
            getByRole() { return locator({ visible: false }); },
          };
        }
        if (role === 'dialog') return locator({ visible: false });
        return locator({ visible: false });
      },
      locator(selector) {
        if (selector === 'a' && listed) return locator({ href: '/c/test-conversation' });
        return locator({ visible: false });
      },
      async waitForTimeout() {},
      async waitForLoadState() {},
    },
  };
  return tab;
}

test('ChatGPT response confirmation rejects an old assistant message', async () => {
  const tab = makeTab([1, 1, 1]);
  await assert.rejects(
    locateNewAssistantAnswer({ tab, previousGroupCount: 1, timeoutMs: 5, pollMs: 1 }),
    /did not create a new assistant message/,
  );
});

test('ChatGPT response confirmation accepts only a newly created assistant message', async () => {
  const tab = makeTab([1, 1, 2]);
  const answer = await waitForNextAssistantAnswer({
    tab,
    previousGroupCount: 1,
    timeoutMs: 5_000,
    checkInterrupted: async () => {},
  });
  assert.equal(answer, 'PROVIDER_OK:ChatGPT');
});

test('legacy negative health entries do not suppress ChatGPT', () => {
  const now = Date.now();
  const targetSignature = 'same-target';
  assert.equal(isCoolingDown({
    status: 'unavailable',
    last_failure: new Date(now - 1_000).toISOString(),
    target_signature: targetSignature,
    current_target_signature: targetSignature,
  }, 300_000, now), false);
  assert.equal(isCoolingDown({
    status: 'unavailable',
    failure_protocol_version: 2,
    last_failure: new Date(now - 1_000).toISOString(),
    target_signature: targetSignature,
    current_target_signature: targetSignature,
  }, 300_000, now), true);
});

test('ChatGPT archives the conversation and refreshes before cleanup completes', async () => {
  const tab = makeArchiveTab();
  const cleanup = await archiveConversation({
    tab,
    provider: { target: { model: 'GPT-5.6 Sol' } },
  });
  assert.deepEqual(cleanup, {
    action: 'archive',
    confirmed: true,
    verification: 'sidebar_link_absent_after_reload',
  });
  assert.equal(tab.reloads, 1);
  assert.deepEqual(tab.events, ['click', 'click', 'reload']);
});

test('ChatGPT archive cleanup rejects a conversation still listed after refresh', async () => {
  await assert.rejects(
    archiveConversation({
      tab: makeArchiveTab({ listed: true }),
      provider: { target: { model: 'GPT-5.6 Sol' } },
    }),
    /conversation archive failed: conversation_archive_not_confirmed/,
  );
});

test('ChatGPT archive cleanup rejects blocked history verification', async () => {
  await assert.rejects(
    archiveConversation({
      tab: makeArchiveTab({ historyBlocked: true }),
      provider: { target: { model: 'GPT-5.6 Sol' } },
    }),
    /conversation archive failed: conversation_archive_history_unavailable/,
  );
});
