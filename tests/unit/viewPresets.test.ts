import { describe, expect, it } from 'vitest';
import { buildFlatListing } from '../../src/spaces/flatListing';
import { applyViewAxis, isViewSettings, matchPresetName, VIEW_PRESETS } from '../../src/spaces/viewPresets';
import { effectiveView, PaneStateStore } from '../../src/spaces/viewState';

describe('view presets and layout-backed view state', () => {
  it('maps presets and identifies the flat level-one all-content combination', () => {
    expect(VIEW_PRESETS.Items).toEqual({ mode: 'flat', level: 1, content: 'all' });
    expect(matchPresetName(applyViewAxis(VIEW_PRESETS.Explorer, 'mode', 'flat'))).toBe('Contents');
    const custom = applyViewAxis(VIEW_PRESETS.Explorer, 'content', 'folders');
    expect(isViewSettings(custom)).toBe(true);
    expect(matchPresetName(custom)).toBe('Navigate');
  });

  it('persists presets and axis changes as view combinations', async () => {
    const values = new Map<string, unknown>();
    const state = new PaneStateStore({ get: key => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await state.initialize({});
    await state.setPreset('pane1', 'Files');
    expect(effectiveView(state.get('pane1'))).toEqual(VIEW_PRESETS.Files);
    await state.setViewAxis('pane1', { axis: 'content', value: 'folders' });
    expect(effectiveView(state.get('pane1'))).toEqual({ mode: 'flat', level: 'all', content: 'folders' });
  });

  it('lists flat entries at selected levels', async () => {
    const entries = new Map<string, { value: string; isDirectory: boolean }[]>([
      ['', [{ value: 'd1', isDirectory: true }, { value: 'root.txt', isDirectory: false }]],
      ['d1', [{ value: 'nested.txt', isDirectory: false }]],
    ]);
    const read = async (parent?: string) => entries.get(parent ?? '') ?? [];
    expect((await buildFlatListing(read, 10, 1)).map(entry => entry.value)).toEqual(['d1', 'root.txt']);
    expect((await buildFlatListing(read, 10, 2)).map(entry => entry.value)).toEqual(['d1', 'nested.txt', 'root.txt']);
  });
});
