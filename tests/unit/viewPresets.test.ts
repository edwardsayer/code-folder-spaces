import { describe, expect, it } from 'vitest';
import { buildFlatListing } from '../../src/spaces/flatListing';
import { applyViewAxis, isViewSettings, matchPresetName, VIEW_PRESETS } from '../../src/spaces/viewPresets';
import { effectiveView, normalizePaneState, PaneStateStore, PANE_STATE_KEY } from '../../src/spaces/viewState';

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

  it('normalizes missing, wrong-version, and malformed per-pane fields independently', () => {
    expect(normalizePaneState(undefined)).toEqual({ version: 3, panes: {} });
    expect(normalizePaneState({ version: 1, bySpace: { a: { preset: 'Files' } } })).toEqual({ version: 3, panes: {} });
    expect(normalizePaneState({ version: 2, panes: { pane1: { preset: 'bogus' }, pane2: { preset: 'Files' } } })).toEqual({ version: 3, panes: {} });
    expect(normalizePaneState({ version: 3, panes: { pane1: { preset: 'bogus' }, pane2: { preset: 'Files' } } })).toEqual({
      version: 3, panes: {
        pane1: { roots: [], drillRoot: null, parentPaneId: null, follow: false, followWorkspaceDirectory: true, preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [], icon: null, showFiles: true, include: [], exclude: [] },
        pane2: { roots: [], drillRoot: null, parentPaneId: null, follow: false, followWorkspaceDirectory: false, preset: 'Files', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [], icon: null, showFiles: true, include: [], exclude: [] },
      },
    });
  });

  it('persists per-pane state under the v3 workspace key', async () => {
    const values = new Map<string, unknown>();
    const state = new PaneStateStore({ get: (key) => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await state.initialize({ spaces: [], showFilesDefault: true, configuredCount: 2, followWorkspaceDirectoryDefault: false });
    await state.setPreset('pane1', 'Files');
    const saved = values.get(PANE_STATE_KEY) as { version: number; panes: Record<string, { preset: string }> };
    expect(saved.version).toBe(3);
    expect(saved.panes.pane1.preset).toBe('Files');
    expect('bySpace' in saved).toBe(false);
    expect(state.get('pane1').preset).toBe('Files');
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

describe('檢視維度解耦（S4.1R7／OP-14）', () => {
  const newStore = async () => {
    const values = new Map<string, unknown>();
    const state = new PaneStateStore({ get: (key) => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await state.initialize({ spaces: [], showFilesDefault: true, configuredCount: 2, followWorkspaceDirectoryDefault: false });
    return { state, values };
  };

  it('applyViewAxis 只改單一維度；matchPresetName 判定是否恰為預設集', () => {
    const explorer = VIEW_PRESETS.Explorer;
    expect(applyViewAxis(explorer, 'mode', 'flat')).toEqual({ mode: 'flat', level: 'all', content: 'all' });
    expect(matchPresetName(applyViewAxis(explorer, 'mode', 'flat'))).toBe('Contents');
    // flat + folders 不在任何預設集內，但必須是合法的自訂組合。
    const flatFolders = applyViewAxis(applyViewAxis(explorer, 'mode', 'flat'), 'content', 'folders');
    expect(flatFolders).toEqual({ mode: 'flat', level: 'all', content: 'folders' });
    expect(matchPresetName(flatFolders)).toBeUndefined();
    expect(isViewSettings(flatFolders)).toBe(true);
    expect(isViewSettings({ mode: 'flat', level: 3, content: 'all' })).toBe(false);
  });

  it('setViewAxis：預設集外的組合存為 view；回到預設集時清除 view', async () => {
    const { state } = await newStore();
    await state.setPreset('pane1', 'Contents');
    await state.setViewAxis('pane1', { axis: 'content', value: 'folders' });
    expect(state.get('pane1').view).toEqual({ mode: 'flat', level: 'all', content: 'folders' });
    expect(effectiveView(state.get('pane1'))).toEqual({ mode: 'flat', level: 'all', content: 'folders' });
    // 層級、內容維持不變，只翻模式 → Navigate（恰為預設集）。
    await state.setViewAxis('pane1', { axis: 'mode', value: 'tree' });
    expect(state.get('pane1').view).toBeUndefined();
    expect(state.get('pane1').preset).toBe('Navigate');
  });

  it('setPreset 一次套用三維並清除自訂組合；view 隨 reload 保存且無效值被丟棄', async () => {
    const { state, values } = await newStore();
    await state.setViewAxis('pane1', { axis: 'level', value: 2 }); // tree + all + level 2 → 自訂
    expect(state.get('pane1').view).toEqual({ mode: 'tree', level: 2, content: 'all' });
    const saved = values.get(PANE_STATE_KEY) as { panes: Record<string, { view?: unknown }> };
    expect(saved.panes.pane1.view).toEqual({ mode: 'tree', level: 2, content: 'all' });
    await state.setPreset('pane1', 'Files');
    expect(state.get('pane1').view).toBeUndefined();
    expect(normalizePaneState({ version: 3, panes: { pane1: { preset: 'Files', view: { mode: 'x', level: 1, content: 'all' } } } }).panes.pane1.view).toBeUndefined();
  });

  it('drillDown 保存自訂組合並於 drillUp 還原', async () => {
    const { state } = await newStore();
    await state.switchRoot('pane1', '/root');
    await state.setViewAxis('pane1', { axis: 'level', value: 1 });
    await state.setViewAxis('pane1', { axis: 'mode', value: 'flat' });
    await state.setViewAxis('pane1', { axis: 'content', value: 'folders' });
    await state.drillDown('pane1', '/root/sub');
    expect(state.get('pane1').view).toBeUndefined();
    await state.drillUp('pane1');
    expect(effectiveView(state.get('pane1'))).toEqual({ mode: 'flat', level: 1, content: 'folders' });
  });
});
