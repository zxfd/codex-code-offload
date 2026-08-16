import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchesCallerProject,
  normalizeProjectPath,
  validateProjectTarget,
  validateReadyThreadIdentity,
} from '../thread-identity.mjs';

const caller = {
  callerProjectId: 'project-123',
  callerProjectPath: '/workspace/repo/',
};

test('normalizes absolute paths without resolving through cwd', () => {
  assert.equal(normalizeProjectPath('/workspace/repo/./nested/..'), '/workspace/repo');
  assert.equal(normalizeProjectPath('workspace/repo'), null);
  assert.equal(normalizeProjectPath(undefined), null);
});

test('requires exact caller project ID and normalized absolute path', () => {
  assert.equal(matchesCallerProject({ projectId: 'project-123', path: '/workspace/repo' }, caller), true);
  assert.equal(matchesCallerProject({ projectId: 'other', path: '/workspace/repo' }, caller), false);
  assert.equal(matchesCallerProject({ projectId: 'project-123', path: '/workspace/other' }, caller), false);
  assert.equal(matchesCallerProject({ projectId: 'project-123', path: 'repo' }, caller), false);
});

test('accepts the tool-shaped Git project target with direct worktree environment', () => {
  const target = {
    target: {
      type: 'project',
      projectId: 'project-123',
      environment: { type: 'worktree' },
    },
    project: { projectId: 'project-123', path: '/workspace/repo', isGitRepository: true },
  };
  assert.equal(validateProjectTarget(target, { ...caller, isGitRepository: true }).ok, true);
});

test('accepts the tool-shaped non-Git project target with direct local environment', () => {
  const target = {
    target: {
      type: 'project',
      projectId: 'project-123',
      environment: { type: 'local' },
    },
    project: { projectId: 'project-123', path: '/workspace/repo', isGitRepository: false },
  };
  assert.equal(validateProjectTarget(target, { ...caller, isGitRepository: false }).ok, true);
});

test('rejects projectless, wrong environment, and legacy nested workspace targets', () => {
  for (const target of [
    { type: 'projectless', projectId: 'project-123', environment: { type: 'local' }, project: { projectId: 'project-123', path: '/workspace/repo' } },
    { type: 'project', projectId: 'project-123', environment: { type: 'cloud' }, project: { projectId: 'project-123', path: '/workspace/repo' } },
    { type: 'project', projectId: 'project-123', environment: { type: 'local', workspace: { type: 'local' } }, project: { projectId: 'project-123', path: '/workspace/repo' } },
    { type: 'project', projectId: 'project-123', environment: { type: 'worktree', workspace: { type: 'worktree' } }, project: { projectId: 'project-123', path: '/workspace/repo' } },
  ]) {
    assert.equal(validateProjectTarget(target, { ...caller, isGitRepository: true }).ok, false);
  }
});

test('accepts only ready Thread identity and rejects pending handles or guesses', () => {
  const ready = {
    threadId: 'thread-123',
    hostId: 'host-123',
    target: {
      type: 'project', projectId: 'project-123',
      environment: { type: 'worktree' },
    },
    project: { projectId: 'project-123', path: '/workspace/repo' },
  };
  assert.equal(validateReadyThreadIdentity(ready, { ...caller, isGitRepository: true }).ok, true);
  assert.equal(validateReadyThreadIdentity({ ...ready, clientThreadId: 'pending-1', threadId: undefined }, { ...caller, isGitRepository: true }).ok, false);
  assert.equal(validateReadyThreadIdentity({ ...ready, clientThreadId: 'pending-1' }, { ...caller, isGitRepository: true }).ok, false);
  assert.equal(validateReadyThreadIdentity({ ...ready, hostId: undefined }, { ...caller, isGitRepository: true }).ok, false);
  assert.equal(validateReadyThreadIdentity({ ...ready, project: { projectId: 'other', path: '/workspace/repo' } }, { ...caller, isGitRepository: true }).ok, false);
});
