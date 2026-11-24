import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export class PathError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function normalizeRelativePath(value) {
  if (typeof value !== 'string') {
    throw new PathError('INVALID_PATH', 'Enter a relative project path.');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255 || trimmed.includes('\0') || trimmed.includes('\\')) {
    throw new PathError('INVALID_PATH', 'Enter a valid relative path without backslashes.');
  }
  if (isAbsolute(trimmed) || trimmed.startsWith('/')) {
    throw new PathError('INVALID_PATH', 'Project path must be relative to PROJECTS_BASE_DIR.');
  }
  const segments = trimmed.replace(/\/+$/, '').split('/');
  if (!segments.length || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new PathError('INVALID_PATH', 'Project path cannot contain empty, ".", or ".." segments.');
  }
  return segments.join('/');
}

export async function resolveBaseDir(baseDir) {
  if (typeof baseDir !== 'string' || !baseDir.trim()) {
    throw new PathError('BASE_DIR_INVALID', 'PROJECTS_BASE_DIR is not configured.');
  }
  let canonicalBase;
  try {
    canonicalBase = await realpath(resolve(baseDir.trim()));
    const info = await stat(canonicalBase);
    if (!info.isDirectory()) {
      throw new PathError('BASE_DIR_INVALID', 'PROJECTS_BASE_DIR must be a directory.');
    }
  } catch (error) {
    if (error instanceof PathError) throw error;
    throw new PathError('BASE_DIR_INVALID', 'PROJECTS_BASE_DIR does not exist or cannot be accessed.');
  }
  return canonicalBase;
}

export async function resolveProjectPath(baseDir, relativePath) {
  const canonicalBase = await resolveBaseDir(baseDir);
  const normalized = normalizeRelativePath(relativePath);
  const prefix = canonicalBase.endsWith(sep) ? canonicalBase : canonicalBase + sep;

  const candidate = resolve(canonicalBase, normalized);
  if (!candidate.startsWith(prefix)) {
    throw new PathError('PATH_OUTSIDE_BASE', 'Project path must stay inside PROJECTS_BASE_DIR.');
  }

  let realTarget;
  try {
    realTarget = await realpath(candidate);
  } catch {
    throw new PathError('NOT_FOUND', 'Project directory does not exist inside PROJECTS_BASE_DIR.');
  }

  if (!realTarget.startsWith(prefix)) {
    throw new PathError('PATH_OUTSIDE_BASE', 'Project path resolves outside PROJECTS_BASE_DIR.');
  }

  let info;
  try {
    info = await stat(realTarget);
  } catch {
    throw new PathError('NOT_FOUND', 'Project directory cannot be accessed.');
  }
  if (!info.isDirectory()) {
    throw new PathError('NOT_DIRECTORY', 'Project path must point to a directory.');
  }

  return {
    baseDir: canonicalBase,
    relativePath: normalized,
    realPath: realTarget,
  };
}
