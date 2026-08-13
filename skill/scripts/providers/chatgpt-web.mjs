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

export async function run({ provider, tab, promptPath, timeoutMs = 180_000, continuation = false, uiEvidence = false }) {
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
    await runChatGptStageWithRecovery({
      tab,
      action: () => ensureFreshConversation({ tab, provider, uiEvidence }),
    });
    await runChatGptStageWithRecovery({
      tab,
      action: () => ensureChatMode({ tab, provider, uiEvidence, stage: 'initial_chat_mode' }),
    });
  }
  await runChatGptStageWithRecovery({
    tab,
    action: () => ensureCurrentConversationReady({ tab, provider, uiEvidence, stage: 'initial_recovery' }),
  });
  let selectedReasoning = await runChatGptStageWithRecovery({
    tab,
    action: () => ensureConfiguredReasoningSelection({ tab, provider, uiEvidence, stage: 'initial_reasoning_selection' }),
  });

  const answers = tab.playwright.getByRole('heading', { name: 'ChatGPT 说：', exact: true });
  const previousAnswerCount = await answers.count();
  const input = await runChatGptStageWithRecovery({
    tab,
    action: () => ensureCurrentConversationReady({ tab, provider, uiEvidence, stage: 'pre_submit_recovery' }),
  });
  const { promptRemoved } = await submitPromptFromFile({
    promptPath,
    submit: async promptText => {
      const composerSettleTimeout = chatGptComposerSettleTimeout(promptText.length);
      await runChatGptStageWithRecovery({
        tab,
        action: () => input.fill(promptText, { timeoutMs: Math.max(30_000, composerSettleTimeout) }),
      });
      await runChatGptStageWithRecovery({
        tab,
        action: () => waitForComposerSubmissionReadiness({
          tab,
          provider,
          uiEvidence,
          stage: 'post_fill_attachment_settle',
          promptLength: promptText.length,
        }),
      });
      selectedReasoning = await runChatGptStageWithRecovery({
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
          promptLength: promptText.length,
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
              message: `ChatGPT send control is unavailable: ${String(error?.message || error).slice(0, 180)}`,
              stage: 'send_preflight',
              provider,
              uiEvidence,
              names: ['发送提示', '与 ChatGPT 聊天', ...STRENGTH_TRIGGER_LABELS],
            });
          }
        },
      });
      try {
        // Intentionally outside the retry wrapper: once dispatch begins, never resend blindly.
        await send.click({ timeoutMs: 30_000 });
      } catch (error) {
        if (await recoverRateLimitAfterSubmit({ tab })) return;
        await unavailableWithEvidence({
          tab,
          message: `ChatGPT send control is unavailable: ${String(error?.message || error).slice(0, 180)}`,
          stage: 'submit',
          provider,
          uiEvidence,
          names: ['发送提示', '与 ChatGPT 聊天', ...STRENGTH_TRIGGER_LABELS],
        });
      }
    },
  });
  const assistantGroups = tab.playwright.locator('[data-message-author-role="assistant"]');
  const groupCount = await assistantGroups.count();
  const answer = groupCount > previousAnswerCount
    ? assistantGroups.nth(groupCount - 1)
    : tab.playwright.getByRole('main').getByText(/.+/).last();
  const text = await runChatGptStageWithRecovery({
    tab,
    action: () => waitForAssistantAnswer({
      answer,
      stopButtons: [tab.playwright.getByRole('button', { name: '停止回答', exact: true })],
      timeoutMs,
      checkInterrupted: async () => {
        if (!await locatorVisible(rateLimitDialog(tab))) return;
        await unavailableWithEvidence({
          tab,
          message: 'ChatGPT rate-limit popup interrupted answer wait',
          stage: 'answer_wait',
          provider,
          uiEvidence,
          names: ['停止回答', 'ChatGPT 说：'],
        });
      },
    }),
  });
  return {
    provider: 'ChatGPT',
    model: provider.target.model,
    reasoning: selectedReasoning.tier,
    reasoningLabel: selectedReasoning.label,
    reasoningSelectionSource: selectedReasoning.selectionSource,
    modelVerified: selectedReasoning.modelVerified,
    promptRemoved,
    answer: text,
  };
}
