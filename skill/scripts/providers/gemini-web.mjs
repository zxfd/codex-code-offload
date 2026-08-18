import { pasteProviderImages } from '../media-upload.mjs';
import { confirmedAssistantResponseMetadata } from '../provider-response.mjs';

import {
  captureSemanticUiEvidence,
  locatorVisible,
  submitPromptFromFile,
  unavailable,
  waitForComposerSettled,
  waitForAssistantAnswer,
  DEFAULT_PROVIDER_ANSWER_TIMEOUT_MS,
} from '../provider-utils.mjs';

export const GEMINI_COMPOSER_NAMES = ['问问 Gemini', '为 Gemini 输入提示', 'Ask Gemini'];
export const GEMINI_NEW_CHAT_LABELS = ['发起新对话', '新对话', 'New chat', 'Start new chat'];
const GEMINI_CONVERSATION_MENU_LABEL = '打开对话操作菜单。';
const GEMINI_DELETE_LABEL = '删除';
const GEMINI_DELETE_CONFIRM_LABEL = '删除';
const GEMINI_DELETE_CONFIRM_TITLE = '要删除对话吗？';
const GEMINI_DELETE_CONFIRM_TEXT = '此操作将从 Gemini 应用活动记录中删除提示、回答和反馈，以及你创建的所有内容。';
const SUBMISSION_RETRIES = 2;

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

function isConversationMenuUrl(url) {
  return url.hostname === 'gemini.google.com' && (url.pathname === '/app' || url.pathname.startsWith('/app/'));
}

function conversationSidebarLinkLocator(tab, currentUrl) {
  if (currentUrl.pathname === '/app' || currentUrl.pathname === '/app/') return null;
  const href = `${currentUrl.pathname}${currentUrl.search}`;
  return tab.playwright.locator(`a[href="${href}"]`);
}

async function waitForConversationCleanupVerification({ tab, conversationMenu, previousUrl, timeoutMs = 10_000 }) {
  const candidateConversationLink = conversationSidebarLinkLocator(tab, previousUrl);
  const conversationLink = candidateConversationLink && (await candidateConversationLink.count() === 1
    ? candidateConversationLink
    : null);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const currentUrl = new URL(await tab.url());
      if (currentUrl.href !== previousUrl.href) {
        return 'conversation_url_changed_without_reload';
      }
    } catch {
      return 'conversation_url_changed_without_reload';
    }
    if (conversationLink && !await locatorVisible(conversationLink)) {
      return 'sidebar_link_absent_without_reload';
    }

    if (!await locatorVisible(conversationMenu)) {
      return 'conversation_menu_disappeared_without_reload';
    }

    await tab.playwright.waitForTimeout(250);
  }
  return null;
}

async function unavailableWithEvidenceArchive({ tab, message, stage, provider, uiEvidence }) {
  await unavailableWithEvidence({
    tab,
    message,
    stage,
    provider,
    uiEvidence,
    names: [
      ...GEMINI_COMPOSER_NAMES,
      ...GEMINI_NEW_CHAT_LABELS,
      GEMINI_CONVERSATION_MENU_LABEL,
      GEMINI_DELETE_LABEL,
    ],
  });
}

export async function archiveConversation({ tab, provider, uiEvidence = false }) {
  if (provider?.target?.conversation_cleanup !== 'delete') {
    await unavailableWithEvidenceArchive({
      tab,
      message: 'Gemini cleanup requires conversation_cleanup=delete',
      stage: 'conversation_cleanup_policy',
      provider,
      uiEvidence,
    });
  }

  const currentUrl = new URL(await tab.url());
  if (!isConversationMenuUrl(currentUrl)) {
    await unavailableWithEvidenceArchive({
      tab,
      message: `Gemini conversation URL is unavailable before cleanup: ${currentUrl.pathname}`,
      stage: 'conversation_cleanup_url_check',
      provider,
      uiEvidence,
    });
  }

  const conversationMenu = await oneVisible(
    tab.playwright.getByRole('button', { name: GEMINI_CONVERSATION_MENU_LABEL, exact: true }),
    'Gemini conversation menu is unavailable',
  );
  const previousUrl = currentUrl;

  await conversationMenu.click({ timeoutMs: 30_000 });
  const menu = await oneVisible(
    tab.playwright.getByRole('menu'),
    'Gemini conversation menu panel is unavailable',
  );
  const deleteMenuItem = await oneVisible(
    menu.getByRole('menuitem', { name: GEMINI_DELETE_LABEL, exact: true }),
    'Gemini conversation delete menu item is unavailable',
  );
  await deleteMenuItem.click({ timeoutMs: 30_000 });

  const dialog = await oneVisible(tab.playwright.getByRole('dialog'), 'Gemini delete confirmation is unavailable');
  const title = dialog.getByRole('heading', { name: GEMINI_DELETE_CONFIRM_TITLE, exact: true });
  if (!await locatorVisible(title)) {
    await unavailableWithEvidenceArchive({
      tab,
      message: 'Gemini delete confirmation title is unavailable',
      stage: 'conversation_cleanup_confirmation',
      provider,
      uiEvidence,
    });
  }
  const detail = tab.playwright.getByText(GEMINI_DELETE_CONFIRM_TEXT, { exact: true });
  if (!await locatorVisible(detail)) {
    await unavailableWithEvidenceArchive({
      tab,
      message: 'Gemini delete confirmation detail is unexpected',
      stage: 'conversation_cleanup_confirmation',
      provider,
      uiEvidence,
    });
  }
  const confirmDelete = await oneVisible(dialog.getByRole('button', { name: GEMINI_DELETE_CONFIRM_LABEL, exact: true }),
    'Gemini conversation delete confirmation button is unavailable');
  await confirmDelete.click({ timeoutMs: 30_000 });

  const verification = await waitForConversationCleanupVerification({
    tab,
    conversationMenu,
    previousUrl,
    timeoutMs: 12_000,
  });
  if (!verification) {
    await unavailableWithEvidenceArchive({
      tab,
      message: 'Gemini conversation deletion could not be confirmed',
      stage: 'conversation_cleanup_verification',
      provider,
      uiEvidence,
    });
  }

  return {
    action: 'delete',
    confirmed: true,
    verification,
  };
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

export async function run({ provider, tab, promptPath, timeoutMs = DEFAULT_PROVIDER_ANSWER_TIMEOUT_MS, continuation = false, uiEvidence = false, imagePaths = [] }) {
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
      let submitted = false;
      for (let attempt = 0; attempt <= SUBMISSION_RETRIES && !submitted; attempt += 1) {
        const send = tab.playwright.getByRole('button', { name: /^(发送|Send)$/i });
        if (await locatorVisible(send) && await send.first().isEnabled()) {
          await send.first().click({ timeoutMs: 30_000 });
        } else {
          await composer.press('Enter', { timeoutMs: 30_000 });
        }
        submitted = await waitForSubmissionProof({ tab, composer, userMessages, previousUserMessageCount });
        if (!submitted && attempt < SUBMISSION_RETRIES) {
          await tab.playwright.waitForTimeout(1_000 * (attempt + 1));
        }
      }
      if (!submitted) {
        throw new Error('Gemini prompt submission was not observed after two retries');
      }
    },
  });
  const answer = answers.nth(previousAnswerCount);
  let text;
  try {
    text = await waitForAssistantAnswer({
      answer,
      stopButtons: [tab.playwright.getByRole('button', { name: /停止|Stop/i })],
      timeoutMs,
    });
  } catch (error) {
    error.cacheFailure = false;
    error.sendStarted = true;
    error.keepTabOpen = true;
    error.failureClass = 'post_send_response_unconfirmed';
    error.resumeState = {
      previousAnswerCount,
      attachmentsReady: imagePaths.length > 0 ? attachmentState?.ready === true : null,
      promptRemoved,
    };
    throw error;
  }
  return {
    provider: 'Gemini',
    mode: provider.target.mode || 'current',
    promptRemoved,
    attachmentsReady: imagePaths.length > 0 ? attachmentState.ready : null,
    ...confirmedAssistantResponseMetadata(),
    answer: text,
  };
}

export async function resumePendingAnswer({ tab, timeoutMs = DEFAULT_PROVIDER_ANSWER_TIMEOUT_MS, resumeState = {} }) {
  if (!tab?.playwright) throw new Error('a controlled Chrome tab is required');
  const previousAnswerCount = Number(resumeState.previousAnswerCount);
  if (!Number.isSafeInteger(previousAnswerCount) || previousAnswerCount < 0) {
    throw new Error('Gemini pending response baseline is invalid');
  }
  const answer = tab.playwright.locator('model-response').nth(previousAnswerCount);
  try {
    const text = await waitForAssistantAnswer({
      answer,
      stopButtons: [tab.playwright.getByRole('button', { name: /停止|Stop/i })],
      timeoutMs,
    });
    return {
      provider: 'Gemini',
      promptRemoved: resumeState.promptRemoved === true,
      attachmentsReady: resumeState.attachmentsReady ?? null,
      ...confirmedAssistantResponseMetadata(),
      answer: text,
    };
  } catch (error) {
    error.cacheFailure = false;
    error.sendStarted = true;
    error.keepTabOpen = true;
    error.failureClass = 'post_send_response_unconfirmed';
    error.resumeState = resumeState;
    throw error;
  }
}
