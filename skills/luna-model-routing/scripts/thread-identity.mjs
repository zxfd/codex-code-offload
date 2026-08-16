import { isAbsolute, normalize } from 'node:path';

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Normalize an absolute project path without consulting cwd or the filesystem. */
export function normalizeProjectPath(value) {
  const path = nonEmptyString(value);
  if (!path || !isAbsolute(path)) return null;
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function projectIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const project = value.project && typeof value.project === 'object' ? value.project : value;
  return {
    projectId: nonEmptyString(project.projectId ?? project.id),
    projectPath: normalizeProjectPath(project.projectPath ?? project.path ?? project.rootPath),
    isGitRepository: typeof project.isGitRepository === 'boolean' ? project.isGitRepository : null,
  };
}

function targetIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const target = value.target && typeof value.target === 'object' ? value.target : value;
  const environment = target.environment && typeof target.environment === 'object'
    ? target.environment
    : null;
  return {
    type: target.type ?? null,
    projectId: nonEmptyString(target.projectId),
    environmentType: environment?.type ?? null,
    hasLegacyWorkspace: Boolean(environment && Object.hasOwn(environment, 'workspace')),
  };
}

/** Match a list_projects record to the caller by both exact ID and normalized path. */
export function matchesCallerProject(record, { callerProjectId, callerProjectPath } = {}) {
  const expectedId = nonEmptyString(callerProjectId);
  const expectedPath = normalizeProjectPath(callerProjectPath);
  const actual = projectIdentity(record);
  return Boolean(
    expectedId && expectedPath && actual
      && actual.projectId === expectedId
      && actual.projectPath === expectedPath,
  );
}

/** Validate the project target shape selected for a local Git or non-Git worker. */
export function validateProjectTarget(target, {
  callerProjectId,
  callerProjectPath,
  isGitRepository,
} = {}) {
  const expectedPath = normalizeProjectPath(callerProjectPath);
  const targetInfo = targetIdentity(target);
  const environmentType = isGitRepository ? 'worktree' : 'local';
  const project = projectIdentity(target);
  return {
    ok: Boolean(
      matchesCallerProject(project, { callerProjectId, callerProjectPath })
      && targetInfo?.type === 'project'
      && targetInfo.projectId === callerProjectId
      && targetInfo.environmentType === environmentType
      && !targetInfo.hasLegacyWorkspace
      && project.projectPath === expectedPath
    ),
    reason: !expectedPath || !nonEmptyString(callerProjectId)
      ? 'caller project ID and absolute path are required'
      : null,
  };
}

/**
 * Accept only a real, ready Thread. A clientThreadId is a pending setup handle,
 * not a substitute for threadId and hostId.
 */
export function validateReadyThreadIdentity(thread, {
  callerProjectId,
  callerProjectPath,
  isGitRepository,
} = {}) {
  const threadInfo = thread && typeof thread === 'object' ? thread : {};
  const threadId = nonEmptyString(threadInfo.threadId);
  const hostId = nonEmptyString(threadInfo.hostId);
  const hasPendingHandle = nonEmptyString(threadInfo.clientThreadId) !== null;
  const target = {
    ...(threadInfo.target ?? threadInfo.projectTarget ?? {}),
    project: threadInfo.project ?? threadInfo.target?.project ?? threadInfo.projectTarget?.project,
  };
  const targetResult = validateProjectTarget(target, {
    callerProjectId,
    callerProjectPath,
    isGitRepository,
  });
  return {
    ok: Boolean(threadId && hostId && !hasPendingHandle && targetResult.ok),
    reason: !threadId || !hostId
      ? 'ready Thread requires non-empty threadId and hostId'
      : hasPendingHandle
        ? 'clientThreadId is only a pending setup handle'
        : targetResult.ok ? null : 'Thread project target does not exactly match caller project',
  };
}
