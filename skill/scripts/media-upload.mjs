import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import { locatorVisible } from './provider-utils.mjs';

const MAX_IMAGE_COUNT = 4;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const FILE_CHOOSER_TIMEOUT_MS = 10_000;
const ATTACHMENT_READY_TIMEOUT_MS = 30_000;

export function validateImagePaths(imagePaths = []) {
  if (!Array.isArray(imagePaths)) throw new Error('imagePaths must be an array');
  if (imagePaths.length > MAX_IMAGE_COUNT) throw new Error(`at most ${MAX_IMAGE_COUNT} images may be attached`);
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

async function firstVisibleByText(tab, labels) {
  for (const label of labels) {
    const candidates = tab.playwright.getByText(label, { exact: true });
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await locatorVisible(candidate)) return candidate;
    }
  }
  return null;
}

async function firstVisibleByRole(tab, role, labels) {
  for (const label of labels) {
    const candidates = tab.playwright.getByRole(role, { name: label, exact: true });
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await locatorVisible(candidate)) return candidate;
    }
  }
  return null;
}

async function openChatGptChooser(tab) {
  const input = tab.playwright.locator('#upload-photos');
  if (await input.count() !== 1) throw new Error('ChatGPT image input #upload-photos is unavailable');
  let upload = await firstVisibleByText(tab, ['从电脑上传', 'Upload from computer']);
  if (!upload) {
    const addFiles = await firstVisibleByRole(tab, 'button', ['添加文件等', 'Add files']);
    if (!addFiles) throw new Error('ChatGPT upload menu button is unavailable');
    await addFiles.click({ timeoutMs: 15_000 });
    upload = await firstVisibleByText(tab, ['从电脑上传', 'Upload from computer']);
  }
  if (!upload) throw new Error('ChatGPT visible upload option is unavailable');
  await upload.click({ timeoutMs: 15_000 });
}

async function openGenericImageChooser(tab, provider, imageInputSelector, controls) {
  const imageInput = tab.playwright.locator(imageInputSelector);
  if (await imageInput.count() !== 1) throw new Error(`${provider} image input is unavailable`);
  const control = await firstVisibleByRole(tab, 'button', controls) || await firstVisibleByText(tab, controls);
  if (control) {
    await control.click({ timeoutMs: 15_000 });
    return;
  }
  await imageInput.click({ force: true, timeoutMs: 10_000 });
}

function attachmentSelectors(provider) {
  if (provider === 'ChatGPT') {
    return [
      'form[data-type="unified-composer"] [data-testid*="attachment"]',
      'form[data-type="unified-composer"] [data-attachment]',
      'form[data-type="unified-composer"] img',
    ];
  }
  return ['[data-testid*="attachment"]', '[data-attachment]', '[class*="attachment"]', 'img'];
}

async function readAttachmentState(tab, provider, expectedNames) {
  const selectors = attachmentSelectors(provider);
  return tab.playwright.evaluate(({ providerName, names, attachmentSelectors: selectorsToUse }) => {
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const fileCount = [...document.querySelectorAll('input[type="file"]')]
      .reduce((count, input) => count + Number(input.files?.length || 0), 0);
    const visibleNodes = selectorsToUse.flatMap(selector => [...document.querySelectorAll(selector)]).filter(visible);
    const bodyText = document.body?.innerText || '';
    return {
      provider: providerName,
      fileCount,
      visibleAttachmentCount: new Set(visibleNodes).size,
      visibleNames: names.filter(name => bodyText.includes(name)),
    };
  }, { providerName: provider, names: expectedNames, attachmentSelectors: selectors }, { timeoutMs: 10_000 });
}

async function waitForAttachmentReady({ tab, provider, imagePaths, timeoutMs = ATTACHMENT_READY_TIMEOUT_MS }) {
  const expectedNames = imagePaths.map(file => basename(file));
  const deadline = Date.now() + timeoutMs;
  let lastState = { provider, fileCount: 0, visibleAttachmentCount: 0, visibleNames: [] };
  while (Date.now() < deadline) {
    lastState = await readAttachmentState(tab, provider, expectedNames);
    const visibleEvidence = lastState.visibleNames.length >= expectedNames.length
      || lastState.visibleAttachmentCount >= expectedNames.length;
    if (lastState.fileCount >= expectedNames.length && visibleEvidence) {
      return { ready: true, count: expectedNames.length, state: lastState };
    }
    await tab.playwright.waitForTimeout(250);
  }
  throw new Error(`${provider} attachment readiness was not confirmed: ${JSON.stringify(lastState)}`);
}

export async function attachProviderImages({ tab, provider, imagePaths, timeoutMs = ATTACHMENT_READY_TIMEOUT_MS }) {
  const files = validateImagePaths(imagePaths);
  if (!files.length) return { ready: false, count: 0 };
  const openChooser = provider === 'ChatGPT'
    ? () => openChatGptChooser(tab)
    : provider === 'Gemini'
      ? () => openGenericImageChooser(tab, provider, 'input[type="file"][accept*="image"]', ['添加图片和文件', 'Add files', 'Upload files', '上传文件', '添加文件'])
      : provider === 'Qwen'
        ? () => openGenericImageChooser(tab, provider, 'input[type="file"][accept*="image"]', ['添加附件', 'Add attachment', '上传文件', 'Upload file', '上传图片', 'Upload image'])
        : null;
  if (!openChooser) throw new Error(`image upload is not implemented for ${provider}`);

  const chooserResult = tab.playwright.waitForEvent('filechooser', { timeoutMs: FILE_CHOOSER_TIMEOUT_MS })
    .then(chooser => ({ chooser }), error => ({ error: String(error?.message || error) }));
  await openChooser();
  const result = await chooserResult;
  if (result.error) throw new Error(`${provider} file chooser was not opened: ${result.error}`);
  if (!result.chooser.isMultiple() && files.length > 1) throw new Error(`${provider} file chooser does not accept multiple images`);
  await result.chooser.setFiles(files);
  return waitForAttachmentReady({ tab, provider, imagePaths: files, timeoutMs });
}
