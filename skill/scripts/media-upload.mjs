import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

const MAX_IMAGE_COUNT = 4;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ATTACHMENT_READY_TIMEOUT_MS = 120_000;
const ATTACHMENT_UPLOAD_SETTLE_MS = 5_000;
const PASTE_RETRIES = 2;

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

function attachmentSelectors(provider) {
  if (provider === 'ChatGPT') {
    return [
      'form[data-type="unified-composer"] [data-testid*="attachment"]',
      'form[data-type="unified-composer"] [data-attachment]',
      'form[data-type="unified-composer"] img',
      'form[data-type="unified-composer"] [aria-label*="移除"]',
      'form[data-type="unified-composer"] [aria-label*="Remove"]',
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
    const visibleNodes = selectorsToUse
      .flatMap(selector => [...document.querySelectorAll(selector)])
      .filter(visible);
    const uniqueNodes = [...new Set(visibleNodes)];
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
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    let pasted = false;
    let lastPasteError;
    for (let attempt = 0; attempt <= PASTE_RETRIES; attempt += 1) {
      try {
        await composer.click({ timeoutMs: 10_000 });
        await tab.clipboard.write([{
          entries: [{
            mimeType: clipboardMimeType(file),
            base64: readFileSync(file).toString('base64'),
          }],
        }]);
        await composer.press('ControlOrMeta+V', { timeoutMs: 10_000 });
        pasted = true;
        break;
      } catch (error) {
        lastPasteError = error;
        if (attempt < PASTE_RETRIES) await tab.playwright.waitForTimeout(1_000 * (attempt + 1));
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
  return { ready: true, count: files.length, state: state.state };
}

// Keep the descriptive alias for callers that only care about attaching media.
export const attachProviderImages = pasteProviderImages;
