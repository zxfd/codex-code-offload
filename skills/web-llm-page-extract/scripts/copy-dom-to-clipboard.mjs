#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_DOM_BYTES = 2_000_000;
const MANAGED_PREFIXES = ['codex-web-ingest-', 'codex-web-llm-page-extract-'];
const SENSITIVE_URL = /(?:login|signin|sign-in|auth|oauth|password|passwd|credential|token|captcha|verify|verification|payment|billing|account|profile|medical|health)/iu;
const SENSITIVE_DOM = /(?:api[_-]?key|access[_-]?token|private[_-]?key|bearer\s+token|authorization\s*[:=]|password\s*[:=]|passwd\s*[:=]|cookie\s*[:=]|set-cookie|登录|sign\s*in|log\s*in|验证码|二次验证|verification\s+code|\botp\b|密码|身份证|银行卡|payment\s+card)/iu;
const FULL_DOCUMENT = /<!doctype\s+html|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>)/iu;

function fail(message) {
  throw new Error(message);
}

function utf8ClipboardEnvironment() {
  const inherited = typeof process !== 'undefined' && process?.env ? process.env : {};
  return { ...inherited, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
}

function parseHttpUrl(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(label + ' is required');
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    fail(label + ' must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(label + ' must use http or https');
  return parsed;
}

function assertSameOrigin(source, finalUrl) {
  if (finalUrl.origin !== source.origin) fail('cross-origin DOM artifact: ' + source.origin + ' -> ' + finalUrl.origin);
}

export function validateInputPath(inputPath) {
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) fail('input path must be absolute');
  const resolved = resolve(inputPath);
  const lexicalRoot = resolve(tmpdir());
  const root = realpathSync(lexicalRoot);
  const relativePath = relative(lexicalRoot, resolved);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    fail('input path must be inside the system temporary directory');
  }
  let realParent;
  try {
    realParent = realpathSync(dirname(resolved));
  } catch {
    fail('input parent directory does not exist');
  }
  const realRelativePath = relative(root, realParent);
  if (!realRelativePath || realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
    fail('input parent directory resolves outside the system temporary directory');
  }
  const parent = basename(realParent);
  if (!MANAGED_PREFIXES.some(prefix => parent.startsWith(prefix))) {
    fail('input path must be inside a managed web-ingest or page-extract temporary directory');
  }
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    fail('input path does not exist');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('input must be a regular non-symlink file');
  return { resolved, size: stat.size };
}

function riskIsHigh(payload) {
  const candidates = [
    payload.sensitive,
    payload.containsCredentials,
    payload.loginPage,
    payload.risk?.level,
    payload.risk?.riskLevel,
    payload.pageSignals?.riskLevel,
    payload.visualRisk?.level,
  ];
  return candidates.some(value => value === true || String(value || '').toLowerCase() === 'high');
}

function cleanPlainText(value) {
  return String(value)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function readBoundedDomArtifact(inputPath, maxBytes = MAX_DOM_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DOM_BYTES) {
    fail('maxBytes must be an integer from 1 to ' + MAX_DOM_BYTES);
  }
  const input = validateInputPath(inputPath);
  if (input.size > maxBytes) fail('input file exceeds the ' + maxBytes + '-byte limit');
  let payload;
  try {
    payload = JSON.parse(readFileSync(input.resolved, 'utf8'));
  } catch {
    fail('input must be valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('input JSON must be an object');
  if (payload.schemaVersion === 1 && typeof payload.source === 'string' && typeof payload.domText !== 'string') {
    fail('standard web-ingest result.json intentionally omits complete DOM; provide a bounded same-context DOM artifact');
  }
  if (payload.domSource !== 'controlled-browser-same-origin' || payload.sameContext !== true || payload.domComplete === true) {
    fail('DOM artifact must prove a bounded same-origin browser context');
  }
  const source = parseHttpUrl(payload.sourceUrl ?? payload.source, 'sourceUrl');
  const finalUrl = parseHttpUrl(payload.finalUrl ?? payload.sourceUrl ?? payload.source, 'finalUrl');
  assertSameOrigin(source, finalUrl);
  if (SENSITIVE_URL.test(source.toString()) || SENSITIVE_URL.test(finalUrl.toString())) {
    fail('login, credential, account, payment, or other sensitive page path is not allowed');
  }
  if (riskIsHigh(payload)) fail('input carries a high-risk or sensitive-content marker');
  if (typeof payload.domScope !== 'string' || !payload.domScope.trim()) fail('domScope is required');
  if (payload.domScope.length > 240 || /(?:^|\s)(?:html|head|body|document)(?:\s|$)/iu.test(payload.domScope)) {
    fail('domScope must identify a bounded task subtree, not the full document');
  }
  if (typeof payload.domText !== 'string' || !payload.domText.trim()) fail('domText is required');
  if (FULL_DOCUMENT.test(payload.domText)) fail('full-document DOM is not allowed');
  if (SENSITIVE_DOM.test(payload.domText)) fail('credential, login, verification, payment, or sensitive content detected in DOM');
  const text = cleanPlainText(payload.domText);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!bytes) fail('domText is empty after normalization');
  if (bytes > maxBytes) fail('domText exceeds the ' + maxBytes + '-byte limit');
  return {
    text,
    bytes,
    sourceUrl: source.toString(),
    finalUrl: finalUrl.toString(),
    domScope: payload.domScope.trim(),
  };
}

export function copyDomToClipboard(inputPath, { maxBytes = MAX_DOM_BYTES, dryRun = false, spawn = spawnSync } = {}) {
  const prepared = readBoundedDomArtifact(inputPath, maxBytes);
  const { text, ...metadata } = prepared;
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (dryRun) return { ...metadata, sha256, clipboardWritten: false, dryRun: true };
  if (platform() !== 'darwin') fail('system clipboard writing requires macOS (pbcopy); Web-LLM was not called');
  const result = spawn('pbcopy', [], {
    input: prepared.text,
    encoding: 'utf8',
    env: utf8ClipboardEnvironment(),
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || '').trim() || ('exit ' + result.status);
    fail('pbcopy failed: ' + detail + '; Web-LLM was not called');
  }
  return { ...metadata, sha256, clipboardWritten: true, dryRun: false };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { input: null, maxBytes: MAX_DOM_BYTES, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--input' && argv[index + 1]) {
      if (options.input !== null) fail('--input may be provided only once');
      options.input = argv[++index];
    }
    else if (arg === '--max-bytes' && argv[index + 1]) options.maxBytes = Number(argv[++index]);
    else fail('unknown or incomplete argument: ' + arg);
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_DOM_BYTES) {
    fail('maxBytes must be an integer from 1 to ' + MAX_DOM_BYTES);
  }
  if (!options.help && !options.input) fail('--input is required');
  return options;
}

function isMainModule() {
  if (typeof process === 'undefined' || !process?.argv?.[1]) return false;
  return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

if (isMainModule()) {
  try {
    const options = parseArgs();
    if (options.help) {
      console.log('Usage: copy-dom-to-clipboard.mjs --input /absolute/path/dom.json [--max-bytes N] [--dry-run]');
    } else {
      const result = copyDomToClipboard(options.input, options);
      console.log(JSON.stringify({ status: 'ready', sourceUrl: result.sourceUrl, domScope: result.domScope, bytes: result.bytes, sha256: result.sha256, clipboardWritten: result.clipboardWritten, dryRun: result.dryRun }));
    }
  } catch (error) {
    console.error('copy-dom-to-clipboard failed: ' + error.message);
    process.exitCode = 1;
  }
}
