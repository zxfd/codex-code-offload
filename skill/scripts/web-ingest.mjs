import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { runProviderFallback } from './web-provider-runner.mjs';

export const DEFAULT_PROCESSING_POLICY = {
  allowText: true,
  allowVisual: true,
  allowExternalTransfer: false,
  maxImages: 4,
};

const INGEST_WORKDIR_PREFIX = 'codex-web-reasoning-prompt-';
const PROMPT_FILE = 'prompt.txt';
const MAX_ARTIFACT_TEXT_CHARS = 6_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_RESULT_PREVIEW_CHARS = 1_200;
const NEED_MORE_CONTEXT_PREFIX = 'NEED_MORE_CONTEXT';

const SENSITIVE_PATTERNS = [
  { kind: 'credentials', pattern: /\b(?:api[_-]?key|access[_-]?token|private[_-]?key|bearer\s+token|authorization|secret)\b/i },
  { kind: 'login_hint', pattern: /\b(?:登录|sign\s*in|signin|password|验证码|二次验证|verification code|OTP)\b/i },
  { kind: 'personal', pattern: /(?:\+?86[-\s]?)?(?:1[3-9]\d{1}\d{8})\b|\b\d{15,18}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
];
const SENSITIVE_VISUAL_PATTERN = /(?:二维码|qr\s*code|验证码|verification\s*code|otp|身份证|证件|passport|支付|payment|银行卡|medical|医疗|病历)/iu;
const SENSITIVE_PATH_PATTERN = /(?:login|signin|auth|verify|captcha|payment|billing|medical|health|account|profile)/iu;

function normalizePolicy(policy = {}) {
  const maxImages = Number.isFinite(policy.maxImages) ? Math.trunc(policy.maxImages) : DEFAULT_PROCESSING_POLICY.maxImages;
  return {
    allowText: policy.allowText !== false,
    allowVisual: policy.allowVisual !== false,
    allowExternalTransfer: policy.allowExternalTransfer === true,
    maxImages: Math.max(1, Math.min(4, Number.isFinite(maxImages) ? maxImages : DEFAULT_PROCESSING_POLICY.maxImages)),
  };
}

export function isNeedMoreContext(answer) {
  return String(answer || '').trimStart().startsWith(NEED_MORE_CONTEXT_PREFIX);
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string') throw new Error('URL must be a string');
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed) || /\*|\{\}|,/.test(trimmed)) {
    throw new Error('URL must be a single explicit URL');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('URL must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('only http and https URLs are allowed');
  }
  return parsed;
}

function createIngestWorkspace() {
  return mkdtempSync(resolve(tmpdir(), `${INGEST_WORKDIR_PREFIX}XXXXXX-dir`));
}

function mkdirpSync(path) {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) {
      throw new Error('workspace path is not a directory');
    }
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function sanitizeText(input, maxChars) {
  return String(input || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function hashText(input) {
  return createHash('sha256').update(String(input || '')).digest('hex');
}

function safePageReference(url) {
  return `${url.origin}${url.pathname}`;
}

function countVisibleText(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function riskLevelFromText(text) {
  const matches = { credentials: 0, login_hint: 0, personal: 0 };
  const content = String(text || '');
  for (const item of SENSITIVE_PATTERNS) {
    const matcher = item.pattern.global
      ? item.pattern
      : new RegExp(item.pattern.source, `${item.pattern.flags || ''}g`);
    matches[item.kind] = Array.from(content.matchAll(matcher)).length;
  }

  const highSignals = matches.credentials + matches.login_hint;
  if (highSignals > 0) return { level: 'high', matches };
  if (matches.personal > 0) return { level: 'medium', matches };
  return { level: 'low', matches };
}

function requiresVisual(objective = '', extracted) {
  const objectiveHasVisualCue = /\b(?:截图|图|图片|图表|canvas|表格|二维码|视觉|排版|OCR|logo|图文|可视|图像|截图|布局)\b/ui.test(String(objective || ''));
  return objectiveHasVisualCue || extracted.canvasCount > 0 || extracted.tableCount >= 2;
}

function visualRiskFrom({ url, extracted, visibleText }) {
  const localSignals = [url.pathname, extracted.pageTitle, ...extracted.imageAlts, visibleText].join('\n');
  if (SENSITIVE_PATH_PATTERN.test(url.pathname) || SENSITIVE_VISUAL_PATTERN.test(localSignals)) {
    return { level: 'high', reason: 'visual privacy risk requires user approval' };
  }
  return { level: 'low', reason: null };
}

export function classifyModality({ policy, objective, extracted }) {
  if (!policy.allowText && !policy.allowVisual) {
    return { modality: 'text', blocked: true, reason: 'both allowText and allowVisual are disabled' };
  }

  if (!policy.allowText && !requiresVisual(objective, extracted)) {
    return { modality: 'text', blocked: true, reason: 'text extraction is disabled but no visual route is selected' };
  }

  const visualNeeded = requiresVisual(objective, extracted);
  if (!policy.allowVisual && visualNeeded) {
    return { modality: 'multimodal', blocked: true, reason: 'visual route required but allowVisual is false' };
  }

  return {
    modality: policy.allowVisual && visualNeeded ? 'multimodal' : 'text',
    blocked: false,
  };
}

export async function collectSignalsFromTab(tab) {
  if (!tab?.playwright?.evaluate) throw new Error('browser tab must support evaluate');
  return tab.playwright.evaluate(() => {
    const inViewport = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const normalize = text => String(text || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('main') || document.querySelector('article') || document.body;
    const ignoredSelector = 'script, style, noscript, template, nav, header, footer, aside, [role="navigation"], [aria-hidden="true"]';
    const nodes = Array.from(root.querySelectorAll('*'));
    const visibleText = nodes
      .filter(node => !node.matches(ignoredSelector) && !node.closest(ignoredSelector))
      .filter(node => node.children.length === 0 || /^(H1|H2|H3|TH|TD|CAPTION|P|LI)$/.test(node.tagName))
      .filter(inViewport)
      .map(node => normalize(node.textContent))
      .filter(Boolean)
      .filter(text => text.length <= 360)
      .filter((item, index, list) => list.indexOf(item) === index)
      .join('\n');

    const images = Array.from(document.querySelectorAll('img, picture, figure img')).filter(inViewport);
    const canvases = Array.from(document.querySelectorAll('canvas')).filter(inViewport);
    const tables = Array.from(document.querySelectorAll('table')).filter(inViewport);
    const visualRegions = [...images, ...canvases, ...tables]
      .map(element => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, Math.floor(rect.left));
        const y = Math.max(0, Math.floor(rect.top));
        const width = Math.min(Math.ceil(rect.width), Math.max(0, window.innerWidth - x));
        const height = Math.min(Math.ceil(rect.height), Math.max(0, window.innerHeight - y));
        return width >= 16 && height >= 16 ? { x, y, width, height } : null;
      })
      .filter(Boolean)
      .slice(0, 4);

    return {
      pageTitle: normalize(document.title),
      visibleText,
      imageCount: images.length,
      canvasCount: canvases.length,
      tableCount: tables.length,
      imageAlts: images.slice(0, 6).map(img => normalize(img.getAttribute('alt'))).filter(Boolean),
      visualRegions,
      loadState: 'complete',
      location: {
        href: location.href,
        origin: location.origin,
      },
    };
  });
}

export async function captureVisualArtifacts({ tab, artifactDir, maxImages, regions = [] }) {
  if (typeof tab?.screenshot !== 'function') {
    throw new Error('this browser tab does not expose a screenshot method');
  }

  const count = Math.max(1, Math.min(4, Number(maxImages) || 1));
  const selectedRegions = regions
    .filter(region => Number.isFinite(region?.x) && Number.isFinite(region?.y) && Number.isFinite(region?.width) && Number.isFinite(region?.height)
      && region.width >= 16 && region.height >= 16)
    .slice(0, count);
  const paths = [];
  for (const [index, clip] of selectedRegions.entries()) {
    const path = join(artifactDir, `visual-${String(index + 1).padStart(2, '0')}.png`);
    const image = await tab.screenshot({ clip });
    if (!(image instanceof Uint8Array) || image.length === 0) {
      throw new Error('bounded screenshot capture returned no image bytes');
    }
    writeFileSync(path, image, { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}

function buildPrompt({ url, objective, mode, signals, contentSha256, excerpt }) {
  const safeExcerpt = sanitizeText(excerpt, MAX_PROMPT_CHARS);
  return [
    'You are asked to analyze a single authorized webpage with minimal context.',
    `URL: ${safePageReference(new URL(url))}`,
    `Mode suggestion: ${mode}`,
    `Objective: ${objective}`,
    `Load state: ${signals.loadState}`,
    `Visible text chars: ${countVisibleText(excerpt)}`,
    `Image count: ${signals.imageCount}`,
    `Canvas count: ${signals.canvasCount}`,
    `Table count: ${signals.tableCount}`,
    `Content SHA-256: ${contentSha256}`,
    '',
    safeExcerpt ? `Visible excerpt:\n${safeExcerpt}` : 'No visible text excerpt was extracted.',
  ].join('\n');
}

function summarizeAnswer(answer) {
  return {
    answerLength: String(answer || '').length,
    answerPreview: sanitizeText(answer, MAX_RESULT_PREVIEW_CHARS),
  };
}

async function openTabForIngestion({ browser, browserChannel, sourceUrl, openBrowserTab }) {
  if (browserChannel !== undefined && browserChannel !== 'chrome') {
    throw new Error('a controlled Chrome browser is required for ingestion');
  }
  if (!openBrowserTab) {
    if (!browser?.tabs?.new) throw new Error('a controlled Browser is required');
  }
  const tab = await (openBrowserTab ? openBrowserTab() : browser.tabs.new());
  await tab.goto(sourceUrl.toString());
  try {
    await tab.playwright?.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 10_000 });
    await tab.playwright?.waitForTimeout(4_000);
  } catch {
    // The subsequent visible-content read is the authoritative readiness check.
  }
  return tab;
}

export async function ingestSingleUrlWithLocalContext({
  url,
  objective,
  processingPolicy,
  browser,
  browserChannel,
  requestMetadata = {},
  requestId = randomUUID(),
  runProvider = runProviderFallback,
  stateDir,
  providerTabs = new Map(),
  uiEvidence = false,
  timeoutMs = 180_000,
  extractSignals = collectSignalsFromTab,
  captureVisual = captureVisualArtifacts,
  openBrowserTab,
  createWorkspace,
}) {
  const policy = normalizePolicy(processingPolicy);
  const validatedUrl = normalizeUrl(url);
  const objectiveText = String(objective || '').trim();
  if (!objectiveText) throw new Error('objective is required');

  const workspace = createWorkspace ? createWorkspace() : createIngestWorkspace();
  const resolvedWorkspace = workspace;
  const promptPath = join(resolvedWorkspace, PROMPT_FILE);
  let tab = null;
  let pageSignals = null;
  let response = null;
  let capturedImagePaths = [];

  const cleanupState = {
    captureArtifactsRemoved: false,
    providerTabCleanup: false,
  };

  try {
    mkdirpSync(resolvedWorkspace);
    chmodSync(resolvedWorkspace, 0o700);

    tab = await openTabForIngestion({
      browser,
      browserChannel,
      sourceUrl: validatedUrl,
      openBrowserTab,
    });

    const finalUrl = new URL(await tab.url());
    if (finalUrl.origin !== validatedUrl.origin) {
      throw new Error(`cross-domain redirect detected: ${validatedUrl.origin} -> ${finalUrl.origin}`);
    }

    const extracted = await extractSignals(tab);
    const visibleText = sanitizeText(extracted.visibleText, MAX_ARTIFACT_TEXT_CHARS);
    const risk = riskLevelFromText(visibleText);
    const decision = classifyModality({ policy, objective: objectiveText, extracted });
    const contentSha256 = hashText(visibleText);

    pageSignals = {
      visibleTextChars: countVisibleText(visibleText),
      imageCount: Number(extracted.imageCount || 0),
      canvasCount: Number(extracted.canvasCount || 0),
      tableCount: Number(extracted.tableCount || 0),
      riskLevel: risk.level,
      contentSha256,
    };

    const visualRisk = decision.modality === 'multimodal'
      ? visualRiskFrom({ url: finalUrl, extracted, visibleText })
      : { level: 'low', reason: null };

    if (decision.blocked || risk.level === 'high') {
      response = {
        status: 'blocked',
        requestId,
        origin: finalUrl.origin,
        modality: decision.modality,
        pageSignals,
        result: {
          reason: decision.blocked ? decision.reason : 'sensitive content detected during local extraction',
          sensitiveSignals: risk.matches,
        },
        externalTransfer: null,
        cleanup: cleanupState,
      };
      return response;
    }

    if (decision.modality === 'multimodal' && visualRisk.level === 'high') {
      response = {
        status: 'requires_user_approval',
        requestId,
        origin: finalUrl.origin,
        modality: decision.modality,
        pageSignals: { ...pageSignals, riskLevel: 'high' },
        result: { reason: visualRisk.reason },
        externalTransfer: null,
        cleanup: cleanupState,
      };
      return response;
    }

    const promptText = buildPrompt({
      url: validatedUrl.toString(),
      objective: objectiveText,
      mode: decision.modality,
      signals: extracted,
      contentSha256,
      excerpt: visibleText,
    });
    writeFileSync(promptPath, `${promptText}\n`, { mode: 0o600 });

    const providerMetadata = {
      ...requestMetadata,
      request_id: requestMetadata.request_id || requestId,
      context_rounds: requestMetadata.context_rounds || 1,
      modality: decision.modality,
      packed_files: requestMetadata.packed_files || 1,
      estimated_external_tokens: countVisibleText(visibleText),
    };

    if (!policy.allowExternalTransfer) {
      response = {
        status: 'requires_user_approval',
        requestId,
        origin: finalUrl.origin,
        modality: decision.modality,
        pageSignals,
        result: {
          extractedChars: pageSignals.visibleTextChars,
          extractedHash: contentSha256,
        },
        externalTransfer: null,
        cleanup: cleanupState,
      };
      return response;
    }

    if (decision.modality === 'multimodal') {
      const maxCount = Math.max(1, Math.min(policy.maxImages, Number(requestMetadata.maxImageCount || policy.maxImages)));
      capturedImagePaths = await captureVisual({
        tab,
        artifactDir: resolvedWorkspace,
        maxImages: maxCount,
        regions: extracted.visualRegions || [],
      });
      if (capturedImagePaths.length === 0) {
        response = {
          status: 'requires_user_approval',
          requestId,
          origin: finalUrl.origin,
          modality: decision.modality,
          pageSignals,
          result: { reason: 'no bounded visual region was available for external transfer' },
          externalTransfer: null,
          cleanup: cleanupState,
        };
        return response;
      }
    }

    const providerResult = await runProvider({
      browser,
      browserChannel,
      promptPath,
      role: requestMetadata.role || 'root_cause',
      requestMetadata: providerMetadata,
      imagePaths: capturedImagePaths,
      timeoutMs,
      tabs: providerTabs,
      uiEvidence,
      stateDir,
    });

    if (decision.modality === 'multimodal' && providerResult.attachmentsReady !== true) {
      response = {
        status: 'failed',
        requestId,
        origin: finalUrl.origin,
        modality: decision.modality,
        pageSignals,
        result: {
          reason: 'provider did not confirm image attachments',
        },
        externalTransfer: {
          provider: providerResult.provider,
          model: providerResult.model || null,
          attachmentsReady: providerResult.attachmentsReady,
        },
        cleanup: cleanupState,
      };
      return response;
    }

    const terminal = !isNeedMoreContext(providerResult.answer);
    response = {
      status: terminal ? 'completed' : 'requires_user_approval',
      requestId,
      origin: finalUrl.origin,
      modality: decision.modality,
      pageSignals,
      result: {
        ...summarizeAnswer(providerResult.answer),
        ...terminal ? {} : { fullNeedsMoreContext: true },
      },
      externalTransfer: {
        provider: providerResult.provider,
        model: providerResult.model || null,
        attachmentsReady: decision.modality === 'multimodal' ? Boolean(providerResult.attachmentsReady) : null,
      },
      cleanup: {
        captureArtifactsRemoved: false,
        providerTabCleanup: Boolean(providerResult.conversationCleanup?.confirmed) || false,
      },
    };

    return response;
  } catch (error) {
    response = {
      status: 'failed',
      requestId,
      reason: String(error?.message || error),
      origin: response?.origin,
      modality: response?.modality || 'text',
      pageSignals,
      result: {
        error: String(error?.message || error),
      },
      externalTransfer: response?.externalTransfer || null,
      cleanup: cleanupState,
    };
    return response;
  } finally {
    const needsMoreContext = response?.status === 'requires_user_approval' && response?.result?.fullNeedsMoreContext;
    if (!needsMoreContext) {
      const safeArtifactPaths = [...new Set([promptPath, ...capturedImagePaths])];
      for (const path of safeArtifactPaths) {
        if (existsSync(path)) {
          rmSync(path, { force: true });
        }
      }
      if (existsSync(resolvedWorkspace)) {
        rmSync(resolvedWorkspace, { recursive: true, force: true });
      }
      cleanupState.captureArtifactsRemoved = true;
    }

    if (response?.cleanup) {
      response.cleanup = {
        ...response.cleanup,
        captureArtifactsRemoved: cleanupState.captureArtifactsRemoved,
      };
    }

    if (tab?.close) {
      try {
        await tab.close();
      } catch {
        // ignore cleanup close errors
      }
    }
  }
}
