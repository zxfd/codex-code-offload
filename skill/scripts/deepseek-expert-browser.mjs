import {
  locatorVisible,
  requireVisible,
  submitPromptFromFile,
  unavailable,
  waitForAssistantAnswer,
} from './provider-utils.mjs';

const ASSISTANT_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
const DEEPSEEK_HOME_URL = 'https://chat.deepseek.com/';

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

export async function runDeepSeekExpert({ tab, promptPath, timeoutMs = 180_000, continuation = false }) {
  if (!tab?.playwright || typeof tab.url !== 'function') throw new Error('a controlled in-app Browser tab is required');
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
  const input = tab.playwright.getByRole('textbox', { name: '给 DeepSeek 发送消息', exact: true });
  const { promptRemoved } = await submitPromptFromFile({
    promptPath,
    submit: async promptText => {
      await input.fill(promptText, { timeoutMs: 30_000 });
      await input.press('Enter', { timeoutMs: 30_000 });
    },
  });
  const answer = answers.nth(previousAnswerCount);
  const text = await waitForAssistantAnswer({
    answer,
    stopButtons: [tab.playwright.getByRole('button', { name: /停止|Stop/i })],
    timeoutMs,
  });
  return {
    provider: 'DeepSeek',
    mode: '专家模式',
    promptRemoved,
    answer: text,
  };
}
