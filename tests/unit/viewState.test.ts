import { describe, expect, it } from 'vitest';
import { classifySpaceRename, normalizePaneState, normalizeSpaceKey, PaneStateStore, PANE_STATE_KEY, renameSpaceKeys, rewriteRenamedPath } from '../../src/spaces/viewState';
import { isAllowedSpaceRoot, isValidSpaceRoot, validateSpaceName } from '../../src/spaces/spaceActions';

function memory(initial: unknown) {
  let value = initial;
  return {
    get: <T>() => value as T | undefined,
    update: async (_key: string, next: unknown) => { value = next; },
    read: () => value,
  };
}

describe('pane view state', () => {
  it('preserves unknown pane and per-space fields after view state updates', async () => {
    const source = {
      version: 1,
      panes: [{ id: 'pane1', follow: true }],
      bySpace: {
        '/workspace/alpha': {
          preset: 'Explorer',
          filter: '',
          sort: { key: 'name', direction: 'asc' },
          follow: false,
        },
      },
    };
    const store = memory(source);
    const state = new PaneStateStore(store);

    await state.setPreset('/workspace/alpha', 'Contents');
    await state.setFilter('/workspace/alpha', 'nested');
    await state.setSort('/workspace/alpha', 'mtime', 'desc');

    const saved = store.read() as typeof source;
    expect(saved.panes).toEqual(source.panes);
    expect((saved.bySpace as Record<string, unknown>)[normalizeSpaceKey('/workspace/alpha')]).toMatchObject({
      preset: 'Contents', filter: 'nested', sort: { key: 'mtime', direction: 'desc' }, follow: false,
    });
    expect(PANE_STATE_KEY).toBe('codeFolderSpaces.panes.v1');
  });

  it('normalizes path keys for host platform semantics', () => {
    expect(normalizeSpaceKey('/workspace/alpha/../alpha')).toBe(normalizeSpaceKey('/workspace/alpha'));
    if (process.platform === 'win32') {
      expect(normalizeSpaceKey('C:\\Workspace\\Alpha')).toBe(normalizeSpaceKey('c:\\workspace\\alpha'));
    } else {
      expect(normalizeSpaceKey('/workspace/Alpha')).not.toBe(normalizeSpaceKey('/workspace/alpha'));
    }
  });

  it('validates candidate roots within the original root and rejects outside paths', () => {
    const base = process.platform === 'win32' ? 'C:\\spaces\\alpha' : '/spaces/alpha';
    const inside = process.platform === 'win32' ? 'C:\\spaces\\alpha\\nested' : '/spaces/alpha/nested';
    const outside = process.platform === 'win32' ? 'C:\\spaces\\alphabet' : '/spaces/alphabet';
    expect(isAllowedSpaceRoot(base, base)).toBe(true);
    expect(isAllowedSpaceRoot(base, inside)).toBe(true);
    expect(isAllowedSpaceRoot(base, outside)).toBe(false);
  });

  it('rejects non-directories and missing paths when validating root candidates', async () => {
    const base = '/spaces/alpha';
    const inside = '/spaces/alpha/nested';
    expect(await isValidSpaceRoot(base, inside, async () => true)).toBe(true);
    expect(await isValidSpaceRoot(base, '/spaces/other', async () => true)).toBe(false);
    expect(await isValidSpaceRoot(base, inside, async () => false)).toBe(false);
    expect(await isValidSpaceRoot(base, inside, async () => { throw new Error('missing'); })).toBe(false);
  });

  it('accepts only changed nonblank space names', () => {
    expect(validateSpaceName('Alpha', '   ')).toBeUndefined();
    expect(validateSpaceName('Alpha', 'Alpha')).toBeUndefined();
    expect(validateSpaceName('Alpha', '  New name  ')).toBe('New name');
  });

  it('switching root clears drill history without changing other pane state', async () => {
    const store = memory(undefined);
    const state = new PaneStateStore(store);
    await state.setPreset('/space', 'Files');
    await state.drillDown('/space', '/space/nested');
    await state.switchRoot('/space', '/space/other');
    expect(state.get('/space')).toMatchObject({ root: '/space/other', preset: 'Explorer', drillStack: [] });
  });

  it('drills down and restores the complete prior view state; empty stack is a no-op', async () => {
    const store = memory(undefined);
    const state = new PaneStateStore(store);
    await state.setPreset('/space', 'Files');
    await state.setFilter('/space', 'nested');
    await state.setSort('/space', 'mtime', 'desc');
    await state.drillDown('/space', '/space/nested');
    expect(state.get('/space')).toMatchObject({ root: '/space/nested', preset: 'Explorer', filter: 'nested', sort: { key: 'mtime', direction: 'desc' }, drillStack: [{ root: '/space', preset: 'Files', filter: 'nested', sort: { key: 'mtime', direction: 'desc' } }] });
    expect(await state.drillUp('/space')).toBe(true);
    expect(state.get('/space')).toMatchObject({ root: '/space', preset: 'Files', filter: 'nested', sort: { key: 'mtime', direction: 'desc' }, drillStack: [] });
    expect(await state.drillUp('/space')).toBe(false);
  });

  it('classifies root, nested, and unrelated renames and rewrites nested paths', () => {
    expect(classifySpaceRename(['/space'], '/space')).toEqual({ kind: 'space-root' });
    expect(classifySpaceRename(['/space'], '/space/a')).toEqual({ kind: 'inside-space', basePath: '/space' });
    expect(classifySpaceRename(['/space'], '/other')).toEqual({ kind: 'unrelated' });
    const original = { version: 1, bySpace: { '/space': { root: '/space/a/deep', preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [{ root: '/space/a', preset: 'Files', filter: '', sort: { key: 'name', direction: 'asc' } }, { root: '/space/nope', preset: 'List', filter: '', sort: { key: 'ctime', direction: 'desc' } }] } } };
    const rewritten = rewriteRenamedPath(original, '/space', '/space/a', '/space/b');
    expect(rewritten.bySpace[normalizeSpaceKey('/space')].root).toBe(normalizeSpaceKey('/space/b/deep'));
    expect(rewritten.bySpace[normalizeSpaceKey('/space')].drillStack?.map(item => normalizeSpaceKey(item.root))).toEqual([normalizeSpaceKey('/space/b'), normalizeSpaceKey('/space/nope')]);
  });

  it('migrates renamed space keys without losing per-space state', () => {
    const source = { version: 1, bySpace: { '/space': { root: '/space/deep', preset: 'Contents', filter: 'x', sort: { key: 'mtime', direction: 'desc' }, drillStack: [{ root: '/space', preset: 'Files', filter: '', sort: { key: 'name', direction: 'asc' } }] } } };
    const migrated = renameSpaceKeys(source, '/space', '/renamed');
    expect(migrated.bySpace[normalizeSpaceKey('/space')]).toBeUndefined();
    expect(migrated.bySpace[normalizeSpaceKey('/renamed')]).toMatchObject({ root: normalizeSpaceKey('/renamed/deep'), preset: 'Contents', drillStack: [{ root: normalizeSpaceKey('/renamed') }] });
  });

  it('normalizes persisted bySpace keys and keeps unknown fields', () => {
    const normalized = normalizePaneState({ version: 1, future: 'retained', bySpace: { '/tmp/alpha/../alpha': { follow: true } } });
    expect(normalized.future).toBe('retained');
    expect(normalized.bySpace[normalizeSpaceKey('/tmp/alpha')].follow).toBe(true);
  });
});
