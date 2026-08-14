import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const DEFAULT_PLUGIN_CACHE_ROOT = resolve(homedir(), '.codex', 'plugins', 'cache', 'openai-bundled');
const BROWSER_ROOT_SEGMENT = 'browser';

function sortedVersionsDescending(versions) {
  return [...versions].sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' }));
}

function toCorrectedCacheRoot(candidateRoot) {
  const normalized = resolve(candidateRoot);
  const parts = normalized.split(sep);
  if (parts.at(-1) === 'control-in-app-browser' && parts.at(-2) === 'skills') {
    const versionRoot = resolve(normalized, '..', '..');
    return parts.at(-4) === BROWSER_ROOT_SEGMENT
      ? resolve(versionRoot, '..', '..')
      : versionRoot;
  }
  return null;
}

function describeCandidateRoot(rootPath) {
  const placeholderVersion = '<version>';
  return [
    `  - ${join(rootPath, BROWSER_ROOT_SEGMENT, placeholderVersion, 'scripts', 'browser-client.mjs')}`,
    `  - ${join(rootPath, BROWSER_ROOT_SEGMENT, placeholderVersion, 'scripts')} (must be a directory)`,
    `  - ${join(rootPath, BROWSER_ROOT_SEGMENT, placeholderVersion, 'skills')} (must be a directory)`,
  ];
}

function isDirectory(path, exists) {
  if (!exists(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveBrowserClientEntry({ pluginCacheRoot = DEFAULT_PLUGIN_CACHE_ROOT, exists = existsSync } = {}) {
  const initialRoot = resolve(String(pluginCacheRoot));
  const pluginCacheCandidates = [initialRoot];
  const corrected = toCorrectedCacheRoot(initialRoot);
  if (corrected) pluginCacheCandidates.push(corrected);
  const dedupedCandidates = [...new Set(pluginCacheCandidates)];
  const checkedCandidates = [];

  for (const pluginCacheRootPath of dedupedCandidates) {
    const browserRootPath = join(pluginCacheRootPath, BROWSER_ROOT_SEGMENT);
    let versions = [];
    try {
      versions = readdirSync(browserRootPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch {
      versions = [];
    }
    for (const version of sortedVersionsDescending(versions)) {
      const candidateRoot = join(browserRootPath, version);
      const candidateScripts = join(candidateRoot, 'scripts');
      const candidateSkills = join(candidateRoot, 'skills');
      const candidateEntry = join(candidateScripts, 'browser-client.mjs');
      checkedCandidates.push(candidateEntry);
      if (isDirectory(candidateScripts, exists) && isDirectory(candidateSkills, exists) && exists(candidateEntry)) {
        return candidateEntry;
      }
    }
  }

  const expected = dedupedCandidates.flatMap(describeCandidateRoot).join('\n');
  throw new Error(
    `Unable to resolve browser-client entry.\nChecked candidates:\n${checkedCandidates.length ? checkedCandidates.map(item => `  - ${item}`).join('\n') : '  - <none>'}\nExpected any cache root under these plugin roots to contain:\n${expected}\nResolved plugin cache candidates:\n${dedupedCandidates.map(candidate => `  - ${candidate}`).join('\n')}`,
  );
}
