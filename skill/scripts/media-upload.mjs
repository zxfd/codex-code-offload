import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';

const MAX_IMAGE_COUNT = 4;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ATTACHMENT_READY_TIMEOUT_MS = 120_000;
const ATTACHMENT_UPLOAD_SETTLE_MS = 5_000;
const PASTE_RETRIES = 2;
const MAX_CLIPBOARD_IMAGE_BYTES = 2_000_000;
const MAX_CLIPBOARD_IMAGE_DIMENSION = 1_600;

export function validateImagePaths(imagePaths = []) {
  if (!Array.isArray(imagePaths)) throw new Error('imagePaths must be an array');
  if (imagePaths.length > MAX_IMAGE_COUNT) throw new Error(`at most ${MAX_IMAGE_COUNT} images may be pasted`);
  return imagePaths.map(rawPath => {
    if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) {
      throw new Error('image paths must be absolute filesystem paths');
    }
    const extension = extname(rawPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`unsupported image type: ${extension || 'unknown'}`);
    const file = realpathSync(rawPath);
    if (!statSync(file).isFile()) throw new Error(`image path is not a file: ${basename(file)}`);
    return file;
  });
}

function clipboardMimeType(file) {
  switch (extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function prepareClipboardImage(file) {
  const original = readFileSync(file);
  if (original.length <= MAX_CLIPBOARD_IMAGE_BYTES) {
    return { bytes: original, mimeType: clipboardMimeType(file), normalized: false, cleanup() {} };
  }
  if (platform() !== 'darwin') {
    throw new Error(`image is too large for reliable clipboard transport: ${basename(file)}`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'codex-web-image-'));
  chmodSync(directory, 0o700);
  const input = join(directory, `source${extname(file).toLowerCase()}`);
  const output = join(directory, 'clipboard.jpg');
  writeFileSync(input, original, { mode: 0o600 });
  const result = spawnSync('/usr/bin/sips', [
    '-Z', String(MAX_CLIPBOARD_IMAGE_DIMENSION),
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', '80',
    input,
    '--out', output,
  ], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`image normalization failed: ${basename(file)}`);
  }
  const normalized = readFileSync(output);
  if (!normalized.length || normalized.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`normalized image is too large for reliable clipboard transport: ${basename(file)}`);
  }
  return {
    bytes: normalized,
    mimeType: 'image/jpeg',
    normalized: true,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function attachmentSelectors(provider) {
  if (provider === 'ChatGPT') {
    return [
      'form[data-type="unified-composer"] [aria-label*="移除"]',
      'form[data-type="unified-composer"] [aria-label*="Remove"]',
      'form[data-type="unified-composer"] [data-testid*="attachment"]',
      'form[data-type="unified-composer"] [data-attachment]',
      'form[data-type="unified-composer"] img',
    ];
  }
  return ['[data-testid*="attachment"]', '[data-attachment]', '[class*="attachment"]', 'img'];
}

async function readAttachmentState(tab, provider) {
  const selectors = attachmentSelectors(provider);
  return tab.playwright.evaluate(({ providerName, attachmentSelectors: selectorsToUse }) => {
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const groups = selectorsToUse.map(selector => [...document.querySelectorAll(selector)].filter(visible));
    const unique = nodes => [...new Set(nodes)];
    const topLevel = nodes => unique(nodes).filter(node => !nodes.some(other => other !== node && other.contains(node)));
    const removeControls = unique([...groups[0], ...groups[1]]);
    const attachmentRoots = topLevel([...groups[2], ...groups[3]]);
    const imageFallback = unique(groups[4] || []);
    const uniqueNodes = providerName === 'ChatGPT'
      ? removeControls.length
        ? removeControls
        : attachmentRoots.length
          ? attachmentRoots
          : imageFallback
      : unique(groups.flat());
    return {
      provider: providerName,
      visibleAttachmentCount: uniqueNodes.length,
      visibleNames: uniqueNodes
        .map(element => element.getAttribute('alt') || element.getAttribute('aria-label') || '')
        .filter(Boolean)
        .slice(0, 8),
    };
  }, { providerName: provider, attachmentSelectors: selectors }, { timeoutMs: 10_000 });
}

async function waitForAttachmentReady({ tab, provider, baselineCount, minimumCount, timeoutMs = ATTACHMENT_READY_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let lastState = { provider, visibleAttachmentCount: 0, visibleNames: [] };
  let readySince = null;
  while (Date.now() < deadline) {
    lastState = await readAttachmentState(tab, provider);
    if (lastState.visibleAttachmentCount >= baselineCount + minimumCount) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= ATTACHMENT_UPLOAD_SETTLE_MS) {
        const settledState = await readAttachmentState(tab, provider);
        if (settledState.visibleAttachmentCount >= baselineCount + minimumCount) {
          return { ready: true, count: minimumCount, state: settledState };
        }
        readySince = null;
      }
    } else {
      readySince = null;
    }
    await tab.playwright.waitForTimeout(250);
  }
  throw new Error(`${provider} clipboard attachment readiness was not confirmed: expected_at_least=${baselineCount + minimumCount}, state=${JSON.stringify(lastState)}`);
}

export async function pasteProviderImages({ tab, provider, imagePaths, composer, timeoutMs = ATTACHMENT_READY_TIMEOUT_MS }) {
  const files = validateImagePaths(imagePaths);
  if (!files.length) return { ready: false, count: 0 };
  if (!tab?.clipboard?.write) throw new Error(`${provider} clipboard access is unavailable`);
  if (!composer?.press) throw new Error(`${provider} composer is unavailable for clipboard paste`);

  const baselineState = await readAttachmentState(tab, provider);
  const baselineCount = baselineState.visibleAttachmentCount;
  let state;
  let normalizedCount = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    let pasted = false;
    let lastPasteError;
    for (let attempt = 0; attempt <= PASTE_RETRIES; attempt += 1) {
      let prepared;
      try {
        prepared = prepareClipboardImage(file);
        await composer.click({ timeoutMs: 10_000 });
        await tab.clipboard.write([{
          entries: [{
            mimeType: prepared.mimeType,
            base64: prepared.bytes.toString('base64'),
          }],
        }]);
        await composer.press('ControlOrMeta+V', { timeoutMs: 10_000 });
        if (prepared.normalized) normalizedCount += 1;
        pasted = true;
        break;
      } catch (error) {
        lastPasteError = error;
        if (attempt < PASTE_RETRIES) await tab.playwright.waitForTimeout(1_000 * (attempt + 1));
      } finally {
        prepared?.cleanup();
      }
    }
    if (!pasted) throw lastPasteError;
    state = await waitForAttachmentReady({
      tab,
      provider,
      baselineCount,
      minimumCount: index + 1,
      timeoutMs,
    });
  }
  return { ready: true, count: files.length, normalizedCount, state: state.state };
}

// Keep the descriptive alias for callers that only care about attaching media.
export const attachProviderImages = pasteProviderImages;
