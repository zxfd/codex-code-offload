#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_GLOBAL_SKILL_ROOT = resolve(homedir(), '.agents', 'skills', 'luna-model-routing');
const REQUIRED_ENTRIES = {
  'scripts/web-ingest.mjs': {
    expectedExports: ['ingestSingleUrlWithLocalContext', 'captureVisualArtifacts'],
    forwardTargetName: 'web-ingest.mjs',
  },
  'scripts/browser-client-entry.mjs': {
    expectedExports: ['resolveBrowserClientEntry'],
    forwardTargetName: 'browser-client-entry.mjs',
  },
};

function addCheck(report, check) {
  report.checks.push(check);
  if (check.status === 'fail') report.ok = false;
}

function inspectForwardingEntry(filePath, source, forwardTargetName) {
  const imported = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  const badAbsoluteImport = imported.find(specifier => isAbsolute(specifier));
  if (badAbsoluteImport) {
    return {
      name: filePath,
      status: 'fail',
      message: `forwarding path is absolute (${badAbsoluteImport})`,
      remediation: 'Keep forwarding imports relative to allow relocation and portable clones.',
    };
  }
  const relativeMatch = imported.find(specifier => specifier.startsWith('.'));
  const forwardMatch = imported.find(
    specifier => specifier.startsWith('.') && specifier.endsWith(`/${forwardTargetName}`),
  );
  if (!relativeMatch) {
    return {
      name: filePath,
      status: 'fail',
      message: 'no relative module specifier found for forwarding implementation',
      remediation: `Use a relative export/re-export from '${forwardTargetName}'.`,
    };
  }
  if (!forwardMatch) {
    return {
      name: filePath,
      status: 'fail',
      message: `forwarding does not reference a relative ${forwardTargetName} path`,
      remediation: `Use a relative path such as '../../../skill/scripts/${forwardTargetName}'.`,
    };
  }
  return { name: filePath, status: 'pass', message: 'entry module forwards via relative path', remediation: null };
}

function validateRoot(path) {
  const result = { exists: false, isDirectory: false, isSymlink: false, linkTarget: null };
  try {
    const stat = lstatSync(path);
    result.exists = true;
    result.isDirectory = statSync(path).isDirectory();
    result.isSymlink = stat.isSymbolicLink();
    if (result.isSymlink) result.linkTarget = resolve(dirname(path), readlinkSync(path));
  } catch {
    // The resulting false values are reported as a fail-closed missing-root diagnostic.
  }
  return result;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = { skillRoot: DEFAULT_GLOBAL_SKILL_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      options.skillRoot = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

export async function runLunaModelRoutingHealthCheck({ skillRoot = DEFAULT_GLOBAL_SKILL_ROOT } = {}) {
  const report = { ok: true, skillRoot: resolve(skillRoot), checks: [], summary: [] };
  const rootInfo = validateRoot(report.skillRoot);
  if (!rootInfo.exists) {
    addCheck(report, {
      name: 'global_skill_root', status: 'fail',
      message: `installed skill root not found at ${report.skillRoot}`,
      remediation: 'Create or repair the global luna-model-routing Skill symlink so it points to the checked-out repository.',
      detail: rootInfo,
    });
    return report;
  }
  if (!rootInfo.isDirectory) {
    addCheck(report, {
      name: 'global_skill_root', status: 'fail',
      message: `installed skill path is not a directory: ${report.skillRoot}`,
      remediation: 'Point the skill root to a real directory or fix its symlink target.', detail: rootInfo,
    });
    return report;
  }
  addCheck(report, {
    name: 'global_skill_root', status: 'pass',
    message: `resolved installed skill root at ${report.skillRoot}`,
    detail: rootInfo, remediation: null,
  });

  for (const [entry, policy] of Object.entries(REQUIRED_ENTRIES)) {
    const filePath = resolve(report.skillRoot, entry);
    if (!existsSync(filePath)) {
      addCheck(report, {
        name: `entry:${entry}`, status: 'fail', message: `required entry module missing: ${entry}`,
        remediation: `Create ${entry} as a portable forwarding module (relative import) into skill/scripts/${policy.forwardTargetName}.`,
        detail: { filePath, required: true },
      });
      continue;
    }
    const forwarding = inspectForwardingEntry(entry, readFileSync(filePath, 'utf8'), policy.forwardTargetName);
    addCheck(report, {
      name: `forwarding:${entry}`, status: forwarding.status, message: forwarding.message,
      remediation: forwarding.remediation, detail: { filePath },
    });
    if (forwarding.status === 'fail') continue;
    let moduleNamespace;
    try {
      moduleNamespace = await import(pathToFileURL(filePath).href);
    } catch (error) {
      addCheck(report, {
        name: `import:${entry}`, status: 'fail', message: `entry module import failed for ${entry}: ${error.message}`,
        remediation: 'Ensure the file is valid ESM and its forwarded module path resolves correctly.', detail: { filePath },
      });
      continue;
    }
    const missingExports = policy.expectedExports.filter(name => !(name in moduleNamespace));
    if (missingExports.length > 0) {
      addCheck(report, {
        name: `exports:${entry}`, status: 'fail', message: `missing exports in ${entry}: ${missingExports.join(', ')}`,
        remediation: `Keep forwarding module signature compatible with underlying skill/scripts/${policy.forwardTargetName}.`,
        detail: { missingExports },
      });
      continue;
    }
    addCheck(report, {
      name: `entry:${entry}`, status: 'pass', message: `${entry} is present and importable through global path`,
      detail: { filePath }, remediation: null,
    });
  }
  report.summary = [
    `global_root=${rootInfo.isSymlink ? 'symlink' : 'directory'}`,
    `entries_checked=${Object.keys(REQUIRED_ENTRIES).length}`,
    `failed_checks=${report.checks.filter(check => check.status === 'fail').length}`,
  ];
  return report;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const report = await runLunaModelRoutingHealthCheck(parseCliArgs());
  for (const check of report.checks) {
    const remediation = check.remediation ? ` (${check.remediation})` : '';
    console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}${remediation}`);
  }
  console[report.ok ? 'log' : 'error'](`Luna model-routing global skill health check ${report.ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = report.ok ? 0 : 1;
}
