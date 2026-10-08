import { describe, expect, it } from 'vitest';
import { normalizePaneState, normalizeSpaceKey, PaneStateStore, PANE_STATE_KEY } from '../../src/spaces/viewState';

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

  it('normalizes persisted bySpace keys and keeps unknown fields', () => {
    const normalized = normalizePaneState({ version: 1, future: 'retained', bySpace: { '/tmp/alpha/../alpha': { follow: true } } });
    expect(normalized.future).toBe('retained');
    expect(normalized.bySpace[normalizeSpaceKey('/tmp/alpha')].follow).toBe(true);
  });
});
