import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_PANE_STATE_KEY, PaneStateStore, PANE_STATE_KEY } from '../../src/spaces/viewState';

describe('OP-15 Global/Profile 級別儲存與工作區目錄跟隨 (Profile Storage & Follow Workspace Directory)', () => {
  it('若 globalState 為空，可安全從 workspaceState 平滑轉移 v2 窗格配置', async () => {
    const wsMap = new Map<string, unknown>();
    const globalMap = new Map<string, unknown>();

    const wsMemento = {
      get: (k: string) => wsMap.get(k) as never,
      update: async (k: string, v: unknown) => { wsMap.set(k, v); }
    };
    const globalMemento = {
      get: (k: string) => globalMap.get(k) as never,
      update: async (k: string, v: unknown) => { globalMap.set(k, v); }
    };

    // 模擬舊版在 workspaceState 存了配置
    const oldV2 = {
      version: 2,
      panes: {
        pane1: { root: '/old/project', preset: 'Files', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [], showFiles: true, include: [], exclude: [] }
      }
    };
    wsMap.set(LEGACY_PANE_STATE_KEY, oldV2);

    const store = new PaneStateStore(globalMemento);
    await store.migrateFromWorkspaceStateIfEmpty(wsMemento);

    // globalState 應順利繼承該配置
    expect(store.get('pane1').roots).toEqual([path.normalize('/old/project')]);
    expect(store.get('pane1').preset).toBe('Files');
    expect(globalMap.get(PANE_STATE_KEY)).toBeDefined();
  });

  it('跟隨工作區同步 roots 時，下鑽狀態無損保留（R10 P1 修復的真正 store 層驗證）', async () => {
    const root = path.normalize('/workspace/project');
    const sub = path.normalize('/workspace/project/sub');
    const values = new Map<string, unknown>();
    values.set(PANE_STATE_KEY, {
      version: 3,
      panes: { pane1: { roots: [root], drillRoot: sub, parentPaneId: null, follow: false, followWorkspaceDirectory: true } },
    });
    const store = new PaneStateStore({ get: (k: string) => values.get(k) as never, update: async (k: string, v: unknown) => { values.set(k, v); } });

    // 工作區仍為單一資料夾且等於鏈根：同步後下鑽狀態必須完整保留（否則 S2 F-18／S4.1R8 無損返回失效）。
    await store.setPaneRoots('pane1', [root]);
    expect(store.get('pane1').drillRoot).toBe(sub);
    expect(store.get('pane1').roots).toEqual([root]);

    // 下鑽根不再落在任何 root 內（多根收回單根）：必須清空 drillRoot，避免顯示已不存在的路徑。
    const other = path.normalize('/workspace/other');
    await store.setPaneRoots('pane1', [other]);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(store.get('pane1').roots).toEqual([other]);
  });
});

