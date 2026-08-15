import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BOUNDED_DOM_PREFIX = 'codex-web-llm-page-extract-';
export const BOUNDED_DOM_FILE = 'dom.json';
export const MAX_BOUNDED_DOM_BYTES = 2_000_000;

const MAX_OBJECTIVE_CHARS = 2_000;
const MAX_TERM_GROUPS = 20;
const MAX_TERMS_PER_GROUP = 12;
const MAX_TERM_CHARS = 80;
const KNOWN_FAILURES = [
  'bounded_main_region_not_found',
  'bounded_task_subtree_not_found',
  'bounded_selector_invalid',
  'bounded_dom_size_invalid',
  'bounded_dom_sensitive',
  'cross_origin_dom_artifact',
  'same_context_dom_proof_missing',
];

export class BoundedDomError extends Error {
  constructor(category, metadata = {}) {
    super(`bounded DOM extraction failed: ${category}`);
    this.name = 'BoundedDomError';
    this.code = 'BOUNDED_DOM_FAILED';
    this.category = category;
    Object.assign(this, metadata);
  }
}

function fail(category, metadata) {
  throw new BoundedDomError(category, metadata);
}

function normalizeSingleUrl(value) {
  if (typeof value !== 'string') fail('url_invalid');
  const input = value.trim();
  if (!input || /\s|[*{},]/u.test(input)) fail('url_must_be_single_explicit_http_url');
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    fail('url_invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('url_protocol_invalid');
  return { input, parsed };
}

function normalizeObjective(value) {
  const objective = String(value || '').replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!objective || objective.length > MAX_OBJECTIVE_CHARS) fail('objective_invalid');
  return objective;
}

export function normalizeTaskTermGroups(groups) {
  if (!Array.isArray(groups) || groups.length < 2 || groups.length > MAX_TERM_GROUPS) {
    fail('task_term_groups_invalid');
  }
  return groups.map(group => {
    const values = Array.isArray(group) ? group : [group];
    if (!values.length || values.length > MAX_TERMS_PER_GROUP) fail('task_term_group_invalid');
    const normalized = [...new Set(values.map(value => String(value || '')
      .replace(/[\u0000-\u001F\u007F]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLocaleLowerCase('und'))
      .filter(Boolean))];
    if (!normalized.length || normalized.some(value => value.length > MAX_TERM_CHARS)) {
      fail('task_term_group_invalid');
    }
    return normalized;
  });
}

function normalizeInteger(value, { name, minimum, maximum, fallback }) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(`${name}_invalid`);
  return number;
}

function createWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), BOUNDED_DOM_PREFIX));
  chmodSync(workspace, 0o700);
  return workspace;
}

function validateArtifactPath(artifactPath) {
  if (typeof artifactPath !== 'string' || !isAbsolute(artifactPath)) fail('artifact_path_invalid');
  const resolved = resolve(artifactPath);
  const lexicalTempRoot = resolve(tmpdir());
  const lexicalRelative = relative(lexicalTempRoot, resolved);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    fail('artifact_path_outside_temp');
  }
  const workspace = dirname(resolved);
  let realWorkspace;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    fail('artifact_workspace_missing');
  }
  const realTempRoot = realpathSync(lexicalTempRoot);
  const realRelative = relative(realTempRoot, realWorkspace);
  if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) {
    fail('artifact_workspace_outside_temp');
  }
  if (!basename(realWorkspace).startsWith(BOUNDED_DOM_PREFIX) || basename(resolved) !== BOUNDED_DOM_FILE) {
    fail('artifact_path_unmanaged');
  }
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    fail('artifact_missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('artifact_not_regular_file');
  return { resolved, workspace: realWorkspace };
}

function writeArtifact(artifactPath, artifact) {
  writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
  chmodSync(artifactPath, 0o600);
}

function removeWorkspace(workspace) {
  if (!workspace || !existsSync(workspace)) return true;
  const resolved = resolve(workspace);
  const tempRoot = resolve(tmpdir());
  const rel = relative(tempRoot, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !basename(resolved).startsWith(BOUNDED_DOM_PREFIX)) {
    fail('cleanup_workspace_unmanaged');
  }
  const contents = readdirSync(resolved);
  if (contents.some(name => name !== BOUNDED_DOM_FILE)) fail('cleanup_workspace_has_unknown_files');
  rmSync(resolved, { recursive: true, force: true });
  return !existsSync(resolved);
}

function boundedFailureCategory(reason, fallback = 'web_ingest_failed') {
  const text = String(reason || '');
  return KNOWN_FAILURES.find(item => text.includes(item)) || fallback;
}

async function importInstalledWebIngest(webIngestRoot) {
  if (typeof webIngestRoot !== 'string' || !isAbsolute(webIngestRoot)) fail('web_ingest_root_invalid');
  const root = resolve(webIngestRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) fail('web_ingest_root_missing');
  const healthPath = join(root, 'scripts', 'health-check.mjs');
  const corePath = join(root, 'scripts', 'web-ingest.mjs');
  if (!existsSync(healthPath) || !existsSync(corePath)) fail('web_ingest_runtime_missing');
  const healthModule = await import(pathToFileURL(healthPath).href);
  const health = await healthModule.runWebIngestHealthCheck({ root });
  if (health?.ok !== true) fail('web_ingest_health_failed');
  const core = await import(pathToFileURL(corePath).href);
  for (const name of ['extractAndStageSingleUrl', 'readStagedIngestResult', 'cleanupStagedIngestResult']) {
    if (typeof core[name] !== 'function') fail('web_ingest_exports_missing');
  }
  return { core, health };
}

export function createBoundedTaskExtractSignals({
  requestUrl,
  taskTermGroups,
  artifactPath,
  minimumTermGroups = 2,
  minimumContentUnits = 2,
  maxDomBytes = MAX_BOUNDED_DOM_BYTES,
} = {}) {
  const source = normalizeSingleUrl(requestUrl);
  const normalizedGroups = normalizeTaskTermGroups(taskTermGroups);
  const requiredGroups = normalizeInteger(minimumTermGroups, {
    name: 'minimum_term_groups', minimum: 1, maximum: normalizedGroups.length, fallback: 2,
  });
  const requiredUnits = normalizeInteger(minimumContentUnits, {
    name: 'minimum_content_units', minimum: 1, maximum: 100, fallback: 2,
  });
  const maximumBytes = normalizeInteger(maxDomBytes, {
    name: 'max_dom_bytes', minimum: 1, maximum: MAX_BOUNDED_DOM_BYTES, fallback: MAX_BOUNDED_DOM_BYTES,
  });
  if (typeof artifactPath !== 'string' || !isAbsolute(artifactPath)) fail('artifact_path_invalid');

  return async tab => {
    if (!tab?.playwright?.evaluate) fail('controlled_browser_tab_required');
    const extracted = await tab.playwright.evaluate(({
      sourceUrl,
      termGroups,
      minimumGroups,
      minimumUnits,
      maximumDomBytes,
    }) => {
      const normalize = value => String(value || '')
        .replace(/[\u0000-\u001F\u007F]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return element.getAttribute('aria-hidden') !== 'true'
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && rect.width > 0
          && rect.height > 0;
      };
      const ignoredSelector = [
        'script', 'style', 'noscript', 'template', 'nav', 'header', 'footer', 'aside',
        'svg', 'canvas', 'video', 'audio', 'iframe', '[role="navigation"]', '[aria-hidden="true"]',
      ].join(', ');
      const root = document.querySelector('main')
        || document.querySelector('[role="main"]')
        || document.querySelector('article');
      if (!root || !visible(root)) throw new Error('bounded_main_region_not_found');

      const matchGroups = text => {
        const normalized = text.toLocaleLowerCase('und');
        return termGroups.reduce((count, group) => (
          count + (group.some(term => normalized.includes(term)) ? 1 : 0)
        ), 0);
      };
      const contentUnitSelector = 'a, button, [role="button"], li, article, tr, h2, h3, h4, dt, dd';
      const candidates = Array.from(root.querySelectorAll('section, article, div, ul, ol, table, dl'))
        .filter(element => element !== root && visible(element) && !element.closest(ignoredSelector))
        .map(element => {
          const text = normalize(element.innerText || element.textContent);
          if (text.length < 120 || text.length > 180_000) return null;
          const matchedGroups = matchGroups(text);
          if (matchedGroups < minimumGroups) return null;
          const contentUnits = Array.from(element.querySelectorAll(contentUnitSelector))
            .filter(visible)
            .filter(unit => normalize(unit.innerText || unit.textContent).length > 0)
            .length;
          const visibleChildren = Array.from(element.children)
            .filter(visible)
            .filter(child => normalize(child.innerText || child.textContent).length >= 20)
            .length;
          if (contentUnits < minimumUnits && visibleChildren < minimumUnits) return null;
          let depth = 0;
          for (let current = element; current && current !== root; current = current.parentElement) depth += 1;
          const score = (matchedGroups * 1_000)
            + (Math.min(contentUnits, 100) * 25)
            + (Math.min(visibleChildren, 40) * 20)
            + (Math.min(depth, 30) * 2)
            - (text.length / 2_000);
          return { element, text, matchedGroups, contentUnits, visibleChildren, depth, score };
        })
        .filter(Boolean)
        .sort((left, right) => (
          right.score - left.score
          || right.matchedGroups - left.matchedGroups
          || right.contentUnits - left.contentUnits
          || left.text.length - right.text.length
          || right.depth - left.depth
        ));
      const selected = candidates[0];
      if (!selected) throw new Error('bounded_task_subtree_not_found');

      const cssEscape = value => (globalThis.CSS?.escape
        ? globalThis.CSS.escape(value)
        : String(value).replace(/[^A-Za-z0-9_-]/gu, character => `\\${character}`));
      const selectorSegment = element => {
        const tag = element.tagName.toLowerCase();
        const id = element.getAttribute('id');
        if (id && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(id)) return `${tag}#${cssEscape(id)}`;
        for (const attribute of ['data-testid', 'data-section', 'data-qa']) {
          const value = element.getAttribute(attribute);
          if (value && value.length <= 80 && !/["\\\n\r]/u.test(value)) {
            return `${tag}[${attribute}="${value}"]`;
          }
        }
        const parent = element.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter(child => child.tagName === element.tagName);
        return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})` : tag;
      };
      const selectorParts = [];
      for (let current = selected.element; current && current !== root; current = current.parentElement) {
        selectorParts.unshift(selectorSegment(current));
      }
      const rootSelector = root.matches('main')
        ? 'main'
        : root.getAttribute('role') === 'main'
          ? '[role="main"]'
          : 'article';
      const domScope = [rootSelector, ...selectorParts].join(' > ');
      if (!selectorParts.length || domScope.length > 240) throw new Error('bounded_selector_invalid');

      const escapeText = value => value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;');
      const allowedTags = new Set([
        'section', 'article', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
        'p', 'span', 'strong', 'em', 'small', 'a', 'button', 'time', 'table',
        'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'label', 'mark',
      ]);
      const serialize = node => {
        if (node.nodeType === Node.TEXT_NODE) {
          const value = normalize(node.nodeValue);
          return value ? escapeText(value) : '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const element = node;
        if (element.matches(ignoredSelector) || !visible(element)) return '';
        const rawTag = element.tagName.toLowerCase();
        const tag = allowedTags.has(rawTag) ? rawTag : 'div';
        const children = Array.from(element.childNodes).map(serialize).filter(Boolean).join(' ');
        if (!children) return '';
        const safeAttributes = [];
        if (tag === 'time') {
          const datetime = normalize(element.getAttribute('datetime'));
          if (datetime && datetime.length <= 80) safeAttributes.push(`datetime="${datetime.replace(/"/gu, '&quot;')}"`);
        }
        if (['th', 'td'].includes(tag)) {
          for (const name of ['colspan', 'rowspan']) {
            const value = element.getAttribute(name);
            if (/^[1-9][0-9]?$/u.test(value || '')) safeAttributes.push(`${name}="${value}"`);
          }
        }
        return `<${tag}${safeAttributes.length ? ` ${safeAttributes.join(' ')}` : ''}>${children}</${tag}>`;
      };
      const domText = serialize(selected.element);
      const utf8ByteLength = value => {
        let bytes = 0;
        for (const character of value) {
          const point = character.codePointAt(0);
          bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        }
        return bytes;
      };
      const domBytes = utf8ByteLength(domText);
      if (domBytes < 200 || domBytes > maximumDomBytes) throw new Error('bounded_dom_size_invalid');
      const sensitive = /(?:api[_-]?key|access[_-]?token|private[_-]?key|bearer\s+token|authorization\s*[:=]|password\s*[:=]|passwd\s*[:=]|cookie\s*[:=]|set-cookie|登录|sign\s*in|log\s*in|验证码|二次验证|verification\s*code|\botp\b|密码|身份证|银行卡|payment\s+card)/iu.test(domText);
      if (sensitive) throw new Error('bounded_dom_sensitive');

      const requested = new URL(sourceUrl);
      if (location.origin !== requested.origin) throw new Error('cross_origin_dom_artifact');
      const finalUrl = `${location.origin}${location.pathname}`;
      const images = Array.from(selected.element.querySelectorAll('img, picture, figure img')).filter(visible);
      const tables = Array.from(selected.element.querySelectorAll('table')).filter(visible);
      return {
        artifact: {
          domSource: 'controlled-browser-same-origin',
          sameContext: true,
          domComplete: false,
          sourceUrl,
          finalUrl,
          domScope,
          domText,
          risk: { level: 'low' },
          selection: {
            matchedTermGroups: selected.matchedGroups,
            contentUnits: selected.contentUnits,
            visibleChildren: selected.visibleChildren,
          },
        },
        signals: {
          pageTitle: normalize(document.title),
          visibleText: selected.text,
          imageCount: images.length,
          canvasCount: 0,
          tableCount: tables.length,
          imageAlts: images.slice(0, 6).map(image => normalize(image.getAttribute('alt'))).filter(Boolean),
          visualRegions: [],
          loadState: document.readyState,
          location: { href: location.href, origin: location.origin },
        },
        metadata: {
          finalUrl,
          domScope,
          domBytes,
          matchedTermGroups: selected.matchedGroups,
          contentUnits: selected.contentUnits,
          visibleChildren: selected.visibleChildren,
        },
      };
    }, {
      sourceUrl: source.input,
      termGroups: normalizedGroups,
      minimumGroups: requiredGroups,
      minimumUnits: requiredUnits,
      maximumDomBytes: maximumBytes,
    });

    if (
      extracted?.artifact?.domSource !== 'controlled-browser-same-origin'
      || extracted.artifact.sameContext !== true
      || extracted.artifact.domComplete !== false
    ) {
      fail('same_context_dom_proof_missing');
    }
    if (new URL(extracted.artifact.finalUrl).origin !== source.parsed.origin) {
      fail('cross_origin_dom_artifact');
    }
    writeArtifact(artifactPath, extracted.artifact);
    return { ...extracted.signals, boundedDomMetadata: extracted.metadata };
  };
}

export async function stageBoundedDomArtifact({
  url,
  objective,
  taskTermGroups,
  browser,
  browserChannel = 'chrome',
  webIngestRoot,
  requestId = randomUUID(),
  minimumTermGroups = 2,
  minimumContentUnits = 2,
  maxDomBytes = MAX_BOUNDED_DOM_BYTES,
  workspaceFactory = createWorkspace,
} = {}) {
  const source = normalizeSingleUrl(url);
  const objectiveText = normalizeObjective(objective);
  if (browserChannel !== 'chrome') fail('controlled_chrome_required');
  if (!browser?.tabs?.new) fail('controlled_browser_required');
  const { core, health } = await importInstalledWebIngest(webIngestRoot);
  const workspace = workspaceFactory();
  const artifactPath = join(workspace, BOUNDED_DOM_FILE);
  let stagedPath = null;
  try {
    const outcome = await core.extractAndStageSingleUrl({
      url: source.input,
      objective: objectiveText,
      processingPolicy: { allowText: true, allowVisual: false, maxImages: 1 },
      browser,
      browserChannel,
      requestId,
      extractSignals: createBoundedTaskExtractSignals({
        requestUrl: source.input,
        taskTermGroups,
        artifactPath,
        minimumTermGroups,
        minimumContentUnits,
        maxDomBytes,
      }),
    });
    if (outcome?.status !== 'staged' || !outcome.temporaryFilePath) {
      fail(boundedFailureCategory(outcome?.reason || outcome?.result?.reason, `web_ingest_${outcome?.status || 'failed'}`), {
        ingestStatus: outcome?.status || 'failed',
      });
    }
    stagedPath = outcome.temporaryFilePath;
    const staged = core.readStagedIngestResult(stagedPath);
    const artifactStat = lstatSync(artifactPath);
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) fail('artifact_not_regular_file');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    const cleanup = core.cleanupStagedIngestResult(stagedPath);
    stagedPath = null;
    if (cleanup?.temporaryFileRemoved !== true) fail('staged_cleanup_failed');
    return {
      status: 'ready',
      requestId,
      sourceUrl: source.input,
      finalUrl: artifact.finalUrl,
      domArtifactPath: artifactPath,
      receipt: {
        webIngestHealth: health.ok === true,
        stagedCleanup: true,
        modality: staged.modality,
        pageSignals: staged.pageSignals,
        domScope: artifact.domScope,
        domBytes: Buffer.byteLength(artifact.domText, 'utf8'),
        domSha256: createHash('sha256').update(artifact.domText).digest('hex'),
        matchedTermGroups: artifact.selection?.matchedTermGroups,
        contentUnits: artifact.selection?.contentUnits,
        visibleChildren: artifact.selection?.visibleChildren,
      },
    };
  } catch (error) {
    if (stagedPath) {
      try {
        core.cleanupStagedIngestResult(stagedPath);
      } catch {
        // Preserve the primary bounded failure; the managed ingest directory
        // is reported through the caller-visible failure category.
      }
    }
    removeWorkspace(workspace);
    if (error instanceof BoundedDomError) throw error;
    fail(boundedFailureCategory(error?.message), { causeCode: error?.code || null });
  }
}

export function cleanupBoundedDomArtifact(artifactPath) {
  const validated = validateArtifactPath(artifactPath);
  if (readdirSync(validated.workspace).some(name => name !== BOUNDED_DOM_FILE)) {
    fail('cleanup_workspace_has_unknown_files');
  }
  rmSync(validated.workspace, { recursive: true, force: true });
  return {
    status: 'cleaned',
    domArtifactRemoved: !existsSync(validated.workspace),
  };
}
