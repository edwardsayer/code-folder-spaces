import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeRoot, PaneStateStore } from '../../src/spaces/viewState';
import { effectiveView } from '../../src/spaces/viewState';

describe('OP-12 智慧點擊分流與就地下鑽 (Smart Routing & In-place Drill-down)', () => {
  const createStore = async () => {
    const map = new Map<string, unknown>();
    const store = new PaneStateStore({
      get: (key) => map.get(key) as never,
      update: async (key, val) => { map.set(key, val); },
    });
    await store.initialize({ spaces: [], showFilesDefault: true, configuredCount: 2, followWorkspaceDirectoryDefault: false });
    return { store, map };
  };

  it('下鑽（drillDown）自動切換為子預設集 Contents，並清除自訂 view；返回（drillUp）無損還原', async () => {
    const { store } = await createStore();
    // 初始狀態為 Explorer (tree/all/all)
    await store.switchRoot('pane1', '/workspace/root');
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'tree', level: 'all', content: 'all' });

    // 觸發就地下鑽至子目錄
    await store.drillDown('pane1', '/workspace/root/subfolder');
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize('/workspace/root/subfolder'));
    // 自動套用子預設集 Contents (flat/all/all)
    expect(store.get('pane1').preset).toBe('Contents');
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'flat', level: 'all', content: 'all' });
    expect(store.get('pane1').drillStack.length).toBe(1);

    // 點擊返回 (drillUp)
    const success = await store.drillUp('pane1');
    expect(success).toBe(true);
    // 完整無損還原為下鑽前的根與 Explorer 預設集
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize('/workspace/root'));
    expect(store.get('pane1').preset).toBe('Explorer');
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'tree', level: 'all', content: 'all' });
    expect(store.get('pane1').drillStack.length).toBe(0);
  });

  it('從自訂組合（如 Navigate/level 1）下鑽時，返回同樣無損還原自訂 view', async () => {
    const { store } = await createStore();
    await store.switchRoot('pane1', '/workspace/root');
    await store.setViewAxis('pane1', { axis: 'level', value: 1 });
    await store.setViewAxis('pane1', { axis: 'content', value: 'folders' });
    // Columns (tree/1/folders)
    expect(store.get('pane1').preset).toBe('Columns');

    // 下鑽
    await store.drillDown('pane1', '/workspace/root/nested');
    expect(store.get('pane1').preset).toBe('Contents');

    // 返回
    await store.drillUp('pane1');
    expect(store.get('pane1').preset).toBe('Columns');
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'tree', level: 1, content: 'folders' });
  });
});
