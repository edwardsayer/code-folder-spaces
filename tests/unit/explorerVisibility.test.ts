import { describe, expect, it } from 'vitest';
import {
  matchesGitIgnoreRule,
  normalizeExcludeSetting,
  parseGitIgnore,
  shouldHideLikeExplorer,
} from '../../src/spaces/explorerVisibility';

/**
 * S4.1R20（使用者需求）：Folder Space 跟隨 VS Code 內建 Explorer 的隱藏規則。
 * Explorer 來源＝`files.exclude`（值為 true）＋（選用）`explorer.excludeGitIgnore` 的 .gitignore。
 */
describe('Explorer-equivalent visibility (S4.1R20)', () => {
  describe('normalizeExcludeSetting', () => {
    it('keeps only patterns explicitly set to true, preserving declaration order', () => {
      expect(normalizeExcludeSetting({ '**/node_modules': true, '**/dist': false, '**/.cache': true }))
        .toEqual(['**/node_modules', '**/.cache']);
    });

    it('tolerates non-object and empty values', () => {
      expect(normalizeExcludeSetting(undefined)).toEqual([]);
      expect(normalizeExcludeSetting(null)).toEqual([]);
      expect(normalizeExcludeSetting('nope')).toEqual([]);
      expect(normalizeExcludeSetting({})).toEqual([]);
    });
  });

  describe('parseGitIgnore', () => {
    it('skips blank lines and comments, and records negation/directory/anchored flags', () => {
      const rules = parseGitIgnore([
        '# comment',
        '',
        'node_modules/',
        '!keep.txt',
        '/root-only',
        'docs/build',
      ].join('\n'));
      expect(rules).toEqual([
        { pattern: 'node_modules', negated: false, directoryOnly: true, anchored: false },
        { pattern: 'keep.txt', negated: true, directoryOnly: false, anchored: false },
        { pattern: 'root-only', negated: false, directoryOnly: false, anchored: true },
        { pattern: 'docs/build', negated: false, directoryOnly: false, anchored: true },
      ]);
    });

    it('handles CRLF line endings', () => {
      expect(parseGitIgnore('dist/\r\n*.log\r\n')).toHaveLength(2);
    });
  });

  describe('matchesGitIgnoreRule', () => {
    const rule = (pattern: string, extra: Partial<Parameters<typeof parseGitIgnore>[0] extends never ? never : { negated: boolean; directoryOnly: boolean; anchored: boolean }> = {}) =>
      ({ pattern, negated: false, directoryOnly: false, anchored: false, ...extra });

    it('matches an unanchored name at any depth', () => {
      const r = rule('node_modules', { directoryOnly: true });
      expect(matchesGitIgnoreRule(r, 'node_modules', true)).toBe(true);
      expect(matchesGitIgnoreRule(r, 'packages/app/node_modules', true)).toBe(true);
    });

    it('matches directory-only rules only for directories', () => {
      const r = rule('build', { directoryOnly: true });
      expect(matchesGitIgnoreRule(r, 'build', true)).toBe(true);
      expect(matchesGitIgnoreRule(r, 'build', false)).toBe(false);
    });

    it('matches anchored rules only from the root', () => {
      const r = rule('docs/build', { anchored: true });
      expect(matchesGitIgnoreRule(r, 'docs/build', true)).toBe(true);
      expect(matchesGitIgnoreRule(r, 'src/docs/build', true)).toBe(false);
    });

    it('supports * and ** wildcards', () => {
      expect(matchesGitIgnoreRule(rule('*.log'), 'a.log', false)).toBe(true);
      expect(matchesGitIgnoreRule(rule('*.log'), 'nested/a.log', false)).toBe(true);
      expect(matchesGitIgnoreRule(rule('**/temp/**.txt'), 'a/temp/b.txt', false)).toBe(true);
    });
  });

  describe('shouldHideLikeExplorer', () => {
    const never = () => false;
    const matchBySuffix = (pattern: string, relativePath: string) =>
      // 簡化版 files.exclude 比對：以樣式結尾或包含比對（真實專案用 spaceConfig 的 glob）。
      relativePath === pattern || relativePath.endsWith(`/${pattern}`) || pattern === `**/${relativePath}`;

    it('hides a path matched by files.exclude', () => {
      expect(shouldHideLikeExplorer('node_modules', true, ['node_modules'], [], matchBySuffix)).toBe(true);
      expect(shouldHideLikeExplorer('src/app.ts', false, ['node_modules'], [], matchBySuffix)).toBe(false);
    });

    it('hides a path matched by .gitignore when no exclude pattern matches', () => {
      const rules = parseGitIgnore('dist/\n');
      expect(shouldHideLikeExplorer('dist', true, [], rules, never)).toBe(true);
      expect(shouldHideLikeExplorer('dist', false, [], rules, never)).toBe(false);
    });

    it('lets a later negated gitignore rule re-include a path', () => {
      const rules = parseGitIgnore('*.log\n!keep.log\n');
      expect(shouldHideLikeExplorer('a.log', false, [], rules, never)).toBe(true);
      expect(shouldHideLikeExplorer('keep.log', false, [], rules, never)).toBe(false);
    });

    it('does not let gitignore negation override files.exclude (matches VS Code)', () => {
      const rules = parseGitIgnore('!secret\n');
      expect(shouldHideLikeExplorer('secret', false, ['secret'], rules, matchBySuffix)).toBe(true);
    });

    it('returns false when no rules are configured', () => {
      expect(shouldHideLikeExplorer('anything', false, [], [], never)).toBe(false);
    });
  });
});
