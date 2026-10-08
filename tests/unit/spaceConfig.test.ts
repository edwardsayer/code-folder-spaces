import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  globToRegExp,
  interpolateVariables,
  isVisibleFile,
  matchesAnyPattern,
  normalizeSpaceEntries,
  resolveSpacePath,
} from '../../src/spaces/spaceConfig';

const context = {
  workspaceFolders: [path.resolve('/repo')],
  userHome: path.resolve('/home/user'),
};

describe('interpolateVariables', () => {
  it('resolves workspaceFolder and userHome', () => {
    expect(interpolateVariables('${workspaceFolder}/src', context)).toBe(`${path.resolve('/repo')}/src`);
    expect(interpolateVariables('${userHome}/notes', context)).toBe(`${path.resolve('/home/user')}/notes`);
  });

  it('resolves indexed workspace folders', () => {
    const twoFolders = { ...context, workspaceFolders: [path.resolve('/repo'), path.resolve('/other')] };
    expect(interpolateVariables('${workspaceFolders[1]}/docs', twoFolders)).toBe(`${path.resolve('/other')}/docs`);
  });

  it('returns undefined for unknown or out-of-range variables', () => {
    expect(interpolateVariables('${unknown}/x', context)).toBeUndefined();
    expect(interpolateVariables('${workspaceFolders[3]}/x', context)).toBeUndefined();
  });
});

describe('resolveSpacePath', () => {
  it('keeps absolute paths', () => {
    expect(resolveSpacePath(path.resolve('/absolute/folder'), context)).toBe(path.normalize(path.resolve('/absolute/folder')));
  });

  it('resolves relative paths against the first workspace folder', () => {
    expect(resolveSpacePath('packages/app', context)).toBe(path.normalize(path.resolve('/repo/packages/app')));
  });

  it('returns undefined for relative paths without a workspace folder', () => {
    expect(resolveSpacePath('packages/app', { ...context, workspaceFolders: [] })).toBeUndefined();
  });
});

describe('normalizeSpaceEntries', () => {
  it('normalizes string and object entries with defaults', () => {
    const definitions = normalizeSpaceEntries(
      [path.resolve('/repo/src'), { path: path.resolve('/repo/docs'), name: 'Docs', showFiles: false, exclude: ['draft/**'] }],
      context,
      true
    );
    expect(definitions).toHaveLength(2);
    expect(definitions[0]).toMatchObject({ basePath: path.normalize(path.resolve('/repo/src')), name: 'src', showFiles: true, sourceIndex: 0 });
    expect(definitions[1]).toMatchObject({ basePath: path.normalize(path.resolve('/repo/docs')), name: 'Docs', showFiles: false, exclude: ['draft/**'], sourceIndex: 1 });
  });

  it('skips invalid, unresolvable and duplicate entries', () => {
    const definitions = normalizeSpaceEntries(
      ['', { path: '${missing}/x' }, path.resolve('/repo/src'), path.resolve('/repo/src')],
      context,
      true
    );
    expect(definitions).toHaveLength(1);
    expect(definitions[0].sourceIndex).toBe(2);
  });

  it('tolerates non-array input', () => {
    expect(normalizeSpaceEntries(undefined, context, true)).toEqual([]);
  });
});

describe('glob matching', () => {
  it('converts patterns to anchored regexes', () => {
    expect(globToRegExp('*.log').test('app.log')).toBe(true);
    expect(globToRegExp('*.log').test('nested/app.log')).toBe(false);
    expect(globToRegExp('**/dist/**').test('packages/app/dist/out.js')).toBe(true);
  });

  it('matches name or relative path', () => {
    expect(matchesAnyPattern('app.log', 'logs/app.log', ['logs/*.log'])).toBe(true);
    expect(matchesAnyPattern('app.log', 'logs/app.log', ['*.txt'])).toBe(false);
  });

  it('applies include and exclude rules to files', () => {
    expect(isVisibleFile('app.ts', 'src/app.ts', ['**/*.ts'], [])).toBe(true);
    expect(isVisibleFile('app.js', 'src/app.js', ['**/*.ts'], [])).toBe(false);
    expect(isVisibleFile('app.ts', 'src/app.ts', ['**/*.ts'], ['src/**'])).toBe(false);
    expect(isVisibleFile('app.ts', 'src/app.ts', [], ['**/dist/**'])).toBe(true);
  });
});
