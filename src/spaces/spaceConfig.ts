import * as path from 'node:path';
import type { SpaceConfigEntry, SpaceDefinition } from '../types';

/** Values available for `${...}` interpolation in configured paths. */
export interface VariableContext {
  /** Absolute paths of the current workspace folders, in order. */
  workspaceFolders: string[];
  /** Absolute path of the user home directory. */
  userHome: string;
}

/** Paths that are not resolved (missing variables, relative without workspace). */
export function normalizeBasePath(value: string): string {
  return path.normalize(path.resolve(value));
}

/**
 * Interpolates `${workspaceFolder}`, `${workspaceFolders[N]}` and `${userHome}`.
 * Returns `undefined` when a variable cannot be resolved, so callers can skip
 * the entry instead of producing a bogus path.
 */
export function interpolateVariables(value: string, context: VariableContext): string | undefined {
  let failed = false;
  const result = value.replace(/\$\{([^}]+)\}/g, (match, expression: string) => {
    const token = expression.trim();
    if (token === 'workspaceFolder') {
      if (context.workspaceFolders.length === 0) {
        failed = true;
        return match;
      }
      return context.workspaceFolders[0];
    }
    if (token === 'userHome') {
      return context.userHome;
    }
    const indexed = /^workspaceFolders\[(\d+)\]$/.exec(token);
    if (indexed) {
      const index = Number(indexed[1]);
      const folder = context.workspaceFolders[index];
      if (!folder) {
        failed = true;
        return match;
      }
      return folder;
    }
    failed = true;
    return match;
  });
  return failed ? undefined : result;
}

/** Resolves one entry to an absolute path, or `undefined` when it cannot be resolved. */
export function resolveSpacePath(rawPath: string, context: VariableContext): string | undefined {
  const interpolated = interpolateVariables(rawPath, context);
  if (interpolated === undefined) {
    return undefined;
  }
  if (path.isAbsolute(interpolated)) {
    return normalizeBasePath(interpolated);
  }
  const base = context.workspaceFolders[0];
  if (!base) {
    return undefined;
  }
  return normalizeBasePath(path.join(base, interpolated));
}

/**
 * Normalizes raw configuration entries into `SpaceDefinition`s.
 * Invalid or unresolvable entries are skipped; duplicates (same resolved path)
 * keep their first occurrence.
 */
export function normalizeSpaceEntries(
  entries: readonly SpaceConfigEntry[] | undefined,
  context: VariableContext,
  defaultShowFiles: boolean
): SpaceDefinition[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set<string>();
  const definitions: SpaceDefinition[] = [];
  entries.forEach((entry, sourceIndex) => {
    const object = typeof entry === 'string' ? { path: entry } : entry;
    const rawPath = typeof object?.path === 'string' ? object.path.trim() : '';
    if (!rawPath) {
      return;
    }
    const basePath = resolveSpacePath(rawPath, context);
    if (!basePath) {
      return;
    }
    const key = process.platform === 'win32' ? basePath.toLowerCase() : basePath;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    definitions.push({
      basePath,
      name: typeof object.name === 'string' && object.name.trim() ? object.name.trim() : path.basename(basePath),
      icon: typeof object.icon === 'string' && object.icon.trim() ? object.icon.trim() : undefined,
      showFiles: typeof object.showFiles === 'boolean' ? object.showFiles : defaultShowFiles,
      include: toStringArray(object.include),
      exclude: toStringArray(object.exclude),
      sourceIndex,
    });
  });
  return definitions;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** Converts the supported glob subset: single/double stars, double-star slash, and question mark. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*' && normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else if (normalized[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** True when `name` (and optionally its relative path) matches any pattern. */
export function matchesAnyPattern(name: string, relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const candidates = relativePath && relativePath !== name ? [name, relativePath] : [name];
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
}

/** Whether a directory entry should be visible in a space. */
export function isVisibleDirectory(name: string, relativePath: string, exclude: readonly string[]): boolean {
  return !matchesAnyPattern(name, relativePath, exclude);
}

/** Whether a file entry should be visible in a space. */
export function isVisibleFile(
  name: string,
  relativePath: string,
  include: readonly string[],
  exclude: readonly string[]
): boolean {
  if (matchesAnyPattern(name, relativePath, exclude)) {
    return false;
  }
  if (include.length === 0) {
    return true;
  }
  return matchesAnyPattern(name, relativePath, include);
}
