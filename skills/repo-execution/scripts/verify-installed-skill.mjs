#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node verify-installed-skill.mjs --source <path> --installed <path>';

function addCheck(report, check) {
  report.checks.push(check);
  if (check.status === 'fail') report.ok = false;
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function inspectRoot(rawPath, label, report) {
  const path = resolve(rawPath);
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch {
    addCheck(report, {
      name: `${label}_root`, status: 'fail', kind: 'missing', message: `${label} path not found: ${path}`,
      remediation: `Create or repair the ${label} directory and rerun this check.`, detail: { path },
    });
    return null;
  }
  let directoryStat;
  let resolvedTarget = path;
  try {
    if (linkStat.isSymbolicLink()) resolvedTarget = resolve(dirname(path), readlinkSync(path));
    directoryStat = statSync(resolvedTarget);
  } catch (error) {
    addCheck(report, {
      name: `${label}_root`, status: 'fail', kind: 'invalid_root', message: `${label} path is a broken symlink: ${path}`,
      remediation: `Repair the ${label} symlink to point to a real directory and rerun this check.`, detail: { path, error: error.message },
    });
    return null;
  }
  if (!directoryStat.isDirectory()) {
    addCheck(report, {
      name: `${label}_root`, status: 'fail', kind: 'invalid_root', message: `${label} path is not a directory: ${path}`,
      remediation: `Use a directory path for ${label}.`, detail: { path, resolvedTarget },
    });
    return null;
  }
  addCheck(report, {
    name: `${label}_root`, status: 'pass', kind: 'valid_root',
    message: linkStat.isSymbolicLink() ? `${label} root resolved via symlink at ${path} -> ${resolvedTarget}` : `${label} root resolved to ${path}`,
    detail: { path, isSymbolicLink: linkStat.isSymbolicLink(), resolvedTarget },
  });
  return path;
}

function comparableFile(filePath) {
  const info = lstatSync(filePath);
  if (info.isSymbolicLink()) {
    let target;
    try {
      target = realpathSync(filePath);
    } catch (error) {
      return { ok: false, kind: 'missing_target', message: `symlink target is missing for ${filePath}`, remediation: `Repair ${filePath} to point to an existing regular file.`, detail: { filePath, error: error.message } };
    }
    if (!statSync(target).isFile()) {
      return { ok: false, kind: 'unsupported_type', message: `symlink does not resolve to a regular file: ${filePath}`, remediation: 'Use a regular file or symlink to a regular file.', detail: { filePath, target } };
    }
    return { ok: true, kind: 'symlink', digest: hashFile(target) };
  }
  if (!info.isFile()) {
    return { ok: false, kind: 'unsupported_type', message: `unsupported file type: ${filePath}`, remediation: 'Only regular files and symlinked regular files are supported.', detail: { filePath } };
  }
  return { ok: true, kind: 'file', digest: hashFile(filePath) };
}

function verifyFile({ relativePath, sourcePath, installedPath, report }) {
  let source;
  try {
    source = comparableFile(sourcePath);
  } catch (error) {
    addCheck(report, { name: `source:${relativePath}`, status: 'fail', kind: 'source_read_error', message: `failed to read source entry ${relativePath}: ${error.message}`, remediation: `Repair source tree at ${sourcePath}.`, detail: { sourcePath } });
    return;
  }
  if (!source.ok) {
    addCheck(report, { name: `source:${relativePath}`, status: 'fail', kind: source.kind, message: source.message, remediation: source.remediation, detail: source.detail });
    return;
  }
  if (!existsSync(installedPath)) {
    addCheck(report, { name: `installed:${relativePath}`, status: 'fail', kind: 'missing', message: `missing installed entry for source path ${relativePath}`, remediation: `Copy or symlink the source file into the installed Skill tree at ${installedPath}.`, detail: { sourcePath, installedPath } });
    return;
  }
  let installed;
  try {
    installed = comparableFile(installedPath);
  } catch (error) {
    addCheck(report, { name: `installed:${relativePath}`, status: 'fail', kind: 'installed_read_error', message: `failed to read installed entry ${relativePath}: ${error.message}`, remediation: `Repair installed Skill file at ${installedPath}.`, detail: { sourcePath, installedPath } });
    return;
  }
  if (!installed.ok) {
    addCheck(report, { name: `installed:${relativePath}`, status: 'fail', kind: installed.kind, message: installed.message, remediation: installed.remediation, detail: installed.detail });
    return;
  }
  if (source.digest !== installed.digest) {
    addCheck(report, { name: `match:${relativePath}`, status: 'fail', kind: 'digest_mismatch', message: `content digest mismatch for ${relativePath}`, remediation: 'Replace the installed file with the source version or fix its forwarding/symlink target.', detail: { sourcePath, installedPath, sourceDigest: source.digest, installedDigest: installed.digest } });
    return;
  }
  addCheck(report, { name: `match:${relativePath}`, status: 'pass', kind: 'digest_match', message: `matched content for ${relativePath}`, detail: { sourceKind: source.kind, installedKind: installed.kind } });
}

function walkSource(sourceDirectory, installedDirectory, sourceRoot, report) {
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name);
    const installedPath = join(installedDirectory, entry.name);
    if (entry.isDirectory()) {
      walkSource(sourcePath, installedPath, sourceRoot, report);
      continue;
    }
    const relativePath = relative(sourceRoot, sourcePath).replace(/\\/g, '/');
    report.summaryStats.checkedFiles += 1;
    if (entry.isFile() || entry.isSymbolicLink()) {
      verifyFile({ relativePath, sourcePath, installedPath, report });
    } else {
      addCheck(report, { name: `source:${relativePath}`, status: 'fail', kind: 'unsupported_entry_type', message: `unsupported source entry type: ${relativePath}`, remediation: 'Keep Skill packages file-based.', detail: { sourcePath } });
    }
  }
}

export async function runSkillInstallIntegrityCheck({ source, installed } = {}) {
  const report = { ok: true, sourceRoot: null, installedRoot: null, checks: [], summaryStats: { checkedFiles: 0, passingFiles: 0, failingFiles: 0 } };
  const sourceRoot = source && inspectRoot(source, 'source', report);
  const installedRoot = installed && inspectRoot(installed, 'installed', report);
  if (!sourceRoot || !installedRoot) return report;
  report.sourceRoot = sourceRoot;
  report.installedRoot = installedRoot;
  walkSource(sourceRoot, installedRoot, sourceRoot, report);
  for (const check of report.checks) {
    if (check.name.startsWith('match:') && check.status === 'pass') report.summaryStats.passingFiles += 1;
    if (check.status === 'fail') report.summaryStats.failingFiles += 1;
  }
  return report;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { source: null, installed: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ((argument === '--source' || argument === '--installed') && argv[index + 1]) {
      options[argument.slice(2)] = argv[index + 1];
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.source || !options.installed) throw new Error(USAGE);
  return options;
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
  try {
    const options = parseArgs();
    const report = await runSkillInstallIntegrityCheck(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) {
        console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}${check.remediation ? ` (${check.remediation})` : ''}`);
      }
      console.log(`summary=checked_files:${report.summaryStats.checkedFiles} pass:${report.summaryStats.passingFiles} fail:${report.summaryStats.failingFiles}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    console.error(USAGE);
    process.exitCode = 2;
  }
}
