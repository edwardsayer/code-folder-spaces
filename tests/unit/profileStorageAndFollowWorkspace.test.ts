import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LEGACY_PANE_STATE_KEY, PaneStateStore, PANE_STATE_KEY } from '../../src/spaces/viewState';
import { panesToSyncWorkspaceRoots } from '../../src/spaces/paneLinks';

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
    await store.migrateFromWorkspaceStateIfEmpty(wsMemento, true);

    // globalState 應順利繼承該配置
    expect(store.get('pane1').roots).toEqual([path.normalize('/old/project')]);
    expect(store.get('pane1').preset).toBe('Files');
    expect(globalMap.get(PANE_STATE_KEY)).toBeDefined();
  });

  it('工作區 roots 真正變動時清空下鑽；完全同步早退時保留狀態', async () => {
    const root = path.normalize('/workspace/project');
    const sub = path.normalize('/workspace/project/sub');
    const values = new Map<string, unknown>();
    values.set(PANE_STATE_KEY, {
      version: 3,
      panes: { pane1: { roots: [root], drillRoot: sub, parentPaneId: null, follow: false, followWorkspaceDirectory: true } },
    });
    const store = new PaneStateStore({ get: (k: string) => values.get(k) as never, update: async (k: string, v: unknown) => { values.set(k, v); } });

    await store.drillDown('pane1', sub);
    const setPaneRoots = vi.spyOn(store, 'setPaneRoots');
    const panes = Object.fromEntries(['pane1'].map(paneId => [paneId, store.get(paneId)]));
    for (const paneId of panesToSyncWorkspaceRoots(panes, [root], (a, b) => a === b)) {
      await store.setPaneRoots(paneId, [root]);
    }
    // 呼叫端以純函式結果驅動寫入；完全同步時清單為空，確實未呼叫 setPaneRoots。
    expect(setPaneRoots).not.toHaveBeenCalled();
    expect(store.get('pane1').drillRoot).toBe(sub);
    expect(store.get('pane1').drillStack).toHaveLength(1);
    setPaneRoots.mockRestore();

    // roots 真正變動時不論下鑽是否仍位於 root 內，都必須全歸零。
    await store.drillDown('pane1', sub);
    await store.setPaneRoots('pane1', [root, path.normalize('/workspace/extra')]);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(store.get('pane1').drillStack).toEqual([]);

    const other = path.normalize('/workspace/other');
    await store.drillDown('pane1', sub);
    await store.setPaneRoots('pane1', [other]);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(store.get('pane1').drillStack).toEqual([]);
    expect(store.get('pane1').roots).toEqual([other]);
  });

  it('uses the same follow-workspace default when migrating workspace state and initializing', async () => {
    const workspace = new Map<string, unknown>([[LEGACY_PANE_STATE_KEY, { version: 2, panes: { pane1: { root: '/legacy' } } }]]);
    const global = new Map<string, unknown>();
    const store = new PaneStateStore({ get: key => global.get(key) as never, update: async (key, value) => { global.set(key, value); } });
    await store.migrateFromWorkspaceStateIfEmpty({ get: key => workspace.get(key) as never, update: async (key, value) => { workspace.set(key, value); } }, true);
    expect(store.get('pane1').followWorkspaceDirectory).toBe(true);

    const initialized = new PaneStateStore({ get: () => undefined, update: async () => {} });
    await initialized.initialize({ spaces: [], showFilesDefault: true, configuredCount: 1, followWorkspaceDirectoryDefault: true });
    expect(initialized.get('pane1').followWorkspaceDirectory).toBe(store.get('pane1').followWorkspaceDirectory);
  });
});

