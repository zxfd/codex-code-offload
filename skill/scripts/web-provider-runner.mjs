import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ProviderUnavailableError,
  makeAttemptPrompt,
  removeUiEvidenceArtifact,
  removePrompt,
  validatePromptPath,
} from './provider-utils.mjs';
import { validateImagePaths } from './media-upload.mjs';

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

const DEFAULT_MODALITY = 'text';

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

function targetSignature(provider) {
  return JSON.stringify({ adapter: provider.adapter, url: provider.url, target: provider.target });
}

async function importAdapter(adapter) {
  const path = ADAPTERS[adapter];
  if (!path) throw new Error(`unknown provider adapter: ${adapter}`);
  return import(path);
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
  adapterLoader = importAdapter,
}) {
  const module = await adapterLoader(provider.adapter);
  if (typeof module.run !== 'function') throw new Error(`provider adapter has no run(): ${provider.adapter}`);
  return module.run({ providerId, provider, tab, promptPath, timeoutMs, continuation, uiEvidence, imagePaths });
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

export async function runProviderFallback({
  browser,
  browserChannel,
  promptPath,
  role,
  requestMetadata = {},
  configPath = DEFAULT_CONFIG_PATH,
  stateDir = DEFAULT_STATE_DIR,
  timeoutMs = 180_000,
  tabs = new Map(),
  uiEvidence = false,
  imagePaths = [],
  adapterLoader = importAdapter,
}) {
  if (!browser?.tabs?.new) throw new Error('a controlled Browser is required');
  assertChromeBrowser(browser, browserChannel);
  const config = loadProviderConfig(configPath);
  const route = resolveProviderRoute(config, requestMetadata);
  const mediaFiles = validateImagePaths(imagePaths);
  if (route.modality === 'multimodal' && mediaFiles.length === 0) throw new Error('multimodal Web Reasoning requires at least one image');
  if (route.modality !== 'multimodal' && mediaFiles.length > 0) throw new Error('imagePaths are only allowed on the multimodal route');
  const requestId = requestMetadata.request_id || randomUUID();
  const continuation = Number(requestMetadata.context_rounds || 1) > 1;
  const source = validatePromptPath(promptPath);
  let promptText = readFileSync(source.file, 'utf8');
  rmSync(source.promptDir, { recursive: true, force: true });
  ensureStateDirectory(stateDir);
  const health = readHealth(stateDir);
  const startedAt = new Date().toISOString();
  const now = Date.now();
  const ttlMs = Number(config.health_ttl_seconds || 300) * 1_000;
  const attempts = [];

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
    if (!tab) {
      tab = await browser.tabs.new();
      tabs.set(tabKey, tab);
    }
    try {
      const result = await runWebProvider({
        providerId,
        provider,
        tab,
        promptPath: attemptPrompt,
        timeoutMs,
        continuation,
        uiEvidence,
        imagePaths: mediaFiles,
        adapterLoader,
      });
      if (route.modality === 'multimodal' && result.attachmentsReady !== true) throw new Error('provider did not confirm image attachments are ready');
      health.providers[providerId] = { status: 'available', last_success: new Date().toISOString(), target_signature: providerSignature };
      writeHealth(stateDir, health);
      attempts.push({ provider: providerId, status: 'success' });
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
        response_confirmed: result.responseConfirmed === true,
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
        providerId,
        modality: route.modality,
        imageCount: mediaFiles.length,
        providerAttempts: attempts,
        conversationCleanup,
        requestId,
      };
    } catch (error) {
      try {
        removePrompt(attemptPrompt);
      } catch {
        // The adapter normally removes the attempt prompt immediately after submit.
      }
      const reason = String(error?.message || error).slice(0, 500);
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
            : 'ambiguous_post_send',
        reason,
        send_started: error?.sendStarted === true,
        failure_class: error?.failureClass || null,
        ui_evidence_discarded: uiEvidenceDiscarded,
      });
      if (!error?.keepTabOpen) {
        tabs.delete(tabKey);
        await closeTab(tab);
      }
      // Web transport and extraction failures are provider-local for this request;
      // record them and try the configured fallback rather than silently changing models.
    }
  }
  if (route.localFallback) {
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
  throw new ProviderUnavailableError(`all configured Web Reasoning providers are unavailable: ${attempts.map(item => item.provider).join(', ')}`);
}
