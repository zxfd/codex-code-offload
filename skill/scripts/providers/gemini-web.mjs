import { pasteProviderImages } from '../media-upload.mjs';

import {
  captureSemanticUiEvidence,
  locatorVisible,
  submitPromptFromFile,
  unavailable,
  waitForComposerSettled,
  waitForAssistantAnswer,
} from '../provider-utils.mjs';

export const GEMINI_COMPOSER_NAMES = ['问问 Gemini', '为 Gemini 输入提示', 'Ask Gemini'];
export const GEMINI_NEW_CHAT_LABELS = ['发起新对话', '新对话', 'New chat', 'Start new chat'];

async function unavailableWithEvidence({ tab, message, stage, uiEvidence }) {
  let uiEvidencePath;
  if (uiEvidence) {
    try {
      uiEvidencePath = await captureSemanticUiEvidence({
        tab,
        provider: 'Gemini',
        stage,
        acceptedNames: [...GEMINI_COMPOSER_NAMES, ...GEMINI_NEW_CHAT_LABELS, '发送', 'Send', '停止', 'Stop', '登录', 'Sign in'],
      });
    } catch {
      // Diagnostic capture is best-effort and must not broaden browser inspection.
    }
  }
  unavailable(message, { uiEvidencePath });
}

async function oneVisible(locator, message) {
  const visible = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await locatorVisible(candidate)) visible.push(candidate);
  }
  if (visible.length !== 1) throw new Error(`${message}: visible_matches=${visible.length}`);
  return visible[0];
}

async function findComposer(tab) {
  for (const name of GEMINI_COMPOSER_NAMES) {
    const named = tab.playwright.getByRole('textbox', { name, exact: true });
    try {
      return await oneVisible(named, `Gemini composer is ambiguous: ${name}`);
    } catch (error) {
      if (!String(error?.message || error).endsWith('visible_matches=0')) throw error;
    }
  }
  return oneVisible(
    tab.playwright.locator('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'),
    'Gemini composer is unavailable',
  );
}

async function hasVisibleConversationMessages(tab) {
  const messages = tab.playwright.locator('model-response, user-query, user-query-content');
  for (let index = 0; index < await messages.count(); index += 1) {
    if (await locatorVisible(messages.nth(index))) return true;
  }
  return false;
}

async function firstVisibleNewChatControl(tab) {
  for (const role of ['link', 'button']) {
    for (const name of GEMINI_NEW_CHAT_LABELS) {
      const controls = tab.playwright.getByRole(role, { name, exact: true });
      for (let index = 0; index < await controls.count(); index += 1) {
        const candidate = controls.nth(index);
        if (await locatorVisible(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function waitForSubmissionProof({ tab, composer, userMessages, previousUserMessageCount, timeoutMs = 15_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composerText = String(await composer.evaluate(element => (
      'value' in element ? element.value : (element.innerText || element.textContent || '')
    ), undefined, { timeoutMs: 10_000 })).trim();
    if (!composerText || await userMessages.count() > previousUserMessageCount) return true;
    await tab.playwright.waitForTimeout(250);
  }
  return false;
}

async function ensureFreshConversation({ tab, uiEvidence }) {
  if (!await hasVisibleConversationMessages(tab)) return;
  try {
    const newChat = await firstVisibleNewChatControl(tab);
    if (!newChat) throw new Error('new_chat_control_not_found');
    await newChat.click({ timeoutMs: 30_000 });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!await hasVisibleConversationMessages(tab)) return;
      await tab.playwright.waitForTimeout(250);
    }
    throw new Error('new_chat_did_not_clear_the_existing_conversation');
  } catch (error) {
    await unavailableWithEvidence({
      tab,
      message: `Gemini new-conversation recovery failed: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'fresh_conversation',
      uiEvidence,
    });
  }
}

export async function run({ provider, tab, promptPath, timeoutMs = 180_000, continuation = false, uiEvidence = false, imagePaths = [] }) {
  if (!tab?.playwright || typeof tab.url !== 'function') throw new Error('a controlled Chrome tab is required');
  const currentUrl = new URL(await tab.url());
  if (!continuation || currentUrl.hostname !== 'gemini.google.com') {
    await tab.goto(provider.url);
    await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 30_000 });
  }
  const login = tab.playwright.getByRole('button', { name: /^(登录|Sign in)$/i });
  if (await locatorVisible(login)) {
    await unavailableWithEvidence({ tab, message: 'Gemini login is required', stage: 'login_check', uiEvidence });
  }
  if (!continuation) await ensureFreshConversation({ tab, uiEvidence });

  let composer;
  try {
    composer = await findComposer(tab);
  } catch (error) {
    await unavailableWithEvidence({
      tab,
      message: `Gemini composer is unavailable: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'composer_check',
      uiEvidence,
    });
  }
  const answers = tab.playwright.locator('model-response');
  const previousAnswerCount = await answers.count();
  const userMessages = tab.playwright.locator('user-query, user-query-content');
  const previousUserMessageCount = await userMessages.count();
  let attachmentState = null;
  const { promptRemoved } = await submitPromptFromFile({
    promptPath,
    submit: async promptText => {
      await composer.fill(promptText, { timeoutMs: 60_000 });
      await waitForComposerSettled({
        tab,
        composer,
        expectedTextLength: promptText.length,
        timeoutMs: promptText.length >= 8_000 ? 120_000 : 20_000,
      });
      if (imagePaths.length) {
        attachmentState = await pasteProviderImages({ tab, provider: 'Gemini', imagePaths, composer });
      }
      const send = tab.playwright.getByRole('button', { name: /^(发送|Send)$/i });
      if (await locatorVisible(send) && await send.first().isEnabled()) {
        await send.first().click({ timeoutMs: 30_000 });
      }
      if (!await waitForSubmissionProof({ tab, composer, userMessages, previousUserMessageCount })) {
        await composer.press('Enter', { timeoutMs: 30_000 });
      }
      if (!await waitForSubmissionProof({ tab, composer, userMessages, previousUserMessageCount })) {
        throw new Error('Gemini prompt submission was not observed after one retry');
      }
    },
  });
  const answer = answers.nth(previousAnswerCount);
  const text = await waitForAssistantAnswer({
    answer,
    stopButtons: [tab.playwright.getByRole('button', { name: /停止|Stop/i })],
    timeoutMs,
  });
  return {
    provider: 'Gemini',
    mode: provider.target.mode || 'current',
    promptRemoved,
    attachmentsReady: imagePaths.length > 0 ? attachmentState.ready : null,
    answer: text,
  };
}
