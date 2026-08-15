import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_PROCESSING_POLICY = { allowText: true, allowVisual: true, maxImages: 4 };
const STAGE_PREFIX = 'codex-web-ingest-';
const RESULT_FILE = 'result.json';
const MAX_TEXT_CHARS = 6_000;
const SENSITIVE_PATTERNS = [
  { kind: 'credentials', pattern: /\b(?:api[_-]?key|access[_-]?token|private[_-]?key|bearer\s+token|authorization|secret)\b/i },
  { kind: 'login_hint', pattern: /\b(?:登录|sign\s*in|signin|password|验证码|二次验证|verification code|OTP)\b/i },
  { kind: 'personal', pattern: /(?:\+?86[-\s]?)?(?:1[3-9]\d{1}\d{8})\b|\b\d{15,18}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
];
const VISUAL_RISK = /(?:二维码|qr\s*code|验证码|verification\s*code|otp|身份证|证件|passport|支付|payment|银行卡|medical|医疗|病历)/iu;
const SENSITIVE_PATH = /(?:login|signin|auth|verify|captcha|payment|billing|medical|health|account|profile)/iu;

function policyOf(policy = {}) {
  const maxImages = Number.isFinite(policy.maxImages) ? Math.trunc(policy.maxImages) : 4;
  return { allowText: policy.allowText !== false, allowVisual: policy.allowVisual !== false, maxImages: Math.max(1, Math.min(4, maxImages)) };
}
function normalizeUrl(raw) {
  if (typeof raw !== 'string') throw new Error('URL must be a string');
  const value = raw.trim();
  if (!value || /\s/.test(value) || /\*|\{\}|,/.test(value)) throw new Error('URL must be a single explicit URL');
  let parsed; try { parsed = new URL(value); } catch { throw new Error('URL must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http and https URLs are allowed');
  return parsed;
}
function cleanText(value, max) { return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function hashText(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
function visibleChars(value) { return String(value || '').replace(/\s+/g, '').length; }
function pageRef(url) { return `${url.origin}${url.pathname}`; }
function textRisk(value) {
  const matches = { credentials: 0, login_hint: 0, personal: 0 };
  for (const item of SENSITIVE_PATTERNS) matches[item.kind] = Array.from(String(value || '').matchAll(new RegExp(item.pattern.source, `${item.pattern.flags.replace('g', '')}g`))).length;
  return { level: matches.credentials + matches.login_hint ? 'high' : matches.personal ? 'medium' : 'low', matches };
}
function needsVisual(objective, extracted) {
  return /\b(?:截图|图|图片|图表|canvas|表格|二维码|视觉|排版|OCR|logo|图文|可视|图像|布局)\b/ui.test(String(objective || '')) || extracted.canvasCount > 0 || extracted.tableCount >= 2;
}
function visualRisk({ url, extracted, text }) {
  const signals = [url.pathname, extracted.pageTitle, ...(extracted.imageAlts || []), text].join('\n');
  return SENSITIVE_PATH.test(url.pathname) || VISUAL_RISK.test(signals) ? { level: 'high', reason: 'visual privacy risk detected during local extraction' } : { level: 'low', reason: null };
}

export function classifyModality({ policy, objective, extracted }) {
  if (!policy.allowText && !policy.allowVisual) return { modality: 'text', blocked: true, reason: 'both allowText and allowVisual are disabled' };
  const visual = needsVisual(objective, extracted);
  if (!policy.allowText && !visual) return { modality: 'text', blocked: true, reason: 'text extraction is disabled but no visual route is selected' };
  if (!policy.allowVisual && visual) return { modality: 'multimodal', blocked: true, reason: 'visual route required but allowVisual is false' };
  return { modality: policy.allowVisual && visual ? 'multimodal' : 'text', blocked: false };
}

export async function collectSignalsFromTab(tab) {
  if (!tab?.playwright?.evaluate) throw new Error('browser tab must support evaluate');
  return tab.playwright.evaluate(() => {
    const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0; };
    const normalize = value => String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    const root = document.querySelector('main') || document.querySelector('article') || document.body;
    const ignored = 'script, style, noscript, template, nav, header, footer, aside, [role="navigation"], [aria-hidden="true"]';
    const text = Array.from(root.querySelectorAll('*')).filter(node => !node.matches(ignored) && !node.closest(ignored)).filter(node => node.children.length === 0 || /^(H1|H2|H3|TH|TD|CAPTION|P|LI)$/.test(node.tagName)).filter(visible).map(node => normalize(node.textContent)).filter(Boolean).filter(value => value.length <= 360).filter((v, i, a) => a.indexOf(v) === i).join('\n');
    const images = Array.from(document.querySelectorAll('img, picture, figure img')).filter(visible);
    const canvases = Array.from(document.querySelectorAll('canvas')).filter(visible);
    const tables = Array.from(document.querySelectorAll('table')).filter(visible);
    const regions = [...images, ...canvases, ...tables].map(element => { const r = element.getBoundingClientRect(); const x = Math.max(0, Math.floor(r.left)); const y = Math.max(0, Math.floor(r.top)); const width = Math.min(Math.ceil(r.width), Math.max(0, innerWidth - x)); const height = Math.min(Math.ceil(r.height), Math.max(0, innerHeight - y)); return width >= 16 && height >= 16 ? { x, y, width, height } : null; }).filter(Boolean).slice(0, 4);
    return { pageTitle: normalize(document.title), visibleText: text, imageCount: images.length, canvasCount: canvases.length, tableCount: tables.length, imageAlts: images.slice(0, 6).map(image => normalize(image.getAttribute('alt'))).filter(Boolean), visualRegions: regions, loadState: 'complete', location: { href: location.href, origin: location.origin } };
  });
}

export async function captureVisualArtifacts({ tab, artifactDir, maxImages, regions = [] }) {
  if (typeof tab?.screenshot !== 'function') throw new Error('this browser tab does not expose a screenshot method');
  const selected = regions.filter(r => Number.isFinite(r?.x) && Number.isFinite(r?.y) && Number.isFinite(r?.width) && Number.isFinite(r?.height) && r.width >= 16 && r.height >= 16).slice(0, Math.max(1, Math.min(4, Number(maxImages) || 1)));
  const paths = [];
  for (const [index, clip] of selected.entries()) {
    const path = join(artifactDir, `visual-${String(index + 1).padStart(2, '0')}.png`);
    const image = await tab.screenshot({ clip });
    if (!(image instanceof Uint8Array) || !image.length) throw new Error('bounded screenshot capture returned no image bytes');
    writeFileSync(path, image, { mode: 0o600 }); paths.push(path);
  }
  return paths;
}

async function openTab({ browser, browserChannel, sourceUrl, openBrowserTab }) {
  if (browserChannel !== undefined && browserChannel !== 'chrome') throw new Error('a controlled Chrome browser is required for ingestion');
  if (!openBrowserTab && !browser?.tabs?.new) throw new Error('a controlled Browser is required');
  const tab = await (openBrowserTab ? openBrowserTab() : browser.tabs.new()); await tab.goto(sourceUrl.toString());
  try { await tab.playwright?.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 10_000 }); await tab.playwright?.waitForTimeout(4_000); } catch { /* extraction is authoritative */ }
  return tab;
}
function makeWorkspace() { const path = mkdtempSync(resolve(tmpdir(), `${STAGE_PREFIX}XXXXXX-dir`)); chmodSync(path, 0o700); return path; }
function checkedPath(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error('staged result path must be absolute');
  const resolved = resolve(filePath); const root = resolve(tmpdir()); const workspace = dirname(resolved); const rel = relative(root, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(workspace).startsWith(STAGE_PREFIX) || basename(resolved) !== RESULT_FILE) throw new Error('staged result path is outside the managed temporary workspace');
  return { resolved, workspace };
}
function writeResult(workspace, payload) { const path = join(workspace, RESULT_FILE); writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 }); chmodSync(path, 0o600); return path; }

export async function extractAndStageSingleUrl({ url, objective, processingPolicy, browser, browserChannel, requestId = randomUUID(), extractSignals = collectSignalsFromTab, captureVisual = captureVisualArtifacts, openBrowserTab, createWorkspace }) {
  const policy = policyOf(processingPolicy); const sourceUrl = normalizeUrl(url); const objectiveText = String(objective || '').trim(); if (!objectiveText) throw new Error('objective is required');
  const workspace = createWorkspace ? createWorkspace() : makeWorkspace(); let tab = null;
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 }); chmodSync(workspace, 0o700);
    tab = await openTab({ browser, browserChannel, sourceUrl, openBrowserTab }); const finalUrl = new URL(await tab.url());
    if (finalUrl.origin !== sourceUrl.origin) throw new Error(`cross-domain redirect detected: ${sourceUrl.origin} -> ${finalUrl.origin}`);
    const extracted = await extractSignals(tab); const text = cleanText(extracted.visibleText, MAX_TEXT_CHARS); const risk = textRisk(text); const mode = classifyModality({ policy, objective: objectiveText, extracted });
    const visual = mode.modality === 'multimodal' ? visualRisk({ url: finalUrl, extracted, text }) : { level: 'low', reason: null };
    const pageSignals = { visibleTextChars: visibleChars(text), imageCount: Number(extracted.imageCount || 0), canvasCount: Number(extracted.canvasCount || 0), tableCount: Number(extracted.tableCount || 0), riskLevel: risk.level === 'high' || visual.level === 'high' ? 'high' : risk.level, sensitiveSignals: risk.matches, contentSha256: hashText(text) };
    if (mode.blocked || risk.level === 'high') {
      rmSync(workspace, { recursive: true, force: true });
      return { status: 'blocked', requestId, origin: finalUrl.origin, modality: mode.modality, pageSignals, result: { reason: mode.reason || 'sensitive content detected during local extraction' }, temporaryFilePath: null, cleanup: { temporaryFileRemoved: true } };
    }
    const visualArtifacts = mode.modality === 'multimodal' ? await captureVisual({ tab, artifactDir: workspace, maxImages: policy.maxImages, regions: extracted.visualRegions || [] }) : [];
    const staged = { schemaVersion: 1, requestId, source: `${finalUrl.origin}${finalUrl.pathname}`, origin: finalUrl.origin, modality: mode.modality, objective: objectiveText, pageSignals, visualRisk: visual, visibleTextExcerpt: policy.allowText ? text : '', visualRegions: extracted.visualRegions || [], visualArtifacts, capturedAt: new Date().toISOString() };
    const temporaryFilePath = writeResult(workspace, staged);
    return { status: 'staged', requestId, origin: finalUrl.origin, modality: mode.modality, pageSignals, result: { extractedChars: pageSignals.visibleTextChars, extractedHash: pageSignals.contentSha256 }, temporaryFilePath, cleanup: { temporaryFileRemoved: false } };
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true }); return { status: 'failed', requestId, reason: String(error?.message || error), temporaryFilePath: null, cleanup: { temporaryFileRemoved: true } };
  } finally { if (tab?.close) { try { await tab.close(); } catch { /* cleanup is best effort */ } } }
}

export function readStagedIngestResult(temporaryFilePath) {
  const { resolved } = checkedPath(temporaryFilePath); const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('staged result must be a regular file');
  const data = JSON.parse(readFileSync(resolved, 'utf8'));
  if (!data || data.schemaVersion !== 1 || typeof data.source !== 'string' || !['text', 'multimodal'].includes(data.modality)) throw new Error('staged result has an unsupported format');
  return { status: 'available', temporaryFilePath: resolved, ...data };
}

export function cleanupStagedIngestResult(temporaryFilePath) {
  const { resolved, workspace } = checkedPath(temporaryFilePath); const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('staged result must be a regular file');
  if (readdirSync(workspace).some(name => name !== RESULT_FILE && !/^visual-\d{2}\.png$/u.test(name))) throw new Error('temporary workspace contains unexpected files');
  rmSync(workspace, { recursive: true, force: true }); return { status: 'cleaned', temporaryFilePath: resolved, temporaryFileRemoved: !existsSync(workspace) };
}

export const ingestSingleUrlWithLocalContext = extractAndStageSingleUrl;
