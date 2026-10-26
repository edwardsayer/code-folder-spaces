import { describe, expect, it, vi } from 'vitest';
import { applyExternalPaneRoot, type ExternalPaneRootDeps } from '../../src/spaces/paneRootSwitch';

function makeDeps(overrides: Partial<ExternalPaneRootDeps> = {}): ExternalPaneRootDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  const deps: ExternalPaneRootDeps = {
    switchRoot: vi.fn(async (paneId: string, root: string) => { calls.push(`switchRoot:${paneId}:${root}`); }),
    resetExpansion: vi.fn((paneId: string) => { calls.push(`resetExpansion:${paneId}`); }),
    applyScope: vi.fn((paneId: string) => { calls.push(`applyScope:${paneId}`); }),
    rebuildWatchers: vi.fn(() => { calls.push('rebuildWatchers'); }),
    refresh: vi.fn((paneId: string) => { calls.push(`refresh:${paneId}`); }),
    syncPaneContexts: vi.fn(async () => { calls.push('syncPaneContexts'); }),
    refreshParentLinkRow: vi.fn(() => { calls.push('refreshParentLinkRow'); }),
    syncContext: vi.fn(async () => { calls.push('syncContext'); }),
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

describe('applyExternalPaneRoot', () => {
  it('一律同步全域 context（canDrillUp 只在 syncContext 更新，漏掉就會殘留 Return to Parent）', async () => {
    const deps = makeDeps();
    await applyExternalPaneRoot(deps, 'pane2', '/repo/docs');

    // 這是本回歸的核心：早期 cascade 只呼叫 syncPaneContexts，
    // 導致 pane2 root 已換但 canDrillUp context key 仍是 true，按鈕殘留。
    expect(deps.syncContext).toHaveBeenCalledTimes(1);
    expect(deps.syncPaneContexts).toHaveBeenCalledTimes(1);
    expect(deps.calls).toContain('syncContext');
  });

  it('先換 root，再同步 context（順序不可顛倒，否則同步到舊狀態）', async () => {
    const deps = makeDeps();
    await applyExternalPaneRoot(deps, 'pane2', '/repo/docs');

    const order = deps.calls;
    expect(order.indexOf('switchRoot:pane2:/repo/docs')).toBe(0);
    expect(order.indexOf('syncContext')).toBeGreaterThan(order.indexOf('switchRoot:pane2:/repo/docs'));
    expect(order.indexOf('syncPaneContexts')).toBeGreaterThan(order.indexOf('switchRoot:pane2:/repo/docs'));
  });

  it('清除展開快取、重套 scope、重建監看並重繪目標 pane', async () => {
    const deps = makeDeps();
    await applyExternalPaneRoot(deps, 'pane2', '/repo/docs');

    expect(deps.resetExpansion).toHaveBeenCalledWith('pane2');
    expect(deps.applyScope).toHaveBeenCalledWith('pane2');
    expect(deps.refresh).toHaveBeenCalledWith('pane2');
    expect(deps.rebuildWatchers).toHaveBeenCalledTimes(1);
    expect(deps.refreshParentLinkRow).toHaveBeenCalledTimes(1);
  });

  it('對 pane1 與 pane2 都適用（cascade 與 Activate Child Space 共用同一入口）', async () => {
    for (const paneId of ['pane1', 'pane2']) {
      const deps = makeDeps();
      await applyExternalPaneRoot(deps, paneId, '/repo/x');
      expect(deps.resetExpansion).toHaveBeenCalledWith(paneId);
      expect(deps.syncContext).toHaveBeenCalledTimes(1);
    }
  });

  it('switchRoot 失敗時不繼續同步 context（避免發出錯誤狀態）', async () => {
    const deps = makeDeps({
      switchRoot: vi.fn(async () => { throw new Error('boom'); }),
    });
    await expect(applyExternalPaneRoot(deps, 'pane2', '/repo/docs')).rejects.toThrow('boom');
    expect(deps.syncContext).not.toHaveBeenCalled();
    expect(deps.syncPaneContexts).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});
