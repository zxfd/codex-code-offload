import { pasteProviderImages } from '../media-upload.mjs';

import {
  captureSemanticUiEvidence,
  escapeRegex,
  locatorVisible,
  submitPromptFromFile,
  unavailable,
  waitForComposerSettled,
  waitForAssistantAnswer,
} from '../provider-utils.mjs';

export const QWEN_COMPOSER_NAMES = ['有什么我能帮您的吗？', 'How can I help you?'];
export const QWEN_NEW_CHAT_LABELS = ['新建对话', 'New chat'];
export const QWEN_MODEL_CONTROL_NAMES = ['Select Model', '选择模型'];
export const QWEN_STAY_LOGGED_OUT_LABELS = ['保持注销状态', 'Stay signed out'];
export const QWEN_CONVERSATION_MENU_LABELS = ['Chat Menu', '更多', '更多操作'];
export const QWEN_ARCHIVE_LABELS = ['归档', 'Archive'];
export const QWEN_ARCHIVE_CONFIRM_LABELS = ['确定', '确认', 'Archive', '归档'];
const SUBMISSION_RETRIES = 2;

async function unavailableWithEvidence({ tab, message, stage, uiEvidence, modelNames = [] }) {
  let uiEvidencePath;
  if (uiEvidence) {
    try {
      uiEvidencePath = await captureSemanticUiEvidence({
        tab,
        provider: 'Qwen',
        stage,
        acceptedNames: [
          ...QWEN_COMPOSER_NAMES,
        ...QWEN_NEW_CHAT_LABELS,
        ...QWEN_MODEL_CONTROL_NAMES,
        ...QWEN_ARCHIVE_LABELS,
        ...QWEN_ARCHIVE_CONFIRM_LABELS,
        ...QWEN_CONVERSATION_MENU_LABELS,
        ...QWEN_STAY_LOGGED_OUT_LABELS,
          ...modelNames,
          '发送',
          'Send',
          '停止',
          'Stop',
          '登录',
          'Sign in',
        ],
      });
    } catch {
      // Diagnostic capture is best-effort and must not broaden browser inspection.
    }
  }
  unavailable(message, { uiEvidencePath });
}

async function visibleLocators(locator) {
  const visible = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await locatorVisible(candidate)) visible.push(candidate);
  }
  return visible;
}

async function oneVisible(locator, message) {
  const visible = await visibleLocators(locator);
  if (visible.length !== 1) throw new Error(`${message}: visible_matches=${visible.length}`);
  return visible[0];
}

async function waitForConversationCleanupVerification({ tab, conversationMenu, previousUrl, timeoutMs = 10_000 }) {
  const conversationHref = `${previousUrl.pathname}${previousUrl.search}`;
  const candidateConversationLink = tab.playwright.locator(`a[href="${conversationHref}"]`);
  const conversationLink = candidateConversationLink && (await candidateConversationLink.count() === 1 ? candidateConversationLink : null);

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

function isConversationUrl(currentUrl, conversationMenuVisible = false) {
  return (
    currentUrl?.hostname === 'chat.qwen.ai'
    && (currentUrl.pathname !== '/' || Boolean(currentUrl.search) || conversationMenuVisible)
  );
}

async function findComposer(tab) {
  for (const name of QWEN_COMPOSER_NAMES) {
    const named = tab.playwright.getByRole('textbox', { name, exact: true });
    const visible = await visibleLocators(named);
    if (visible.length === 1) return visible[0];
    if (visible.length > 1) throw new Error(`Qwen composer is ambiguous: ${name}`);
  }
  return oneVisible(
    tab.playwright.locator('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'),
    'Qwen composer is unavailable',
  );
}

async function findMenuItem({ tab, names }) {
  const roles = ['menuitem', 'button'];
  for (const role of roles) {
    for (const name of names) {
      const controls = tab.playwright.getByRole(role, { name, exact: true });
      if (!controls?.count) continue;
      const visible = await visibleLocators(controls);
      if (visible.length === 1) return visible[0];
      if (visible.length > 1) {
        return null;
      }
    }
  }
  return null;
}

export async function archiveConversation({ tab, provider, uiEvidence = false }) {
  const currentUrl = new URL(await tab.url());
  const conversationMenu = await firstVisibleControl(tab, ['button'], QWEN_CONVERSATION_MENU_LABELS);
  if (!isConversationUrl(currentUrl, Boolean(conversationMenu))) {
    await unavailableWithEvidence({
      tab,
      message: `Qwen conversation URL is unavailable before cleanup: ${currentUrl.pathname}`,
      stage: 'conversation_cleanup_url_check',
      uiEvidence,
      modelNames: provider?.target?.models,
    });
  }

  const conversationHref = `${currentUrl.pathname}${currentUrl.search}`;
  const conversationLink = tab.playwright.locator(`a[href="${conversationHref}"]`);
  let resolvedConversationMenu = null;
  if (await locatorVisible(conversationLink)) {
    const byControl = conversationLink.getByRole && conversationLink.getByRole('button');
    if (byControl && await locatorVisible(byControl)) {
      resolvedConversationMenu = byControl;
    }
  }
  if (!resolvedConversationMenu) {
    resolvedConversationMenu = conversationMenu;
  }
  if (!resolvedConversationMenu) {
    await unavailableWithEvidence({
      tab,
      message: 'Qwen conversation menu is unavailable',
      stage: 'conversation_cleanup_menu_check',
      uiEvidence,
      modelNames: provider?.target?.models,
    });
  }

  await resolvedConversationMenu.click({ timeoutMs: 30_000 });
  const archiveItem = await findMenuItem({
    tab,
    names: QWEN_ARCHIVE_LABELS,
  });
  if (!archiveItem || !await locatorVisible(archiveItem)) {
    await unavailableWithEvidence({
      tab,
      message: 'Qwen conversation archive menu item is unavailable',
      stage: 'conversation_cleanup_archive_menu_item',
      uiEvidence,
      modelNames: provider?.target?.models,
    });
  }
  await archiveItem.click({ timeoutMs: 30_000 });

  const maybeConfirm = await findMenuItem({
    tab,
    names: QWEN_ARCHIVE_CONFIRM_LABELS,
  });
  if (maybeConfirm && await locatorVisible(maybeConfirm)) {
    await maybeConfirm.click({ timeoutMs: 30_000 });
  }

  const verification = await waitForConversationCleanupVerification({
    tab,
    conversationMenu,
    previousUrl: currentUrl,
    timeoutMs: 12_000,
  });
  if (!verification) {
    await unavailableWithEvidence({
      tab,
      message: 'Qwen conversation archive could not be confirmed',
      stage: 'conversation_cleanup_verification',
      uiEvidence,
      modelNames: provider?.target?.models,
    });
  }

  return {
    action: 'archive',
    confirmed: true,
    verification,
  };
}

async function firstVisibleControl(tab, roles, names) {
  for (const role of roles) {
    for (const name of names) {
      const controls = tab.playwright.getByRole(role, { name, exact: true });
      for (let index = 0; index < await controls.count(); index += 1) {
        const candidate = controls.nth(index);
        if (await locatorVisible(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function dismissAnonymousModal(tab) {
  const stayLoggedOut = await firstVisibleControl(tab, ['button'], QWEN_STAY_LOGGED_OUT_LABELS);
  if (stayLoggedOut) await stayLoggedOut.click({ timeoutMs: 10_000 });
}

async function hasVisibleConversationMessages(tab) {
  const messages = tab.playwright.locator('.response-message-content, .user-message-content, [class*="user-message-content"]');
  for (let index = 0; index < await messages.count(); index += 1) {
    if (await locatorVisible(messages.nth(index))) return true;
  }
  return false;
}

async function ensureFreshConversation({ tab, uiEvidence, modelNames }) {
  if (!await hasVisibleConversationMessages(tab)) return;
  try {
    const newChat = await firstVisibleControl(tab, ['button', 'link'], QWEN_NEW_CHAT_LABELS);
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
      message: `Qwen new-conversation recovery failed: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'fresh_conversation',
      uiEvidence,
      modelNames,
    });
  }
}

async function modelControl(tab) {
  return firstVisibleControl(tab, ['button'], QWEN_MODEL_CONTROL_NAMES);
}

async function currentModel(tab) {
  const control = await modelControl(tab);
  if (!control) return null;
  const label = String(await control.innerText({ timeoutMs: 10_000 })).replace(/\s+/g, ' ').trim();
  return label || null;
}

async function ensureModelMenuOpen(control) {
  if (await control.getAttribute('aria-expanded') !== 'true') {
    await control.click({ timeoutMs: 20_000 });
  }
}

async function selectCandidateModel(tab, control, modelName) {
  await ensureModelMenuOpen(control);
  const option = tab.playwright.getByRole('option', {
    name: new RegExp(`^${escapeRegex(modelName)}(?:\\s|$)`),
  });
  const candidates = await visibleLocators(option);
  if (candidates.length !== 1 || !await candidates[0].isEnabled()) return false;
  await candidates[0].click({ timeoutMs: 20_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await currentModel(tab) === modelName) return true;
    await tab.playwright.waitForTimeout(250);
  }
  return false;
}

export async function selectConfiguredModel({ provider, tab, continuation = false }) {
  const models = provider.target.models;
  const selected = await currentModel(tab);
  if (continuation && models.includes(selected)) {
    return { model: selected, fallbackUsed: selected === models[1], selectionSource: 'continuation' };
  }
  if (selected === models[0]) {
    return { model: selected, fallbackUsed: false, selectionSource: 'current' };
  }
  const control = await modelControl(tab);
  if (!control) throw new Error('model_control_not_found');
  for (let index = 0; index < models.length; index += 1) {
    if (await selectCandidateModel(tab, control, models[index])) {
      return { model: models[index], fallbackUsed: index === 1, selectionSource: 'menu' };
    }
  }
  throw new Error(`configured_models_unavailable:${models.join(',')}`);
}

function composerSettleTimeout(promptLength) {
  return promptLength >= 8_000 ? 120_000 : 20_000;
}

async function waitForSendReady(tab, timeoutMs) {
  const send = tab.playwright.getByRole('button', { name: /^(发送|Send)$/i });
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const visible = await visibleLocators(send);
    if (visible.length === 1 && await visible[0].isEnabled()) {
      stableSamples += 1;
      if (stableSamples >= 3) return visible[0];
    } else {
      stableSamples = 0;
    }
    await tab.playwright.waitForTimeout(250);
  }
  throw new Error(`send_control_not_ready_within_${timeoutMs}ms`);
}

async function waitForSubmissionProof({ composer, userMessages, previousUserMessageCount, tab, timeoutMs = 15_000 }) {
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

export async function run({ provider, tab, promptPath, timeoutMs = 180_000, continuation = false, uiEvidence = false, imagePaths = [] }) {
  if (!tab?.playwright || typeof tab.url !== 'function') throw new Error('a controlled Chrome tab is required');
  const currentUrl = new URL(await tab.url());
  if (!continuation || currentUrl.hostname !== 'chat.qwen.ai') {
    await tab.goto(provider.url);
    await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 30_000 });
  }
  await dismissAnonymousModal(tab);
  if (!continuation) await ensureFreshConversation({ tab, uiEvidence, modelNames: provider.target.models });

  let modelSelection;
  try {
    modelSelection = await selectConfiguredModel({ provider, tab, continuation });
  } catch (error) {
    await unavailableWithEvidence({
      tab,
      message: `Qwen model selection failed: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'model_selection',
      uiEvidence,
      modelNames: provider.target.models,
    });
  }

  let composer;
  try {
    composer = await findComposer(tab);
  } catch (error) {
    await unavailableWithEvidence({
      tab,
      message: `Qwen composer is unavailable: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'composer_check',
      uiEvidence,
      modelNames: provider.target.models,
    });
  }
  const answers = tab.playwright.locator('.response-message-content.phase-answer');
  const previousAnswerCount = await answers.count();
  const userMessages = tab.playwright.locator('.user-message-content, [class*="user-message-content"]');
  const previousUserMessageCount = await userMessages.count();
  let attachmentState = null;
  let promptRemoved;
  try {
    ({ promptRemoved } = await submitPromptFromFile({
      promptPath,
      submit: async promptText => {
        await composer.fill(promptText, { timeoutMs: 60_000 });
        await waitForComposerSettled({
          tab,
          composer,
          expectedTextLength: promptText.length,
          timeoutMs: composerSettleTimeout(promptText.length),
        });
        if (imagePaths.length) {
          attachmentState = await pasteProviderImages({ tab, provider: 'Qwen', imagePaths, composer });
        }
        const settleTimeoutMs = composerSettleTimeout(promptText.length);
        let submitted = false;
        for (let attempt = 0; attempt <= SUBMISSION_RETRIES && !submitted; attempt += 1) {
          const send = await waitForSendReady(tab, settleTimeoutMs);
          await send.click({ timeoutMs: 30_000 });
          submitted = await waitForSubmissionProof({ composer, userMessages, previousUserMessageCount, tab });
          if (!submitted && attempt < SUBMISSION_RETRIES) {
            await tab.playwright.waitForTimeout(1_000 * (attempt + 1));
          }
        }
        if (!submitted) throw new Error('submission_not_observed_after_two_retries');
      },
    }));
  } catch (error) {
    await unavailableWithEvidence({
      tab,
      message: `Qwen prompt submission failed: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'submit',
      uiEvidence,
      modelNames: provider.target.models,
    });
  }

  const answer = answers.nth(previousAnswerCount);
  const text = await waitForAssistantAnswer({
    answer,
    stopButtons: [tab.playwright.getByRole('button', { name: /停止|Stop/i })],
    timeoutMs,
  });
  return {
    provider: 'Qwen',
    model: modelSelection.model,
    canonicalModel: provider.target.canonical_models?.[modelSelection.model] || modelSelection.model,
    modelFallbackUsed: modelSelection.fallbackUsed,
    modelSelectionSource: modelSelection.selectionSource,
    promptRemoved,
    attachmentsReady: imagePaths.length > 0 ? attachmentState.ready : null,
    answer: text,
  };
}
