import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSkillInstallIntegrityCheck } from '../verify-installed-skill.mjs';

function makeFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-skill-integrity-'));
  const sourceRoot = join(fixtureRoot, 'source-skill');
  const installedRoot = join(fixtureRoot, 'installed-skill');
  mkdirSync(join(sourceRoot, 'nested'), { recursive: true });
  mkdirSync(join(installedRoot, 'nested'), { recursive: true });
  return { fixtureRoot, sourceRoot, installedRoot };
}

test('passes for matching trees and installed file symlinks', async () => {
  const { fixtureRoot, sourceRoot, installedRoot } = makeFixture();
  try {
    const sourceNested = join(sourceRoot, 'nested', 'config.json');
    const installedNested = join(installedRoot, 'nested', 'config.json');
    writeFileSync(join(sourceRoot, 'SKILL.md'), 'source\n');
    writeFileSync(sourceNested, '{"ok":true}\n');
    writeFileSync(join(installedRoot, 'SKILL.md'), 'source\n');
    symlinkSync(relative(dirname(installedNested), sourceNested), installedNested);
    assert.equal((await runSkillInstallIntegrityCheck({ source: sourceRoot, installed: installedRoot })).ok, true);
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test('passes for a matching installed root symlink', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codex-skill-integrity-root-link-'));
  const sourceRoot = join(fixtureRoot, 'source');
  const target = join(fixtureRoot, 'target');
  const installedRoot = join(fixtureRoot, 'installed');
  mkdirSync(sourceRoot); mkdirSync(target);
  writeFileSync(join(sourceRoot, 'SKILL.md'), 'same\n');
  writeFileSync(join(target, 'SKILL.md'), 'same\n');
  symlinkSync(target, installedRoot);
  try { assert.equal((await runSkillInstallIntegrityCheck({ source: sourceRoot, installed: installedRoot })).ok, true); }
  finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test('executes when invoked through a symlinked script path', () => {
  const { fixtureRoot, sourceRoot, installedRoot } = makeFixture();
  try {
    writeFileSync(join(sourceRoot, 'SKILL.md'), 'source\n');
    writeFileSync(join(installedRoot, 'SKILL.md'), 'source\n');
    const linkedCli = join(fixtureRoot, 'verify-installed-skill.mjs');
    symlinkSync(fileURLToPath(new URL('../verify-installed-skill.mjs', import.meta.url)), linkedCli);
    const result = spawnSync(process.execPath, [linkedCli, '--source', sourceRoot, '--installed', installedRoot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /summary=checked_files:1 pass:1 fail:0/);
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test('fails for a missing nested installed resource', async () => {
  const { fixtureRoot, sourceRoot, installedRoot } = makeFixture();
  try {
    writeFileSync(join(sourceRoot, 'SKILL.md'), 'source\n');
    writeFileSync(join(sourceRoot, 'nested', 'resource.mjs'), 'export {};\n');
    writeFileSync(join(installedRoot, 'SKILL.md'), 'source\n');
    const report = await runSkillInstallIntegrityCheck({ source: sourceRoot, installed: installedRoot });
    assert.equal(report.ok, false);
    assert.equal(report.checks.some(item => item.name === 'installed:nested/resource.mjs' && item.kind === 'missing'), true);
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});

test('fails for changed installed resource content', async () => {
  const { fixtureRoot, sourceRoot, installedRoot } = makeFixture();
  try {
    writeFileSync(join(sourceRoot, 'SKILL.md'), 'source\n');
    writeFileSync(join(sourceRoot, 'nested', 'resource.mjs'), 'export const x = 1;\n');
    writeFileSync(join(installedRoot, 'SKILL.md'), 'source\n');
    writeFileSync(join(installedRoot, 'nested', 'resource.mjs'), 'export const x = 2;\n');
    const report = await runSkillInstallIntegrityCheck({ source: sourceRoot, installed: installedRoot });
    assert.equal(report.ok, false);
    assert.equal(report.checks.some(item => item.name === 'match:nested/resource.mjs' && item.kind === 'digest_mismatch'), true);
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
});
