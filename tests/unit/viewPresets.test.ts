import { describe, expect, it } from 'vitest';
import { buildFlatListing } from '../../src/spaces/flatListing';
import { VIEW_PRESETS } from '../../src/spaces/viewPresets';
import { normalizePaneState, normalizeSpaceKey, PaneStateStore, PANE_STATE_KEY } from '../../src/spaces/viewState';

describe('view presets and state', () => {
  it('maps all seven presets to their designed mode, level, and content', () => {
    expect(VIEW_PRESETS).toEqual({
      Explorer: { mode: 'tree', level: 'all', content: 'all' },
      Navigate: { mode: 'tree', level: 'all', content: 'folders' },
      Columns: { mode: 'tree', level: 1, content: 'folders' },
      Context: { mode: 'tree', level: 2, content: 'folders' },
      Contents: { mode: 'flat', level: 'all', content: 'all' },
      Files: { mode: 'flat', level: 'all', content: 'files' },
      List: { mode: 'flat', level: 1, content: 'files' },
    });
  });

  it('normalizes missing, wrong-version, and malformed per-space fields independently', () => {
    expect(normalizePaneState(undefined)).toEqual({ version: 1, bySpace: {} });
    expect(normalizePaneState({ version: 2, bySpace: { a: { preset: 'Files' } } })).toEqual({ version: 1, bySpace: {} });
    expect(normalizePaneState({ version: 1, bySpace: { a: { preset: 'bogus' }, b: { preset: 'Files' } } })).toEqual({
      version: 1, bySpace: {
        a: { preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [] },
        b: { preset: 'Files', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [] },
      },
    });
  });

  it('persists by-space state under the v1 workspace key', async () => {
    const values = new Map<string, unknown>();
    const state = new PaneStateStore({ get: (key) => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await state.setPreset('/space', 'Files');
    expect(values.get(PANE_STATE_KEY)).toEqual({ version: 1, bySpace: { [normalizeSpaceKey('/space')]: { preset: 'Files', filter: '', sort: { key: 'name', direction: 'asc' } } } });
    expect(state.get('/space').preset).toBe('Files');
  });

  it('applies flat levels 1/2/all and keeps the maxDepth protection for all', async () => {
    const entries = new Map<string, { value: string; isDirectory: boolean }[]>([
      ['', [{ value: 'd1', isDirectory: true }, { value: 'root.txt', isDirectory: false }]],
      ['d1', [{ value: 'd2', isDirectory: true }, { value: 'nested.txt', isDirectory: false }]],
      ['d2', [{ value: 'd3', isDirectory: true }, { value: 'deep.txt', isDirectory: false }]],
      ['d3', [{ value: 'too-deep.txt', isDirectory: false }]],
    ]);
    const read = async (parent?: string) => entries.get(parent ?? '') ?? [];
    expect(await buildFlatListing(read, 10, 1)).toEqual([
      { value: 'd1', isDirectory: true, depth: 1 },
      { value: 'root.txt', isDirectory: false, depth: 1 },
    ]);
    expect((await buildFlatListing(read, 10, 1)).some((entry) => entry.value === 'nested.txt')).toBe(false);
    expect((await buildFlatListing(read, 10, 2)).map((entry) => entry.value)).toEqual(['d1', 'd2', 'nested.txt', 'root.txt']);
    expect((await buildFlatListing(read, 3, 'all')).map((entry) => entry.value)).toEqual([
      'd1', 'd2', 'd3', 'deep.txt', 'nested.txt', 'root.txt',
    ]);
  });
});
