import {
  locatorVisible,
  requireVisible,
  submitPromptFromFile,
  unavailable,
  waitForAssistantAnswer,
} from './provider-utils.mjs';

const ASSISTANT_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
const DEEPSEEK_HOME_URL = 'https://chat.deepseek.com/';
const DEEPSEEK_CONVERSATION_PATH_PREFIX = '/a/chat/s/';
const DEEPSEEK_DELETE_LABEL = '删除';
const DEEPSEEK_DELETE_CONFIRM_LABEL = '删除该对话';
const DEEPSEEK_DEEP_THINKING_DEFAULT_TIMEOUT_MS = 180_000;
const DEEPSEEK_DEEP_THINKING_EXTENDED_TIMEOUT_MS = 420_000;

export function resolveDeepSeekAnswerTimeout({
  provider,
  timeoutMs = DEEPSEEK_DEEP_THINKING_DEFAULT_TIMEOUT_MS,
  defaultTimeoutMs = DEEPSEEK_DEEP_THINKING_DEFAULT_TIMEOUT_MS,
} = {}) {
  const baseTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(baseTimeoutMs) || baseTimeoutMs <= 0) return defaultTimeoutMs;
  if (provider?.target?.deep_thinking !== true) return baseTimeoutMs;
  const reservedOutputTokens = Number(provider?.target?.reserved_output_tokens);
  if (Number.isFinite(reservedOutputTokens) && reservedOutputTokens >= 300_000) {
    return DEEPSEEK_DEEP_THINKING_EXTENDED_TIMEOUT_MS;
  }
  return Math.max(baseTimeoutMs, DEEPSEEK_DEEP_THINKING_DEFAULT_TIMEOUT_MS + 120_000);
}

async function hasVisibleConversationMessages(tab) {
  const messages = tab.playwright.locator(`${ASSISTANT_SELECTOR}, [data-message-author-role="user"]`);
  for (let index = 0; index < await messages.count(); index += 1) {
    if (await locatorVisible(messages.nth(index))) return true;
  }
  return false;
}

async function openFreshConversation(tab) {
  await tab.goto(DEEPSEEK_HOME_URL);
  await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 30_000 });
}

async function ensureFreshConversation(tab) {
  if (!await hasVisibleConversationMessages(tab)) return;
  await openFreshConversation(tab);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!await hasVisibleConversationMessages(tab)) return;
    await tab.playwright.waitForTimeout(250);
  }
  unavailable('DeepSeek fresh conversation could not be confirmed');
}

async function ensureDeepThinking(tab) {
  const label = tab.playwright.getByText('深度思考', { exact: true });
  await requireVisible(label, 'DeepSeek 深度思考 control is unavailable');
  const toggle = label.locator('..', {});
  await requireVisible(toggle, 'DeepSeek 深度思考 toggle is unavailable');
  if (await toggle.getAttribute('aria-pressed', { timeoutMs: 30_000 }) !== 'true') {
    await toggle.click({ timeoutMs: 30_000 });
  }
  if (await toggle.getAttribute('aria-pressed', { timeoutMs: 30_000 }) !== 'true') {
    unavailable('DeepSeek 深度思考 could not be confirmed');
  }
}

async function waitForConversationLinkToDisappear(link, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await locatorVisible(link)) return true;
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 250));
  }
  return !await locatorVisible(link);
}

export async function archiveConversation({ tab, provider }) {
  if (provider?.target?.conversation_cleanup !== 'delete') {
    unavailable('DeepSeek cleanup requires conversation_cleanup=delete');
  }
  const currentUrl = new URL(await tab.url());
  if (currentUrl.hostname !== 'chat.deepseek.com' || !currentUrl.pathname.startsWith(DEEPSEEK_CONVERSATION_PATH_PREFIX)) {
    unavailable(`DeepSeek conversation URL is unavailable before cleanup: ${currentUrl.pathname}`);
  }

  const conversationLink = tab.playwright.locator(`a[href="${currentUrl.pathname}"]`);
  await requireVisible(conversationLink, 'DeepSeek current conversation is not listed in the sidebar');
  const menuButton = conversationLink.getByRole('button');
  await requireVisible(menuButton, 'DeepSeek conversation menu is unavailable');
  await menuButton.click({ timeoutMs: 30_000 });

  const menu = tab.playwright.getByRole('menu');
  await requireVisible(menu, 'DeepSeek conversation menu did not open');
  const deleteItem = menu.getByText(DEEPSEEK_DELETE_LABEL, { exact: true });
  await requireVisible(deleteItem, 'DeepSeek delete menu item is unavailable');
  await deleteItem.click({ timeoutMs: 30_000 });

  const dialog = tab.playwright.getByRole('dialog');
  await requireVisible(dialog, 'DeepSeek delete confirmation is unavailable');
  const confirmDelete = dialog.getByRole('button', { name: DEEPSEEK_DELETE_CONFIRM_LABEL, exact: true });
  await requireVisible(confirmDelete, 'DeepSeek delete confirmation button is unavailable');
  await confirmDelete.click({ timeoutMs: 30_000 });

  if (!await waitForConversationLinkToDisappear(conversationLink)) {
    unavailable('DeepSeek conversation deletion could not be confirmed');
  }
  return {
    action: 'delete',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  };
}

export async function runDeepSeekExpert({ provider, tab, promptPath, timeoutMs = 180_000, continuation = false }) {
  if (!tab?.playwright || typeof tab.url !== 'function') throw new Error('a controlled in-app Browser tab is required');
  if (provider?.target?.deep_thinking !== true) {
    unavailable('DeepSeek provider requires deep_thinking=true');
  }
  const currentUrl = new URL(await tab.url());
  if (currentUrl.hostname !== 'chat.deepseek.com' || (!continuation && currentUrl.pathname !== '/')) {
    await openFreshConversation(tab);
  }
  if (!continuation) await ensureFreshConversation(tab);
  const answers = tab.playwright.locator(ASSISTANT_SELECTOR);
  const previousAnswerCount = await answers.count();
  const expertMode = tab.playwright.getByRole('radio', { name: '专家模式', exact: true });
  await requireVisible(expertMode, 'DeepSeek 专家模式 control is unavailable');
  if (await expertMode.getAttribute('aria-checked', { timeoutMs: 30_000 }) !== 'true') {
    await expertMode.click({ timeoutMs: 30_000 });
  }
  if (await expertMode.getAttribute('aria-checked', { timeoutMs: 30_000 }) !== 'true') {
    unavailable('DeepSeek 专家模式 could not be confirmed');
  }
  await ensureDeepThinking(tab);
  const input = tab.playwright.getByRole('textbox', { name: '给 DeepSeek 发送消息', exact: true });
  const { promptRemoved } = await submitPromptFromFile({
    promptPath,
    submit: async promptText => {
      await input.fill(promptText, { timeoutMs: 30_000 });
      await input.press('Enter', { timeoutMs: 30_000 });
    },
  });
  const answer = answers.nth(previousAnswerCount);
  const resolvedTimeoutMs = resolveDeepSeekAnswerTimeout({ provider, timeoutMs });
  const text = await waitForAssistantAnswer({
    answer,
    stopButtons: [tab.playwright.getByRole('button', { name: /停止|Stop/i })],
    timeoutMs: resolvedTimeoutMs,
  });
  return {
    provider: 'DeepSeek',
    mode: '专家模式',
    deepThinking: true,
    promptRemoved,
    answer: text,
  };
}
