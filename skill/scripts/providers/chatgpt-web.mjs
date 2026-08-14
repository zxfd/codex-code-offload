import { pasteProviderImages } from '../media-upload.mjs';

import {
  captureSemanticUiEvidence,
  locatorVisible,
  removeUiEvidenceArtifact,
  requireVisible,
  retryRecoverableStage,
  submitPromptFromFile,
  unavailable,
  waitForAssistantAnswer,
} from '../provider-utils.mjs';

// ChatGPT presently renders the highest tier as `Pro` in this UI.
// `最高` remains the canonical configuration value; the faster non-reasoning mode is excluded.
export const CHATGPT_REASONING_TIER_ORDER = ['最高', '极高', '高', '中'];
export const CHATGPT_STAGE_RECOVERY_RETRIES = 3;
export const CHATGPT_RATE_LIMIT_ACK_LABELS = ['好', '明白了', '确定', 'OK'];
const CHATGPT_RATE_LIMIT_DIALOG_NAMES = ['请求过于频繁', 'Too many requests'];
const TIER_LABELS = {
  '最高': ['最高', 'Pro'],
  '极高': ['极高'],
  '高': ['高'],
  '中': ['中'],
};
const STRENGTH_TRIGGER_LABELS = [...new Set([...Object.values(TIER_LABELS).flat(), '极速'])];
const COMPOSER_READY_POLL_MS = 750;
const LONG_PROMPT_CHARS = 8_000;
const SHORT_COMPOSER_SETTLE_MS = 20_000;
const LONG_COMPOSER_SETTLE_MS = 120_000;
const POST_FILL_STRENGTH_RETRY_MS = 10_000;
const NEW_CHAT_LABELS = ['新聊天', 'New chat'];
const CHATGPT_STOP_GENERATION_LABELS = ['停止回答', 'Stop generating', 'Stop generating response'];
const CHATGPT_MORE_LABELS = ['更多', 'More'];
const CHATGPT_ARCHIVE_LABELS = ['归档', 'Archive'];

const CHATGPT_TWO_STEP_MIN_CHARS = 4_000;
const CONTEXT_SECTION_HEADERS = ['CODE_CONTEXT', 'DOCUMENT_CONTEXT', 'ADDITIONAL_CONTEXT'];

export function chatGptComposerSettleTimeout(promptLength) {
  return Number(promptLength || 0) >= LONG_PROMPT_CHARS
    ? LONG_COMPOSER_SETTLE_MS
    : SHORT_COMPOSER_SETTLE_MS;
}

async function unavailableWithEvidence({ tab, message, stage, provider, uiEvidence, names }) {
  let uiEvidencePath;
  if (uiEvidence) {
    try {
      uiEvidencePath = await captureSemanticUiEvidence({
        tab,
        provider: 'ChatGPT',
        stage,
        acceptedNames: [
          ...(names || []),
          ...CHATGPT_RATE_LIMIT_DIALOG_NAMES,
          ...CHATGPT_RATE_LIMIT_ACK_LABELS,
        ],
      });
    } catch {
      // Bounded diagnostic capture must not broaden browser inspection.
    }
  }
  unavailable(message, { uiEvidencePath });
}

async function exactlyOneVisible(locator, message) {
  const visible = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await locatorVisible(candidate)) visible.push(candidate);
  }
  if (visible.length !== 1) throw new Error(`${message}: visible_matches=${visible.length}`);
  return visible[0];
}

async function firstVisibleNamedControl({ tab, role, names, message }) {
  for (const name of names) {
    const locator = tab.playwright.getByRole(role, { name, exact: true });
    const visible = [];
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await locatorVisible(candidate)) visible.push(candidate);
    }
    if (visible.length > 1) throw new Error(`${message}: ${name} visible_matches=${visible.length}`);
    if (visible.length === 1) return { label: name, locator: visible[0] };
  }
  return null;
}

function normalizeControlText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function exactlyOneVisibleMenuItemText({ tab, text, message }) {
  const menuItems = tab.playwright.locator('[role="menuitem"]');
  const matches = [];
  for (let index = 0; index < await menuItems.count(); index += 1) {
    const candidate = menuItems.nth(index);
    if (await locatorVisible(candidate) && normalizeControlText(await candidate.innerText({ timeoutMs: 5_000 })) === text) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) throw new Error(`${message}: visible_matches=${matches.length}`);
  return matches[0];
}

async function exactlyOneVisibleReasoningMenu({ tab, message }) {
  const menuItems = tab.playwright.locator('[role="menuitem"]');
  const matches = [];
  for (let index = 0; index < await menuItems.count(); index += 1) {
    const candidate = menuItems.nth(index);
    const text = normalizeControlText(await candidate.innerText({ timeoutMs: 5_000 }));
    if (await locatorVisible(candidate) && /^思考强度 (?:最高|Pro|极高|高|中)$/u.test(text)) matches.push(candidate);
  }
  if (matches.length !== 1) throw new Error(`${message}: visible_matches=${matches.length}`);
  return matches[0];
}

function configuredReasoningTiers(provider) {
  const configured = provider.target.reasoning_tiers;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error('ChatGPT reasoning_tiers must be a non-empty array');
  }
  const tiers = [...new Set(configured)];
  if (tiers.some(tier => !CHATGPT_REASONING_TIER_ORDER.includes(tier))) {
    throw new Error(`ChatGPT has an unsupported reasoning tier: ${tiers.join(', ')}`);
  }
  return CHATGPT_REASONING_TIER_ORDER.filter(tier => tiers.includes(tier));
}

export async function currentAllowedReasoningSelection({ tab, provider }) {
  const tiers = configuredReasoningTiers(provider);
  try {
    for (const tier of tiers) {
      const match = await firstVisibleNamedControl({
        tab,
        role: 'button',
        names: TIER_LABELS[tier],
        message: `ChatGPT current reasoning trigger is ambiguous: ${tier}`,
      });
      if (match) return { tier, label: match.label, unavailableTiers: [], selectionSource: 'current', modelVerified: false };
    }
  } catch {
    // Fall through to the bounded DOM keyword probe below.
  }
  const labels = [...new Set(tiers.flatMap(tier => TIER_LABELS[tier]))];
  const matchedLabel = await tab.playwright.evaluate(({ allowedLabels }) => {
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const matchesLabel = (value, label) => value === label || value === `思考强度 ${label}`;
    const matches = new Set();
    for (const element of document.querySelectorAll('button, [role="button"]')) {
      if (!visible(element)) continue;
      const values = [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
        .map(normalize)
        .filter(Boolean);
      for (const label of allowedLabels) {
        if (values.some(value => matchesLabel(value, label))) matches.add(label);
      }
    }
    return matches.size === 1 ? [...matches][0] : null;
  }, { allowedLabels: labels });
  if (!matchedLabel) return null;
  const tier = tiers.find(candidate => TIER_LABELS[candidate].includes(matchedLabel));
  return tier ? { tier, label: matchedLabel, unavailableTiers: [], selectionSource: 'current', modelVerified: false } : null;
}

async function keepCurrentAllowedSelection({ tab, provider }) {
  const selectedReasoning = await currentAllowedReasoningSelection({ tab, provider });
  return selectedReasoning;
}

async function waitForCurrentAllowedSelection({ tab, provider, retryMs = 0 }) {
  const deadline = Date.now() + retryMs;
  do {
    const current = await keepCurrentAllowedSelection({ tab, provider });
    if (current) return current;
    if (Date.now() >= deadline) return null;
    await tab.playwright.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

async function hasVisibleConversationMessages(tab) {
  const main = tab.playwright.getByRole('main');
  const messageSelectors = [
    '[data-message-author-role="assistant"]',
    '[data-message-author-role="user"]',
  ];
  for (const selector of messageSelectors) {
    const messages = main.locator(selector);
    for (let index = 0; index < await messages.count(); index += 1) {
      if (await locatorVisible(messages.nth(index))) return true;
    }
  }
  const assistantHeadings = main.getByRole('heading', { name: 'ChatGPT 说：', exact: true });
  return locatorVisible(assistantHeadings);
}

async function firstVisibleNewChatControl(tab) {
  for (const role of ['link', 'button']) {
    for (const name of NEW_CHAT_LABELS) {
      const controls = tab.playwright.getByRole(role, { name, exact: true });
      for (let index = 0; index < await controls.count(); index += 1) {
        const candidate = controls.nth(index);
        if (await locatorVisible(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function ensureFreshConversation({ tab, provider, uiEvidence }) {
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
      message: `ChatGPT new-conversation recovery failed: ${String(error?.message || error).slice(0, 180)}`,
      stage: 'fresh_conversation',
      provider,
      uiEvidence,
      names: [...NEW_CHAT_LABELS, '与 ChatGPT 聊天'],
    });
  }
}

async function ensureChatMode({ tab, provider, uiEvidence, stage }) {
  try {
    const chat = await exactlyOneVisible(
      tab.playwright.getByRole('radio', { name: '聊天', exact: true }),
      'ChatGPT chat-mode control is unavailable',
    );
    if (await chat.getAttribute('aria-checked') !== 'true') {
      await chat.click({ timeoutMs: 30_000 });
      await tab.playwright.waitForTimeout(250);
    }
    if (await chat.getAttribute('aria-checked') !== 'true') throw new Error('chat_mode_not_selected');
  } catch (error) {
    await unavailableWithEvidence({
      tab,
      message: `ChatGPT chat-mode selection failed: ${String(error?.message || error).slice(0, 180)}`,
      stage,
      provider,
      uiEvidence,
      names: ['聊天'],
    });
  }
}

function rateLimitDialog(tab) {
  return tab.playwright.getByRole('dialog', { name: /^(?:请求过于频繁|Too many requests)$/iu });
}

async function firstVisibleRateLimitAcknowledgement(rateLimit) {
  for (const label of CHATGPT_RATE_LIMIT_ACK_LABELS) {
    const buttons = rateLimit.getByRole('button', { name: label, exact: true });
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (await locatorVisible(button)) return { label, button };
    }
  }
  return null;
}

export async function recoverRateLimit({ tab }) {
  const rateLimit = rateLimitDialog(tab);
  if (!await locatorVisible(rateLimit)) {
    return { present: false, dismissed: false, acknowledgement: null };
  }
  const acknowledgement = await firstVisibleRateLimitAcknowledgement(rateLimit);
  if (!acknowledgement) {
    return { present: true, dismissed: false, acknowledgement: null };
  }
  try {
    await acknowledgement.button.click({ timeoutMs: 10_000 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && await locatorVisible(rateLimit)) {
      await tab.playwright.waitForTimeout(250);
    }
  } catch {
    // The dialog may have closed while the click was being dispatched.
  }
  return {
    present: true,
    dismissed: !await locatorVisible(rateLimit),
    acknowledgement: acknowledgement.label,
  };
}

function discardRecoveredEvidence(error) {
  if (!error?.uiEvidencePath) return;
  try {
    removeUiEvidenceArtifact(error.uiEvidencePath);
  } catch {
    // Evidence is best-effort and may already have been consumed or removed.
  }
}

async function runChatGptStageWithRecovery({ tab, action }) {
  return retryRecoverableStage({
    action,
    retries: CHATGPT_STAGE_RECOVERY_RETRIES,
    recover: async () => (await recoverRateLimit({ tab })).dismissed,
    onBeforeRetry: ({ error }) => discardRecoveredEvidence(error),
  });
}

async function recoverRateLimitAfterSubmit({ tab }) {
  for (let retry = 0; retry < CHATGPT_STAGE_RECOVERY_RETRIES; retry += 1) {
    const recovery = await recoverRateLimit({ tab });
    if (!recovery.present) return retry > 0;
    if (recovery.dismissed) return true;
    await tab.playwright.waitForTimeout(250);
  }
  return false;
}

async function ensureCurrentConversationReady({ tab, provider, uiEvidence, stage }) {
  const rateLimit = rateLimitDialog(tab);
  const input = tab.playwright.getByRole('textbox', { name: '与 ChatGPT 聊天', exact: true });
  if (await locatorVisible(rateLimit) || !await locatorVisible(input) || !await input.isEnabled()) {
    await unavailableWithEvidence({
      tab,
      message: 'ChatGPT current conversation input is unavailable',
      stage,
      provider,
      uiEvidence,
      names: ['请求过于频繁', '与 ChatGPT 聊天', ...CHATGPT_REASONING_TIER_ORDER],
    });
  }
  return input;
}

async function waitForComposerSubmissionReadiness({ tab, provider, uiEvidence, stage, promptLength }) {
  const input = tab.playwright.getByRole('textbox', { name: '与 ChatGPT 聊天', exact: true });
  const send = tab.playwright.getByRole('button', { name: '发送提示', exact: true });
  const rateLimit = rateLimitDialog(tab);
  const deadline = Date.now() + chatGptComposerSettleTimeout(promptLength);
  while (Date.now() < deadline) {
    if (await locatorVisible(rateLimit)) {
      await unavailableWithEvidence({
        tab,
        message: 'ChatGPT rate-limit popup interrupted composer readiness',
        stage: 'rate_limit_popup_during_composer_settle',
        provider,
        uiEvidence,
        names: ['发送提示', '与 ChatGPT 聊天', ...STRENGTH_TRIGGER_LABELS],
      });
    }
    if (
      await locatorVisible(input)
      && await input.isEnabled()
      && await locatorVisible(send)
      && await send.isEnabled()
    ) {
      return send;
    }
    await tab.playwright.waitForTimeout(COMPOSER_READY_POLL_MS);
  }
  await unavailableWithEvidence({
    tab,
    message: `ChatGPT composer did not become ready within ${chatGptComposerSettleTimeout(promptLength)}ms`,
    stage,
    provider,
    uiEvidence,
    names: ['请求过于频繁', '明白了', '发送提示', '与 ChatGPT 聊天', ...STRENGTH_TRIGGER_LABELS],
  });
}

async function optionIsDisabled(option) {
  return (await option.getAttribute('disabled')) !== null
    || (await option.getAttribute('aria-disabled')) === 'true'
    || (await option.getAttribute('data-disabled')) !== null
    || !await option.isEnabled();
}

async function selectBestAvailableReasoningTier({ tab, provider, uiEvidence, stage }) {
  const tiers = configuredReasoningTiers(provider);
  try {
    const strengthTrigger = await firstVisibleNamedControl({
      tab,
      role: 'button',
      names: STRENGTH_TRIGGER_LABELS,
      message: 'ChatGPT model-selection control is ambiguous',
    });
    if (!strengthTrigger) throw new Error('model_selection_control_not_found');
    await strengthTrigger.locator.click({ timeoutMs: 30_000 });
    await tab.playwright.waitForTimeout(250);

    const advancedMenu = tab.playwright.locator('[role="menuitem"][aria-label="显示高级选项"], [role="menuitem"][aria-label="显示精简选项"]');
    await advancedMenu.waitFor({ state: 'visible', timeoutMs: 5_000 });
    const advanced = await exactlyOneVisible(
      advancedMenu,
      'ChatGPT advanced menu is unavailable',
    );
    await advanced.click({ timeoutMs: 30_000 });
    await tab.playwright.waitForTimeout(150);

    await exactlyOneVisibleMenuItemText({
      tab,
      text: `模型 ${provider.target.model}`,
      message: `ChatGPT target model cannot be confirmed: ${provider.target.model}`,
    });
    const reasoning = await exactlyOneVisibleReasoningMenu({
      tab,
      message: 'ChatGPT reasoning-strength menu is unavailable',
    });
    await reasoning.click({ timeoutMs: 30_000 });
    await tab.playwright.waitForTimeout(250);
    await requireVisible(tab.playwright.getByRole('menuitemradio'), 'ChatGPT reasoning-strength options are unavailable');

    const unavailableTiers = [];
    for (const tier of tiers) {
      const option = await firstVisibleNamedControl({
        tab,
        role: 'menuitemradio',
        names: TIER_LABELS[tier],
        message: `ChatGPT reasoning tier is ambiguous: ${tier}`,
      });
      if (!option) {
        unavailableTiers.push(`${tier}:missing`);
        continue;
      }
      if (await optionIsDisabled(option.locator)) {
        unavailableTiers.push(`${tier}:disabled`);
        continue;
      }
      await option.locator.click({ timeoutMs: 30_000 });
      await tab.playwright.waitForTimeout(250);
      const selectedTrigger = await firstVisibleNamedControl({
        tab,
        role: 'button',
        names: [option.label],
        message: `ChatGPT selected reasoning trigger is ambiguous: ${tier}`,
      });
      if (!selectedTrigger) throw new Error(`selected_reasoning_not_confirmed:${tier}`);
      return { tier, label: option.label, unavailableTiers, selectionSource: 'changed', modelVerified: true };
    }
    throw new Error(`no_usable_reasoning_tier:${unavailableTiers.join(',')}`);
  } catch (error) {
    if (error?.code === 'PROVIDER_UNAVAILABLE') throw error;
    await unavailableWithEvidence({
      tab,
      message: `ChatGPT model/reasoning selection failed: ${String(error?.message || error).slice(0, 240)}`,
      stage,
      provider,
      uiEvidence,
      names: ['聊天', '高级', `模型 ${provider.target.model}`, '思考强度', ...STRENGTH_TRIGGER_LABELS],
    });
  }
}

async function ensureConfiguredReasoningSelection({ tab, provider, uiEvidence, stage, currentSelectionRetryMs = 0 }) {
  const current = await waitForCurrentAllowedSelection({ tab, provider, retryMs: currentSelectionRetryMs });
  if (current) return current;
  return selectBestAvailableReasoningTier({ tab, provider, uiEvidence, stage });
}

function splitChatGptContext(promptText) {
  const nl = String.fromCharCode(10);
  let start = -1;
  let end = -1;
  for (const header of CONTEXT_SECTION_HEADERS) {
    const marker = nl + nl + header + ':' + nl;
    const index = promptText.indexOf(marker);
    if (index !== -1 && (start === -1 || index < start)) {
      start = index;
      end = index + marker.length;
    }
  }
  if (start === -1) return { instruction: promptText, context: '' };
  return {
    instruction: promptText.slice(0, start).trim(),
    context: promptText.slice(end).trim(),
  };
}

async function submitChatGptComposer({ tab, provider, uiEvidence, input, text, onSendStarted }) {
  const composerSettleTimeout = chatGptComposerSettleTimeout(text.length);
  await runChatGptStageWithRecovery({
    tab,
    action: () => input.fill(text, { timeoutMs: Math.max(30_000, composerSettleTimeout) }),
  });
  await runChatGptStageWithRecovery({
    tab,
    action: () => waitForComposerSubmissionReadiness({
      tab,
      provider,
      uiEvidence,
      stage: 'post_fill_attachment_settle',
      promptLength: text.length,
    }),
  });
  const reasoning = await runChatGptStageWithRecovery({
    tab,
    action: () => ensureConfiguredReasoningSelection({
      tab,
      provider,
      uiEvidence,
      stage: 'final_pre_submit_reasoning_selection',
      currentSelectionRetryMs: POST_FILL_STRENGTH_RETRY_MS,
    }),
  });
  const send = await runChatGptStageWithRecovery({
    tab,
    action: () => waitForComposerSubmissionReadiness({
      tab,
      provider,
      uiEvidence,
      stage: 'final_pre_submit_settle',
      promptLength: text.length,
    }),
  });
  await runChatGptStageWithRecovery({
    tab,
    action: async () => {
      if (await locatorVisible(rateLimitDialog(tab))) {
        await unavailableWithEvidence({
          tab,
          message: 'ChatGPT rate-limit popup interrupted send preflight',
          stage: 'send_preflight',
          provider,
          uiEvidence,
          names: ['发送提示', '与 ChatGPT 聊天', ...STRENGTH_TRIGGER_LABELS],
        });
      }
      try {
        await requireVisible(send, 'ChatGPT send control is unavailable');
        if (!await send.isEnabled()) throw new Error('send control is disabled');
      } catch (error) {
        if (error?.code === 'PROVIDER_UNAVAILABLE') throw error;
        await unavailableWithEvidence({
          tab,
          message: 'ChatGPT send control is unavailable: ' + String(error?.message || error).slice(0, 180),
          stage: 'send_preflight',
          provider,
          uiEvidence,
          names: ['发送提示', '与 ChatGPT 聊天', ...STRENGTH_TRIGGER_LABELS],
        });
      }
    },
  });
  // A browser click can time out after the event has already reached ChatGPT.
  // Mark the request before dispatch and reconcile through the response watcher;
  // never turn an ambiguous click into a blind second send.
  if (typeof onSendStarted === 'function') onSendStarted();
  try {
    await send.click({ timeoutMs: 30_000 });
  } catch (error) {
    // The click outcome is ambiguous. A successful user message/assistant turn
    // observed by waitForNextAssistantAnswer is the only authority after this
    // point. Recover a visible rate-limit dialog, but never click send again.
    await recoverRateLimitAfterSubmit({ tab });
  }
  return reasoning;
}

export async function locateNewAssistantAnswer({ tab, previousGroupCount, timeoutMs = 180_000, pollMs = 300, checkInterrupted }) {
  const assistantGroups = tab.playwright.locator('[data-message-author-role="assistant"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (typeof checkInterrupted === 'function') await checkInterrupted();
    const count = await assistantGroups.count();
    if (count > previousGroupCount) return assistantGroups.nth(count - 1);
    await tab.playwright.waitForTimeout(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error('ChatGPT did not create a new assistant message for this request');
}

export async function waitForNextAssistantAnswer({ tab, previousGroupCount, timeoutMs, checkInterrupted }) {
  const startedAt = Date.now();
  const answer = await locateNewAssistantAnswer({ tab, previousGroupCount, timeoutMs, checkInterrupted });
  return waitForAssistantAnswer({
    answer,
    stopButtons: CHATGPT_STOP_GENERATION_LABELS.map(name => tab.playwright.getByRole('button', { name, exact: true })),
    timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - startedAt)),
    checkInterrupted,
  });
}

async function conversationLinkIsVisible({ tab, pathname }) {
  const links = tab.playwright.locator('a');
  for (let index = 0; index < await links.count(); index += 1) {
    const link = links.nth(index);
    if (!await locatorVisible(link)) continue;
    const href = await link.getAttribute('href', { timeoutMs: 5_000 });
    if (href === pathname || href === `https://chatgpt.com${pathname}`) return true;
  }
  return false;
}

async function findVisibleMenuItemByNames({ tab, names, message }) {
  for (const name of names) {
    const locator = tab.playwright.getByRole('menuitem', { name, exact: true });
    const visible = [];
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await locatorVisible(candidate)) visible.push(candidate);
    }
    if (visible.length > 1) throw new Error(`${message}: ${name} visible_matches=${visible.length}`);
    if (visible.length === 1) return visible[0];
  }
  throw new Error(`${message}: visible_matches=0`);
}

async function recoverRateLimitBeforeArchive({ tab }) {
  for (let retry = 0; retry < CHATGPT_STAGE_RECOVERY_RETRIES; retry += 1) {
    const recovery = await recoverRateLimit({ tab });
    if (!recovery.present || recovery.dismissed) return recovery;
    await tab.playwright.waitForTimeout(250);
  }
  return { present: true, dismissed: false, acknowledgement: null };
}

export async function isChatGptAnswerGenerating({ tab }) {
  const stopButtons = CHATGPT_STOP_GENERATION_LABELS.map(name => (
    tab.playwright.getByRole('button', { name, exact: true })
  ));
  return (await Promise.all(stopButtons.map(locatorVisible))).some(Boolean);
}

export async function archiveConversation({ tab, provider, uiEvidence = false }) {
  const currentUrl = new URL(await tab.url());
  if (!currentUrl.pathname.startsWith('/c/')) {
    await unavailableWithEvidence({
      tab,
      message: `ChatGPT conversation URL is unavailable before archive: ${currentUrl.pathname}`,
      stage: 'conversation_archive_url_check',
      provider,
      uiEvidence,
      names: [...CHATGPT_MORE_LABELS, ...CHATGPT_ARCHIVE_LABELS],
    });
  }

  try {
    await runChatGptStageWithRecovery({
      tab,
      action: async () => {
        const more = await firstVisibleNamedControl({
          tab,
          role: 'button',
          names: CHATGPT_MORE_LABELS,
          message: 'ChatGPT conversation menu is ambiguous',
        });
        if (!more) throw new Error('conversation_more_control_not_found');
        await more.locator.click({ timeoutMs: 30_000 });
        const archive = await findVisibleMenuItemByNames({
          tab,
          names: CHATGPT_ARCHIVE_LABELS,
          message: 'ChatGPT archive menu item is unavailable',
        });
        await archive.click({ timeoutMs: 30_000 });
      },
    });

    // A rate-limit dialog can appear immediately after the archive click. It
    // is safe to dismiss and continue; this path never reloads the page.
    const rateLimitRecovery = await recoverRateLimitBeforeArchive({ tab });
    if (rateLimitRecovery.present && !rateLimitRecovery.dismissed) {
      throw new Error('conversation_archive_rate_limit_unresolved');
    }
    const archiveMenu = tab.playwright.getByRole('menuitem', { name: CHATGPT_ARCHIVE_LABELS[0], exact: true });
    if (await locatorVisible(archiveMenu)) throw new Error('conversation_archive_menu_did_not_close');
    const stillListed = await conversationLinkIsVisible({ tab, pathname: currentUrl.pathname });
    return {
      action: 'archive',
      confirmed: true,
      verification: stillListed ? 'archive_menu_closed_without_reload' : 'sidebar_link_absent_without_reload',
    };
  } catch (error) {
    if (error?.code === 'PROVIDER_UNAVAILABLE') throw error;
    await unavailableWithEvidence({
      tab,
      message: `ChatGPT conversation archive failed: ${String(error?.message || error).slice(0, 240)}`,
      stage: 'conversation_archive',
      provider,
      uiEvidence,
      names: [...CHATGPT_MORE_LABELS, ...CHATGPT_ARCHIVE_LABELS],
    });
  }
}

export async function run({ provider, tab, promptPath, timeoutMs = 180_000, continuation = false, uiEvidence = false, imagePaths = [] }) {
  if (!tab?.playwright || typeof tab.url !== 'function') throw new Error('a controlled Browser tab is required');
  const currentUrl = new URL(await tab.url());
  if (!continuation || currentUrl.hostname !== 'chatgpt.com') {
    await tab.goto(provider.url);
    await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 30_000 });
  }
  const login = tab.playwright.getByRole('button', { name: '登录', exact: true });
  if (await locatorVisible(login)) {
    await unavailableWithEvidence({ tab, message: 'ChatGPT login is required', stage: 'login_check', provider, uiEvidence, names: ['登录'] });
  }
  if (!continuation) {
    await runChatGptStageWithRecovery({ tab, action: () => ensureFreshConversation({ tab, provider, uiEvidence }) });
    await runChatGptStageWithRecovery({ tab, action: () => ensureChatMode({ tab, provider, uiEvidence, stage: 'initial_chat_mode' }) });
  }
  await runChatGptStageWithRecovery({ tab, action: () => ensureCurrentConversationReady({ tab, provider, uiEvidence, stage: 'initial_recovery' }) });
  let selectedReasoning = await runChatGptStageWithRecovery({ tab, action: () => ensureConfiguredReasoningSelection({ tab, provider, uiEvidence, stage: 'initial_reasoning_selection' }) });

  const assistantGroups = tab.playwright.locator('[data-message-author-role="assistant"]');
  let previousGroupCount = await assistantGroups.count();
  let sendStarted = false;
  let answerRateLimitRecoveries = 0;
  const input = await runChatGptStageWithRecovery({ tab, action: () => ensureCurrentConversationReady({ tab, provider, uiEvidence, stage: 'pre_submit_recovery' }) });
  const attachmentState = imagePaths.length
    ? await pasteProviderImages({ tab, provider: 'ChatGPT', imagePaths, composer: input })
    : null;

  const checkInterrupted = async () => {
    if (!await locatorVisible(rateLimitDialog(tab))) return;
    if (sendStarted) {
      // A rate-limit dialog can coexist with an answer that is still being
      // rendered. Keep waiting in that state; dismissing it can interrupt the
      // active generation and turn a slow but valid response into a fallback.
      if (await isChatGptAnswerGenerating({ tab })) return;
      if (answerRateLimitRecoveries < CHATGPT_STAGE_RECOVERY_RETRIES) {
        answerRateLimitRecoveries += 1;
        await recoverRateLimit({ tab });
      }
      // After dispatch, a rate-limit dialog can coexist with the response that
      // is already being rendered. Dismiss it when possible, but do not turn an
      // unacknowledgeable dialog into an immediate fallback; the request-level
      // assistant watcher is the authority and will accept the new answer.
      return;
    }
    await unavailableWithEvidence({
      tab,
      message: 'ChatGPT rate-limit popup interrupted answer wait',
      stage: 'answer_wait',
      provider,
      uiEvidence,
      names: ['停止回答', 'ChatGPT 说：'],
    });
  };

  const markPostSendFailure = error => {
    if (sendStarted) {
      error.cacheFailure = false;
      error.sendStarted = true;
      error.failureClass = 'post_send_response_unconfirmed';
    }
    return error;
  };
  const markSendStarted = () => {
    sendStarted = true;
    answerRateLimitRecoveries = 0;
  };

  let promptRemoved;
  try {
    ({ promptRemoved } = await submitPromptFromFile({
      promptPath,
      submit: async promptText => {
        const split = splitChatGptContext(promptText);
        const useTwoStep = Boolean(split.context) && promptText.length >= CHATGPT_TWO_STEP_MIN_CHARS;
        if (useTwoStep) {
          selectedReasoning = await submitChatGptComposer({ tab, provider, uiEvidence, input, text: split.context, onSendStarted: markSendStarted });
          await runChatGptStageWithRecovery({
            tab,
            action: () => waitForNextAssistantAnswer({ tab, previousGroupCount, timeoutMs: Math.min(timeoutMs, 120_000), checkInterrupted }),
          });
          previousGroupCount = await assistantGroups.count();
          selectedReasoning = await submitChatGptComposer({ tab, provider, uiEvidence, input, text: split.instruction, onSendStarted: markSendStarted });
        } else {
          selectedReasoning = await submitChatGptComposer({ tab, provider, uiEvidence, input, text: promptText, onSendStarted: markSendStarted });
        }
      },
    }));
  } catch (error) {
    throw markPostSendFailure(error);
  }

  let text;
  try {
    text = await runChatGptStageWithRecovery({
      tab,
      action: () => waitForNextAssistantAnswer({ tab, previousGroupCount, timeoutMs, checkInterrupted }),
    });
  } catch (error) {
    // Once any send was dispatched, this is not a provider-availability fact.
    // Avoid poisoning the health cache and causing repeated false fallbacks.
    throw markPostSendFailure(error);
  }

  return {
    provider: 'ChatGPT',
    model: provider.target.model,
    reasoning: selectedReasoning.tier,
    reasoningLabel: selectedReasoning.label,
    reasoningSelectionSource: selectedReasoning.selectionSource,
    modelVerified: selectedReasoning.modelVerified,
    responseConfirmed: true,
    responseConfirmation: 'new_assistant_message',
    promptRemoved,
    attachmentsReady: imagePaths.length > 0 ? attachmentState.ready : null,
    answer: text,
  };
}
