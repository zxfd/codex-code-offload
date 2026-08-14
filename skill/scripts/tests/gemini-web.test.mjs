import test from 'node:test';
import assert from 'node:assert/strict';

import { archiveConversation } from '../providers/gemini-web.mjs';

function visibleLocator({
  visible = true,
  onClick = async () => {},
  count = () => 1,
  innerText = async () => '',
  text = async () => '',
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
    async textContent() { return text(); },
    async click() { await onClick(); },
    getByRole(role, options = {}) {
      if (typeof getByRole === 'function') {
        const custom = getByRole(role, options);
        if (custom) return custom;
      }
      const name = options.name;
      if (role === 'button' && name === '删除') {
        return this;
      }
      if (role === 'menuitem' && name === '删除') {
        return this;
      }
      if (role === 'heading' && name === '要删除对话吗？') {
        return this;
      }
      return visibleLocator({ visible: false });
    },
  };
}

function makeCleanupTab({ listed = true, changeAfterDelete = false, failVerification = false } = {}) {
  const events = [];
  let conversationListed = listed;
  let sidebarConversationVisible = true;
  let menuVisible = false;
  let dialogVisible = false;
  let currentUrl = 'https://gemini.google.com/app/c/test-conversation';

  const conversationMenu = visibleLocator({
    visible: () => conversationListed,
    onClick: async () => {
      menuVisible = true;
      events.push('menu');
    },
  });

  const deleteMenuItem = visibleLocator({
    visible: () => menuVisible,
    onClick: async () => {
      dialogVisible = true;
      events.push('delete-item');
    },
  });

  const deleteConfirmButton = visibleLocator({
    visible: () => dialogVisible,
    onClick: async () => {
      dialogVisible = false;
      if (!failVerification) {
        sidebarConversationVisible = false;
        events.push('confirm-delete');
      }
      if (changeAfterDelete) {
        currentUrl = 'https://gemini.google.com/app';
      }
      if (failVerification) {
        events.push('confirm-delete-blocked');
      }
    },
  });

  const dialog = visibleLocator({
    visible: () => dialogVisible,
    getByRole(role, options = {}) {
      if (role === 'button' && options.name === '删除') return deleteConfirmButton;
      if (role === 'heading' && options.name === '要删除对话吗？') return visibleLocator({
        visible: () => dialogVisible,
      });
      return visibleLocator({ visible: false });
    },
  });

  const menu = visibleLocator({
    visible: () => menuVisible,
    getByRole(role, options = {}) {
      const menuItemName = options?.name;
      if (role === 'menuitem' && (menuItemName === '删除' || menuItemName === '删除对话')) return deleteMenuItem;
      return visibleLocator({ visible: false });
    },
  });

  return {
    events,
    async url() {
      return currentUrl;
    },
    playwright: {
      getByRole(role, options = {}) {
        if (role === 'button' && options.name === '打开对话操作菜单。') return conversationMenu;
        if (role === 'menu') return menu;
        if (role === 'dialog') return dialog;
        if (role === 'dialog') return dialog;
        return visibleLocator({ visible: false });
      },
      locator(selector) {
        if (selector === 'a[href="/app/c/test-conversation"]') {
          return visibleLocator({
            visible: () => sidebarConversationVisible,
            isEnabled: async () => true,
            async count() { return conversationListed ? 1 : 0; },
            getByRole(role) {
              if (role === 'button') return conversationMenu;
              return visibleLocator({ visible: false });
            },
          });
        }
        return visibleLocator({ visible: false });
      },
      getByText(textValue) {
        if (textValue === '此操作将从 Gemini 应用活动记录中删除提示、回答和反馈，以及你创建的所有内容。') {
          return visibleLocator({ visible: () => dialogVisible });
        }
        return visibleLocator({ visible: false });
      },
      async waitForTimeout() {},
    },
  };
}

test('Gemini deletes terminal conversation with delete confirmation and returns verified status', async () => {
  const tab = makeCleanupTab({ listed: true });
  const cleanup = await archiveConversation({
    tab,
    provider: { target: { conversation_cleanup: 'delete' } },
  });

  assert.deepEqual(cleanup, {
    action: 'delete',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  });
  assert.deepEqual(tab.events, ['menu', 'delete-item', 'confirm-delete']);
});

test('Gemini cleanup rejects non-delete configured mode', async () => {
  await assert.rejects(
    archiveConversation({
      tab: makeCleanupTab({}),
      provider: { target: { conversation_cleanup: 'archive' } },
    }),
    /cleanup requires conversation_cleanup=delete/,
  );
});

test('Gemini cleanup fails closed when URL is unavailable', async () => {
  await assert.rejects(
    archiveConversation({
      tab: {
        async url() { return 'https://example.com/'; },
        playwright: {},
      },
      provider: { target: { conversation_cleanup: 'delete' } },
    }),
    /Gemini conversation URL is unavailable before cleanup/,
  );
});

test('Gemini cleanup fails when deletion cannot be verified', async () => {
  await assert.rejects(
    archiveConversation({
      tab: makeCleanupTab({ failVerification: true }),
      provider: { target: { conversation_cleanup: 'delete' } },
    }),
    /Gemini conversation deletion could not be confirmed/,
  );
});
