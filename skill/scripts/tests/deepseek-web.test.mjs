import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveConversation, runDeepSeekExpert } from '../deepseek-expert-browser.mjs';

function visibleLocator({ visible = true, onClick = async () => {}, attribute = {}, fill = async () => {}, press = async () => {}, innerText = async () => '' } = {}) {
  const isNowVisible = () => typeof visible === 'function' ? visible() : visible;
  return {
    async count() { return isNowVisible() ? 1 : 0; },
    first() { return this; },
    async isVisible() { return isNowVisible(); },
    async getAttribute(name) { return typeof attribute === 'function' ? attribute(name) : attribute[name] ?? null; },
    async click() { await onClick(); },
    async fill(value) { await fill(value); },
    async press(key) { await press(key); },
    async innerText() { return innerText(); },
    async waitFor(options = {}) {
      if (options.state === 'visible' && !isNowVisible()) throw new Error('not visible');
    },
    locator() { return this; },
  };
}

function makeRunTab() {
  let expert = false;
  let deepThinking = false;
  const answer = visibleLocator({
    async innerText() { return 'DEEPSEEK_OK'; },
  });
  const answers = {
    async count() { return 0; },
    nth() { return answer; },
  };
  const deepThinkingLabel = visibleLocator();
  deepThinkingLabel.locator = () => visibleLocator({
    attribute: name => name === 'aria-pressed' && deepThinking ? 'true' : 'false',
    onClick: async () => { deepThinking = true; },
  });
  const input = visibleLocator({
    async fill() {},
    async press() {},
  });
  return {
    playwright: {
      locator() { return answers; },
      getByRole(role, options = {}) {
        if (role === 'radio' && options.name === '专家模式') {
          return visibleLocator({
            attribute: name => name === 'aria-checked' && expert ? 'true' : 'false',
            onClick: async () => { expert = true; },
          });
        }
        if (role === 'textbox') return input;
        return visibleLocator({ visible: false });
      },
      getByText(text) {
        return text === '深度思考' ? deepThinkingLabel : visibleLocator({ visible: false });
      },
      async waitForTimeout() {},
    },
    async url() { return 'https://chat.deepseek.com/'; },
  };
}

function makeCleanupTab() {
  let listed = true;
  let menuVisible = false;
  let dialogVisible = false;
  const events = [];
  const conversationLink = visibleLocator({
    visible: () => listed,
    onClick: async () => {},
  });
  conversationLink.count = async () => listed ? 1 : 0;
  conversationLink.isVisible = async () => listed;
  conversationLink.getByRole = role => role === 'button'
    ? visibleLocator({ onClick: async () => { menuVisible = true; events.push('menu'); } })
    : visibleLocator({ visible: false });
  const deleteItem = visibleLocator({
    visible: () => menuVisible,
    onClick: async () => { menuVisible = false; dialogVisible = true; events.push('delete-menu'); },
  });
  const dialog = visibleLocator({ visible: () => dialogVisible });
  dialog.getByRole = (role, options = {}) => role === 'button' && options.name === '删除该对话'
    ? visibleLocator({
      visible: () => dialogVisible,
      onClick: async () => { dialogVisible = false; listed = false; events.push('confirm-delete'); },
    })
    : visibleLocator({ visible: false });
  return {
    events,
    playwright: {
      locator() { return conversationLink; },
      getByRole(role) {
        if (role === 'menu') {
          const menu = visibleLocator({ visible: () => menuVisible });
          menu.getByText = () => deleteItem;
          return menu;
        }
        if (role === 'dialog') return dialog;
        return visibleLocator({ visible: false });
      },
    },
    async url() { return 'https://chat.deepseek.com/a/chat/s/test-conversation'; },
  };
}

test('DeepSeek enables expert mode and deep thinking before sending', async () => {
  const promptDir = mkdtempSync(join(tmpdir(), 'codex-web-reasoning-prompt-'));
  const promptPath = join(promptDir, 'prompt.txt');
  writeFileSync(promptPath, 'reply with OK');
  try {
    const result = await runDeepSeekExpert({
      provider: { target: { deep_thinking: true } },
      tab: makeRunTab(),
      promptPath,
      timeoutMs: 5_000,
    });
    assert.equal(result.mode, '专家模式');
    assert.equal(result.deepThinking, true);
    assert.equal(result.answer, 'DEEPSEEK_OK');
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
});

test('DeepSeek deletes the terminal conversation before the tab is closed', async () => {
  const tab = makeCleanupTab();
  const cleanup = await archiveConversation({ tab, provider: { target: { conversation_cleanup: 'delete' } } });
  assert.deepEqual(cleanup, {
    action: 'delete',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  });
  assert.deepEqual(tab.events, ['menu', 'delete-menu', 'confirm-delete']);
});

test('DeepSeek cleanup fails closed outside a conversation URL', async () => {
  await assert.rejects(
    archiveConversation({
      provider: { target: { conversation_cleanup: 'delete' } },
      tab: {
        async url() { return 'https://chat.deepseek.com/'; },
        playwright: {},
      },
    }),
    /conversation URL is unavailable before cleanup/,
  );
});
