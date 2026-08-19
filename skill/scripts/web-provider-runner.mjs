import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ProviderUnavailableError,
  DEFAULT_PROVIDER_ANSWER_TIMEOUT_MS,
  makeAttemptPrompt,
  removeUiEvidenceArtifact,
  removePrompt,
  validatePromptPath,
} from './provider-utils.mjs';
import { validateImagePaths } from './media-upload.mjs';
import {
  assertConfirmedAssistantResponse,
  markStructuredJsonAvailable,
} from './provider-response.mjs';

const OFFLOAD_HOME = (typeof process !== 'undefined' && process.env && process.env.CODEX_CODE_OFFLOAD_HOME) || join(homedir(), '.local', 'share', 'codex-code-offload');
const DEFAULT_CONFIG_PATH = join(OFFLOAD_HOME, 'providers.json');
const DEFAULT_STATE_DIR = join(homedir(), '.local', 'state', 'codex-web-reasoning');
const HEALTH_FAILURE_PROTOCOL_VERSION = 2;
const ADAPTERS = {
  'chatgpt-web': './providers/chatgpt-web.mjs',
  'deepseek-web': './providers/deepseek-web.mjs',
  'qwen-web': './providers/qwen-web.mjs',
  'gemini-web': './providers/gemini-web.mjs',
};
const RUNNER_SOURCE_URL = new URL(import.meta.url);
RUNNER_SOURCE_URL.search = '';
RUNNER_SOURCE_URL.hash = '';
const RUNNER_LOADED_MTIME_MS = statSync(RUNNER_SOURCE_URL).mtimeMs;

const DEFAULT_MODALITY = 'text';
export const SYSTEM_CLIPBOARD_TEXT_TRANSPORT = 'system_clipboard';
const MAX_SYSTEM_CLIPBOARD_BYTES = 2_000_000;
const MAX_CLIPBOARD_INSTRUCTION_CHARS = 4_000;
const STRUCTURED_RESPONSE_FORMAT_RETRY_PROMPT = [
  '上一次回答未通过严格的 JSON 解析。',
  '请只返回一个完整、裸的 JSON 对象，使用 JSON.stringify 风格；不得输出 Markdown、code fence 或任何说明。',
  '保留原任务要求的 source_url、extraction_summary、data.target 和 data.selector；整个 JSON 对象必须压缩为单行，所有字符串值必须单行，禁止直接换行、制表符或其他控制字符；字符串中的引号、反斜杠和换行必须按 JSON 正确转义。',
].join('\n');

function isStructuredResponseFormatRetryable(error) {
  return error?.code === 'STRUCTURED_RESPONSE_INVALID'
    && error?.failureClass === 'structured_response_invalid'
    && error?.formatRetryable === true;
}

async function validateStructuredResponse({ responseValidator, rawResult, requestId, providerId, provider, requestMetadata }) {
  let structuredResult;
  try {
    structuredResult = await responseValidator({
      answer: rawResult.answer,
      result: rawResult,
      requestId,
      providerId,
      provider,
      requestMetadata,
    });
  } catch (error) {
    if (error?.code === 'STRUCTURED_RESPONSE_INVALID') throw error;
    const validationError = new Error('structured response validation failed');
    validationError.code = 'STRUCTURED_RESPONSE_INVALID';
    validationError.cacheFailure = false;
    validationError.sendStarted = true;
    validationError.failureClass = 'structured_response_invalid';
    throw validationError;
  }
  const result = markStructuredJsonAvailable(rawResult, structuredResult);
  assertConfirmedAssistantResponse(result);
  return result;
}

export function loadProviderConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (![2, 3].includes(config.version) || !config.providers) {
    throw new Error('invalid Web Reasoning provider configuration');
  }
  if (config.version === 2 && !Array.isArray(config.priority)) throw new Error('invalid Web Reasoning provider configuration');
  if (config.version === 3 && (!config.routes || typeof config.routes !== 'object')) {
    throw new Error('Web Reasoning version 3 requires routes');
  }
  if (config.health_ttl_seconds !== undefined && (!Number.isFinite(config.health_ttl_seconds) || config.health_ttl_seconds <= 0)) {
    throw new Error('health_ttl_seconds must be a positive number');
  }
  const configuredRoutes = config.version === 3
    ? Object.values(config.routes).map(route => route?.priority || [])
    : [config.priority];
  for (const providerIds of configuredRoutes) {
    if (!Array.isArray(providerIds) || providerIds.length === 0) throw new Error('Web Reasoning route priority must be non-empty');
    for (const providerId of providerIds) {
    const provider = config.providers[providerId];
    if (!provider || !ADAPTERS[provider.adapter] || !provider.url || !provider.target) {
      throw new Error(`invalid provider configuration: ${providerId}`);
    }
    if (provider.adapter === 'chatgpt-web' && (!Array.isArray(provider.target.reasoning_tiers) || provider.target.reasoning_tiers.length === 0)) {
      throw new Error(`ChatGPT provider requires reasoning_tiers: ${providerId}`);
    }
    if (provider.adapter === 'qwen-web' && (
      !Array.isArray(provider.target.models)
      || provider.target.models.length !== 2
      || provider.target.models.some(model => typeof model !== 'string' || !model.trim())
    )) {
      throw new Error(`Qwen provider requires exactly one primary model and one fallback model: ${providerId}`);
    }
    if (provider.target.max_input_tokens !== undefined && (!Number.isSafeInteger(provider.target.max_input_tokens) || provider.target.max_input_tokens <= 0)) {
      throw new Error(`provider max_input_tokens must be a positive integer: ${providerId}`);
    }
    }
  }
  if (config.version === 3) {
    for (const modality of ['text', 'multimodal']) {
      const route = config.routes[modality];
      if (!route || !Array.isArray(route.priority)) throw new Error(`Web Reasoning route is missing: ${modality}`);
      if (route.local_fallback !== undefined && typeof route.local_fallback !== 'boolean') {
        throw new Error(`Web Reasoning local_fallback must be boolean: ${modality}`);
      }
    }
  }
  return config;
}

export function resolveProviderRoute(config, requestMetadata = {}) {
  const modality = requestMetadata.modality === 'multimodal' || requestMetadata.multimodal === true
    ? 'multimodal'
    : DEFAULT_MODALITY;
  if (config.version === 2) return { modality, priority: config.priority, localFallback: false };
  const route = config.routes[modality];
  if (!route) throw new Error(`no Web Reasoning route for modality: ${modality}`);
  return { modality, priority: route.priority, localFallback: route.local_fallback === true };
}

export function validateSystemClipboardRoute({ config, route, requestMetadata, promptText = null } = {}) {
  if (requestMetadata?.text_transport !== SYSTEM_CLIPBOARD_TEXT_TRANSPORT) return null;
  if (!['text', 'multimodal'].includes(route?.modality)) {
    throw new Error('system clipboard text transport requires the text or multimodal route');
  }
  if (!Array.isArray(route.priority) || route.priority.length !== 1 || route.localFallback === true) {
    throw new Error('system clipboard text transport requires exactly one Provider and local_fallback false');
  }
  const providerId = route.priority[0];
  const provider = config?.providers?.[providerId];
  if (provider?.adapter !== 'chatgpt-web') {
    throw new Error('system clipboard text transport currently requires the ChatGPT Web adapter');
  }
  if (requestMetadata.require_structured_response !== true) {
    throw new Error('system clipboard text transport requires structured response validation');
  }
  if (!Number.isSafeInteger(requestMetadata.clipboard_text_bytes)
    || requestMetadata.clipboard_text_bytes < 1
    || requestMetadata.clipboard_text_bytes > MAX_SYSTEM_CLIPBOARD_BYTES) {
    throw new Error('clipboard_text_bytes is invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(requestMetadata.clipboard_text_sha256 || ''))) {
    throw new Error('clipboard_text_sha256 is invalid');
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(requestMetadata.clipboard_source_url);
  } catch {
    throw new Error('clipboard_source_url is invalid');
  }
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('clipboard_source_url is invalid');
  if (promptText !== null && (!String(promptText).trim() || String(promptText).length > MAX_CLIPBOARD_INSTRUCTION_CHARS)) {
    throw new Error('system clipboard instruction must be non-empty and at most 4000 characters');
  }
  return { providerId, sourceUrl: sourceUrl.toString() };
}

export function estimatePromptTokens(text) {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of String(text || '')) {
    if (character.codePointAt(0) <= 0x7f) asciiCharacters += 1;
    else nonAsciiCharacters += 1;
  }
  // A deliberately high estimate for CJK/punctuation keeps browser UI limits conservative.
  return Math.ceil((asciiCharacters / 3) + (nonAsciiCharacters * 1.4));
}

export function providerInputBudget(provider, promptText) {
  const limit = provider?.target?.max_input_tokens;
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  const estimatedTokens = estimatePromptTokens(promptText);
  return estimatedTokens > limit ? { estimatedTokens, limit } : null;
}

function stateFiles(stateDir) {
  return {
    health: resolve(stateDir, 'provider-health.json'),
    log: resolve(stateDir, 'events.jsonl'),
  };
}

function ensureStateDirectory(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}

function readHealth(stateDir) {
  const { health } = stateFiles(stateDir);
  if (!existsSync(health)) return { version: 1, providers: {} };
  try {
    const data = JSON.parse(readFileSync(health, 'utf8'));
    return data?.providers ? data : { version: 1, providers: {} };
  } catch {
    return { version: 1, providers: {} };
  }
}

function writeHealth(stateDir, health) {
  const { health: healthFile } = stateFiles(stateDir);
  writeFileSync(healthFile, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
}

function logEvent(stateDir, event) {
  const { log } = stateFiles(stateDir);
  appendFileSync(log, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function isCoolingDown(entry, ttlMs, now) {
  return entry?.status === 'unavailable'
    && entry.failure_protocol_version === HEALTH_FAILURE_PROTOCOL_VERSION
    && entry.last_failure
    && entry.target_signature === entry.current_target_signature
    && Date.parse(entry.last_failure) + ttlMs > now;
}

export function isBrowserDisconnectedReason(reason) {
  return /^(?:Browser is not available:|native pipe closed before response)/u.test(String(reason || ''));
}

function targetSignature(provider) {
  return JSON.stringify({ adapter: provider.adapter, url: provider.url, target: provider.target });
}

async function importAdapter(adapter) {
  const path = ADAPTERS[adapter];
  if (!path) throw new Error(`unknown provider adapter: ${adapter}`);
  const adapterUrl = new URL(path, RUNNER_SOURCE_URL);
  adapterUrl.searchParams.set('mtime', String(statSync(adapterUrl).mtimeMs));
  return import(adapterUrl.href);
}

async function refreshedRunnerModule() {
  const currentMtimeMs = statSync(RUNNER_SOURCE_URL).mtimeMs;
  if (currentMtimeMs === RUNNER_LOADED_MTIME_MS) return null;
  const refreshedUrl = new URL(RUNNER_SOURCE_URL);
  refreshedUrl.searchParams.set('mtime', String(currentMtimeMs));
  return import(refreshedUrl.href);
}

function isTerminalAnswer(answer) {
  return !String(answer || '').trimStart().startsWith('NEED_MORE_CONTEXT');
}

async function closeTab(tab) {
  try {
    await tab.close();
  } catch {
    // The tab may already be closed by the provider adapter.
  }
}

export async function runWebProvider({
  providerId,
  provider,
  tab,
  promptPath,
  timeoutMs,
  continuation = false,
  uiEvidence = false,
  imagePaths = [],
  requestMetadata = {},
  adapterLoader = importAdapter,
}) {
  const module = await adapterLoader(provider.adapter);
  if (typeof module.run !== 'function') throw new Error(`provider adapter has no run(): ${provider.adapter}`);
  return module.run({ providerId, provider, tab, promptPath, timeoutMs, continuation, uiEvidence, imagePaths, requestMetadata });
}

function assertSystemClipboardResult(result, requestMetadata) {
  if (requestMetadata?.text_transport !== SYSTEM_CLIPBOARD_TEXT_TRANSPORT) return null;
  if (
    result?.clipboardPasteConfirmed !== true
    || result?.clipboard_paste_confirmed !== true
    || result?.clipboardSha256Confirmed !== true
    || result?.clipboard_sha256_confirmed !== true
  ) {
    const error = new Error('provider did not confirm the request-scoped system clipboard paste');
    error.cacheFailure = false;
    error.sendStarted = true;
    error.failureClass = 'clipboard_paste_unconfirmed';
    throw error;
  }
  return {
    clipboardPasteConfirmed: true,
    clipboard_paste_confirmed: true,
    clipboardSha256Confirmed: true,
    clipboard_sha256_confirmed: true,
  };
}

export function assertChromeBrowser(browser, browserChannel) {
  if (browserChannel !== 'chrome') {
    throw new Error('ChatGPT Web-LLM requires the user Chrome extension browser');
  }
}

async function cleanupWebProvider({ providerId, provider, tab, uiEvidence = false, adapterLoader = importAdapter }) {
  const module = await adapterLoader(provider.adapter);
  if (typeof module.archiveConversation !== 'function') return null;
  return module.archiveConversation({ providerId, provider, tab, uiEvidence });
}

export async function runProviderFallback(options) {
  const refreshed = await refreshedRunnerModule();
  if (refreshed) return refreshed.runProviderFallback(options);
  const {
    browser,
    browserChannel,
    promptPath,
    role,
    requestMetadata = {},
    configPath = DEFAULT_CONFIG_PATH,
    stateDir = DEFAULT_STATE_DIR,
    timeoutMs = DEFAULT_PROVIDER_ANSWER_TIMEOUT_MS,
    tabs = new Map(),
    uiEvidence = false,
    imagePaths = [],
    responseValidator = null,
    adapterLoader = importAdapter,
  } = options;
  if (!browser?.tabs?.new) throw new Error('a controlled Browser is required');
  assertChromeBrowser(browser, browserChannel);
  const config = loadProviderConfig(configPath);
  const route = resolveProviderRoute(config, requestMetadata);
  validateSystemClipboardRoute({ config, route, requestMetadata });
  const mediaFiles = validateImagePaths(imagePaths);
  if (route.modality === 'multimodal' && mediaFiles.length === 0) throw new Error('multimodal Web Reasoning requires at least one image');
  if (route.modality !== 'multimodal' && mediaFiles.length > 0) throw new Error('imagePaths are only allowed on the multimodal route');
  if (responseValidator !== null && typeof responseValidator !== 'function') throw new TypeError('responseValidator must be a function');
  if (requestMetadata.require_structured_response === true && responseValidator === null) {
    throw new Error('structured response validation is required for this request');
  }
  const requestId = requestMetadata.request_id || randomUUID();
  const continuation = Number(requestMetadata.context_rounds || 1) > 1;
  const structuredFormatRetryEnabled = requestMetadata.structured_response_format_retry !== false;
  const source = validatePromptPath(promptPath);
  let promptText = readFileSync(source.file, 'utf8');
  validateSystemClipboardRoute({ config, route, requestMetadata, promptText });
  rmSync(source.promptDir, { recursive: true, force: true });
  ensureStateDirectory(stateDir);
  const health = readHealth(stateDir);
  const startedAt = new Date().toISOString();
  const now = Date.now();
  const ttlMs = Number(config.health_ttl_seconds || 300) * 1_000;
  const attempts = [];

  const pendingResponse = requestMetadata.pending_response;
  if (pendingResponse) {
    const providerId = String(pendingResponse.providerId || '');
    const provider = config.providers[providerId];
    if (!provider || !route.priority.includes(providerId)) {
      throw new Error('pending response Provider is not valid for the current route');
    }
    if (!pendingResponse.tabId || !pendingResponse.resumeState) {
      throw new Error('pending response receipt is incomplete');
    }
    const tab = await browser.tabs.get(String(pendingResponse.tabId));
    const module = await adapterLoader(provider.adapter);
    if (typeof module.resumePendingAnswer !== 'function') {
      throw new Error(`Provider ${providerId} does not support pending response resume`);
    }
    let result;
    try {
      const rawResult = await module.resumePendingAnswer({
        providerId,
        provider,
        tab,
        timeoutMs,
        resumeState: pendingResponse.resumeState,
      });
      assertConfirmedAssistantResponse(rawResult);
      result = responseValidator === null
        ? rawResult
        : await validateStructuredResponse({ responseValidator, rawResult, requestId, providerId, provider, requestMetadata });
      const conversationCleanup = isTerminalAnswer(result.answer)
        ? await cleanupWebProvider({ providerId, provider, tab, uiEvidence, adapterLoader })
        : null;
      logEvent(stateDir, {
        timestamp: startedAt,
        request_id: requestId,
        task_role: role,
        provider: providerId,
        provider_attempts: [{ provider: providerId, status: 'resumed_success', attempt: 1 }],
        context_rounds: requestMetadata.context_rounds || 1,
        modality: route.modality,
        image_count: Number(pendingResponse.imageCount) || 0,
        result_length: result.answer.length,
        response_confirmation: result.response_confirmation || null,
        response_complete: result.response_complete === true,
        response_confirmed: result.response_confirmed === true,
        response_is_new: result.response_is_new === true,
        generation_complete: result.generationComplete === true,
        structured_json_available: result.structuredJsonAvailable === true,
        conversation_cleanup: conversationCleanup?.action || null,
        conversation_cleanup_confirmed: conversationCleanup?.confirmed === true,
        conversation_cleanup_verification: conversationCleanup?.verification || null,
        success: true,
      });
      await closeTab(tab);
      return { ...result, providerId, requestId, resumed: true, conversationCleanup };
    } catch (error) {
      if (error?.failureClass === 'post_send_response_unconfirmed' && error?.resumeState) {
        return {
          status: 'pending_response',
          requestId,
          pendingResponse: { ...pendingResponse, requestId, resumeState: error.resumeState },
        };
      }
      error.sendStarted = true;
      error.keepTabOpen = true;
      throw error;
    }
  }

  for (const [providerIndex, providerId] of route.priority.entries()) {
    const provider = config.providers[providerId];
    const providerSignature = targetSignature(provider);
    const healthEntry = health.providers[providerId];
    if (healthEntry) healthEntry.current_target_signature = providerSignature;
    if (isCoolingDown(healthEntry, ttlMs, now)) {
      attempts.push({ provider: providerId, status: 'skipped', reason: 'health_cache' });
      continue;
    }
    const inputBudget = providerInputBudget(provider, promptText);
    if (inputBudget) {
      attempts.push({
        provider: providerId,
        status: 'skipped',
        reason: 'input_token_budget',
        estimated_input_tokens: inputBudget.estimatedTokens,
        max_input_tokens: inputBudget.limit,
      });
      continue;
    }
    const attemptPrompt = makeAttemptPrompt(promptText);
    const tabKey = `${requestId}:${providerId}`;
    let tab = continuation ? tabs.get(tabKey) : null;
    try {
      if (!tab) {
        tab = await browser.tabs.new();
        tabs.set(tabKey, tab);
      }
      const rawResult = await runWebProvider({
        providerId,
        provider,
        tab,
        promptPath: attemptPrompt,
        timeoutMs,
        continuation,
        uiEvidence,
        imagePaths: mediaFiles,
        requestMetadata,
        adapterLoader,
      });
      if (route.modality === 'multimodal' && rawResult.attachmentsReady !== true) throw new Error('provider did not confirm image attachments are ready');
      assertConfirmedAssistantResponse(rawResult);
      const clipboardConfirmation = assertSystemClipboardResult(rawResult, requestMetadata);
      let result = rawResult;
      let responseAttempt = 1;
      if (responseValidator !== null) {
        try {
          result = await validateStructuredResponse({ responseValidator, rawResult, requestId, providerId, provider, requestMetadata });
        } catch (error) {
          if (!structuredFormatRetryEnabled || !isStructuredResponseFormatRetryable(error)) throw error;
          responseAttempt = 2;
          attempts.push({
            provider: providerId,
            status: 'structured_response_format_retry',
            attempt: responseAttempt,
            reason: error.structuredReason,
          });
          const retryPromptPath = makeAttemptPrompt(STRUCTURED_RESPONSE_FORMAT_RETRY_PROMPT);
          let retryRawResult;
          try {
            retryRawResult = await runWebProvider({
              providerId,
              provider,
              tab,
              promptPath: retryPromptPath,
              timeoutMs,
              continuation: true,
              uiEvidence,
              imagePaths: [],
              requestMetadata,
              adapterLoader,
            });
          } finally {
            try {
              removePrompt(retryPromptPath);
            } catch {
              // The provider adapter normally removes the retry prompt after submit.
            }
          }
          if (route.modality === 'multimodal' && retryRawResult.attachmentsReady !== undefined && retryRawResult.attachmentsReady !== null) {
            if (retryRawResult.attachmentsReady !== true) throw new Error('provider did not confirm image attachments are ready');
          }
          assertConfirmedAssistantResponse(retryRawResult);
          result = await validateStructuredResponse({
            responseValidator,
            rawResult: retryRawResult,
            requestId,
            providerId,
            provider,
            requestMetadata,
          });
          if (clipboardConfirmation) result = { ...result, ...clipboardConfirmation };
        }
      }
      let conversationCleanup = null;
      if (isTerminalAnswer(result.answer)) {
        try {
          conversationCleanup = await cleanupWebProvider({
            providerId,
            provider,
            tab,
            uiEvidence,
            adapterLoader,
          });
        } catch (error) {
          error.cacheFailure = false;
          error.keepTabOpen = true;
          error.sendStarted = true;
          error.failureClass = 'conversation_cleanup_failed';
          throw error;
        }
      }
      health.providers[providerId] = { status: 'available', last_success: new Date().toISOString(), target_signature: providerSignature };
      writeHealth(stateDir, health);
      attempts.push({ provider: providerId, status: 'success', attempt: responseAttempt });
      const event = {
        timestamp: startedAt,
        request_id: requestId,
        task_role: role,
        provider: providerId,
        provider_attempts: attempts,
        packed_files: requestMetadata.packed_files,
        estimated_external_tokens: requestMetadata.estimated_external_tokens,
        context_rounds: requestMetadata.context_rounds || 1,
        modality: route.modality,
        image_count: mediaFiles.length,
        result_length: result.answer.length,
        attempt: responseAttempt,
        response_confirmation: result.response_confirmation || null,
        response_complete: result.response_complete === true,
        responseConfirmed: result.responseConfirmed === true,
        response_confirmed: result.response_confirmed === true,
        response_is_new: result.response_is_new === true,
        generation_complete: result.generationComplete === true,
        structured_json_available: result.structuredJsonAvailable === true,
        text_transport: requestMetadata.text_transport || 'direct_fill',
        clipboard_paste_confirmed: result.clipboardPasteConfirmed === true,
        clipboard_sha256_confirmed: result.clipboardSha256Confirmed === true,
        clipboard_insertion_method: result.clipboardInsertionMethod || null,
        clipboard_fill_fallback_used: result.clipboardFillFallbackUsed === true,
        deep_thinking_confirmed: result.deepThinking === true,
        conversation_cleanup: conversationCleanup?.action || null,
        conversation_cleanup_confirmed: conversationCleanup?.confirmed === true,
        conversation_cleanup_verification: conversationCleanup?.verification || null,
        success: true,
      };
      logEvent(stateDir, event);
      if (isTerminalAnswer(result.answer)) {
        tabs.delete(tabKey);
        await closeTab(tab);
      }
      return {
        ...result,
        attempt: responseAttempt,
        responseAttempt,
        response_attempt: responseAttempt,
        providerId,
        modality: route.modality,
        imageCount: mediaFiles.length,
        providerAttempts: attempts,
        conversationCleanup,
        textTransport: requestMetadata.text_transport || 'direct_fill',
        text_transport: requestMetadata.text_transport || 'direct_fill',
        requestId,
      };
    } catch (error) {
      try {
        removePrompt(attemptPrompt);
      } catch {
        // The adapter normally removes the attempt prompt immediately after submit.
      }
      const reason = String(error?.message || error).slice(0, 500);
      if (isBrowserDisconnectedReason(reason)) {
        error.cacheFailure = false;
        error.failureClass = 'browser_disconnected';
      }
      if (
        requestMetadata.cross_call_resume === true
        && error?.sendStarted === true
        && error?.failureClass === 'post_send_response_unconfirmed'
        && error?.resumeState
      ) {
        logEvent(stateDir, {
          timestamp: startedAt,
          request_id: requestId,
          task_role: role,
          provider: providerId,
          provider_attempts: [{ provider: providerId, status: 'pending_response', send_started: true }],
          context_rounds: requestMetadata.context_rounds || 1,
          modality: route.modality,
          image_count: mediaFiles.length,
          result_length: 0,
          success: false,
          pending_response: true,
        });
        return {
          status: 'pending_response',
          requestId,
          pendingResponse: {
            requestId,
            providerId,
            tabId: tab.id,
            imageCount: mediaFiles.length,
            resumeState: error.resumeState,
          },
        };
      }
      let uiEvidenceDiscarded = false;
      if (uiEvidence && error?.uiEvidencePath) {
        try {
          removeUiEvidenceArtifact(error.uiEvidencePath);
          uiEvidenceDiscarded = true;
        } catch (evidenceError) {
          try {
            removeUiEvidenceArtifact(error.uiEvidencePath);
          } catch {
            // Preserve the original provider failure if temporary evidence cleanup also fails.
          }
          attempts.push({ provider: providerId, status: 'evidence_unavailable', reason: String(evidenceError?.message || evidenceError).slice(0, 180) });
        }
      }
      const cacheFailure = error?.cacheFailure !== false;
      if (cacheFailure) {
        health.providers[providerId] = {
          status: 'unavailable',
          last_failure: new Date().toISOString(),
          failure_reason: reason,
          failure_protocol_version: HEALTH_FAILURE_PROTOCOL_VERSION,
          target_signature: providerSignature,
        };
      } else if (health.providers[providerId]?.status === 'unavailable') {
        // An ambiguous post-send failure is not evidence that the provider is
        // unavailable. Remove an older negative cache entry so the next request
        // can reconcile ChatGPT again instead of falling back immediately.
        delete health.providers[providerId];
      }
      writeHealth(stateDir, health);
      attempts.push({
        provider: providerId,
        status: cacheFailure
          ? 'unavailable'
          : error?.failureClass === 'conversation_cleanup_failed'
            ? 'conversation_cleanup_failed'
            : error?.sendStarted === true
              ? 'ambiguous_post_send'
              : 'transient_unavailable',
        reason,
        send_started: error?.sendStarted === true,
        failure_class: error?.failureClass || null,
        ui_evidence_discarded: uiEvidenceDiscarded,
      });
      if (!error?.keepTabOpen) {
        tabs.delete(tabKey);
        await closeTab(tab);
      }
      if (requestMetadata.require_structured_response === true) break;
      // Web transport and extraction failures are provider-local for this request;
      // record them and try the configured fallback rather than silently changing models.
    }
  }
  if (route.localFallback && requestMetadata.require_structured_response !== true) {
    logEvent(stateDir, {
      timestamp: startedAt,
      request_id: requestId,
      task_role: role,
      provider: 'local',
      provider_attempts: attempts,
      packed_files: requestMetadata.packed_files,
      estimated_external_tokens: requestMetadata.estimated_external_tokens,
      context_rounds: requestMetadata.context_rounds || 1,
      modality: route.modality,
      image_count: mediaFiles.length,
      result_length: 0,
      success: false,
      local_fallback: true,
      failure_reason: 'all external providers unavailable',
    });
    return {
      provider: 'local',
      localFallback: true,
      modality: route.modality,
      imageCount: mediaFiles.length,
      providerAttempts: attempts,
      requestId,
    };
  }
  logEvent(stateDir, {
    timestamp: startedAt,
    request_id: requestId,
    task_role: role,
    provider: null,
    provider_attempts: attempts,
    packed_files: requestMetadata.packed_files,
    estimated_external_tokens: requestMetadata.estimated_external_tokens,
    context_rounds: requestMetadata.context_rounds || 1,
    modality: route.modality,
    result_length: 0,
    success: false,
    failure_reason: 'all providers unavailable',
  });
  const postSendAttempt = [...attempts].reverse().find(item => item.send_started === true);
  throw new ProviderUnavailableError(
    `all configured Web Reasoning providers are unavailable: ${attempts.map(item => item.provider).join(', ')}`,
    postSendAttempt ? {
      sendStarted: true,
      failureClass: postSendAttempt.failure_class || null,
      keepTabOpen: postSendAttempt.status === 'conversation_cleanup_failed',
    } : {},
  );
}
