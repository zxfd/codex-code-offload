import test from 'node:test';
import assert from 'node:assert/strict';

import { archiveConversation } from '../providers/qwen-web.mjs';

function visibleLocator({
  visible = true,
  onClick = async () => {},
  count = () => 1,
  innerText = async () => '',
  isEnabled = async () => true,
  getByRole = undefined,
} = {}) {
  const isNowVisible = () => (typeof visible === 'function' ? visible() : visible);
  return {
    async count() { return (typeof count === 'function' ? count() : count); },
    first() { return this; },
    nth() { return this; },
    async isVisible() { return isNowVisible(); },
    async isEnabled() { return isEnabled(); },
    async innerText() { return innerText(); },
    async click() { await onClick(); },
    getByRole(role, options = {}) {
      if (typeof getByRole === 'function') {
        const custom = getByRole(role, options);
        if (custom) return custom;
      }
      return visibleLocator({ visible: false });
    },
  };
}

function makeCleanupTab({
  conversationPath = '/c/test-conversation',
  hasConversationMenu = true,
  conversationMenuLabel = '更多',
  hasResponseMoreAction = false,
} = {}) {
  const events = [];
  let conversationListed = true;
  let menuVisible = false;
  let confirmVisible = false;
  const responseControlsTriggered = [];

  const conversationMenu = visibleLocator({
    visible: () => hasConversationMenu && conversationListed && (conversationMenuLabel === '更多' || conversationMenuLabel === '更多操作' || conversationMenuLabel === 'Chat Menu'),
    onClick: async () => {
      menuVisible = true;
      events.push(`open-menu-${conversationMenuLabel}`);
    },
  });

  const responseMoreAction = visibleLocator({
    visible: () => hasResponseMoreAction && conversationListed,
    onClick: async () => {
      responseControlsTriggered.push('open-response-more-action');
    },
  });

  const archiveItem = visibleLocator({
    visible: () => menuVisible,
    onClick: async () => {
      events.push('archive-click');
      conversationListed = false;
      menuVisible = false;
    },
  });

  const confirmButton = visibleLocator({
    visible: () => confirmVisible,
    onClick: async () => {
      events.push('archive-confirm');
      conversationListed = false;
      menuVisible = false;
    },
  });

  const conversationLink = visibleLocator({
    visible: () => conversationListed,
    onClick: async () => {},
    getByRole: (role) => {
      if (role === 'button') return conversationMenu;
      return visibleLocator({ visible: false });
    },
  });

  return {
    events,
    async url() {
      return `https://chat.qwen.ai${conversationPath}`;
    },
    playwright: {
      locator(selector) {
        if (selector === `a[href="${conversationPath}"]`) return conversationLink;
        if (selector === '.response-message-content.phase-answer') {
          return visibleLocator({ visible: false });
        }
        if (selector === '.user-message-content, [class*="user-message-content"]') {
          return visibleLocator({ visible: false });
        }
        if (selector === 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]') {
          return visibleLocator({ visible: false });
        }
        return visibleLocator({ visible: false });
      },
      getByRole(role, options = {}) {
        if (role === 'button' && options.name === '发送') {
          return visibleLocator({ visible: false });
        }
        if (role === 'menu') {
          return visibleLocator({
            visible: () => menuVisible,
            getByRole: () => visibleLocator({ visible: false }),
          });
        }
        if (role === 'menuitem' && options.name === '归档') {
          return archiveItem;
        }
        if (role === 'button' && options.name === 'Chat Menu') {
          return conversationMenu;
        }
        if (role === 'button' && options.name === '更多') {
          return conversationMenu;
        }
        if (role === 'button' && options.name === '更多操作') {
          return hasResponseMoreAction ? responseMoreAction : visibleLocator({ visible: false });
        }
        if (role === 'dialog') {
          return visibleLocator({
            visible: () => confirmVisible,
            getByRole: (_dialogRole, dialogOptions = {}) => {
              if (_dialogRole === 'button' && (dialogOptions.name === '确定' || dialogOptions.name === '确认')) {
                return confirmButton;
              }
              return visibleLocator({ visible: false });
            },
          });
        }
        if (role === 'button' && (options.name === '确定' || options.name === '确认')) {
          return confirmButton;
        }
        return visibleLocator({ visible: false });
      },
      async waitForTimeout() {},
      responseControlsTriggered,
    },
  };
}

test('Qwen archives a terminal conversation and verifies cleanup before returning', async () => {
  const tab = makeCleanupTab();
  const cleanup = await archiveConversation({
    tab,
    provider: { target: { models: ['Qwen3.8-Max', 'Qwen3.7-Max'] } },
  });
  assert.deepEqual(cleanup, {
    action: 'archive',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  });
  assert.deepEqual(tab.events, ['open-menu-更多', 'archive-click']);
});

test('Qwen archives root conversation page when task chat menu is visible', async () => {
  const tab = makeCleanupTab({ conversationPath: '/', conversationMenuLabel: 'Chat Menu' });
  const cleanup = await archiveConversation({
    tab,
    provider: { target: { models: ['Qwen3.8-Max', 'Qwen3.7-Max'] } },
  });
  assert.deepEqual(cleanup, {
    action: 'archive',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  });
  assert.deepEqual(tab.events, ['open-menu-Chat Menu', 'archive-click']);
});

test('Qwen archive cleanup requires a real conversation URL', async () => {
  await assert.rejects(
    archiveConversation({
      tab: {
        async url() { return 'https://example.com/'; },
        playwright: {
          getByRole: () => visibleLocator({ visible: false }),
          locator: () => visibleLocator({ visible: false }),
        },
      },
      provider: { target: { models: ['Qwen3.8-Max', 'Qwen3.7-Max'] } },
    }),
    /Qwen conversation URL is unavailable before cleanup:/,
  );
});

test('Qwen archive cleanup rejects a root page with no visible conversation menu', async () => {
  await assert.rejects(
    archiveConversation({
      tab: makeCleanupTab({ conversationPath: '/', hasConversationMenu: false }),
      provider: { target: { models: ['Qwen3.8-Max', 'Qwen3.7-Max'] } },
    }),
    /Qwen conversation URL is unavailable before cleanup:/,
  );
});

test('Qwen prefers Chat Menu over response-level 更多操作 control', async () => {
  const tab = makeCleanupTab({
    conversationPath: '/c/test-conversation',
    conversationMenuLabel: 'Chat Menu',
    hasResponseMoreAction: true,
  });

  const cleanup = await archiveConversation({
    tab,
    provider: { target: { models: ['Qwen3.8-Max', 'Qwen3.7-Max'] } },
  });

  assert.deepEqual(cleanup, {
    action: 'archive',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  });
  assert.deepEqual(tab.events, ['open-menu-Chat Menu', 'archive-click']);
  assert.deepEqual(tab.playwright.responseControlsTriggered, []);
});
