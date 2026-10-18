import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaneStateStore, type MementoLike } from '../../src/spaces/viewState';

const WIN = process.platform === 'win32';
const P = (...parts: string[]): string => path.join(WIN ? 'D:/' : '/d', ...parts);

class MemoryMemento implements MementoLike {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key); else this.values.set(key, value);
  }
}

function activeRootOf(store: PaneStateStore, paneId: string): string | null {
  const pane = store.get(paneId);
  return pane.drillRoot ?? pane.roots[0] ?? null;
}

/**
 * S4.1R15（OP-22）：一父多子。
 * 樹列的 Activate Child Space＝重用／改換既有子根；「…」→ Add Child Space＝總是新增。
 * 這裡驗證 store 層允許同一個父掛多個子，且各自的檢視狀態互不干擾。
 */
describe('S4.1R15 multi-child under one parent', () => {
  it('keeps several children under the same parent', async () => {
    const store = new PaneStateStore(new MemoryMemento());
    await store.enablePane('pane1', { roots: [P('docs')] });
    await store.enablePane('pane2', { roots: [P('docs')], parentPaneId: 'pane1', follow: true, preset: 'Items' });
    await store.enablePane('pane3', { roots: [P('images')], parentPaneId: 'pane1', follow: true, preset: 'Contents' });

    const children = store.getEnabledPaneIds().filter(id => store.get(id).parentPaneId === 'pane1');
    expect(children).toEqual(['pane2', 'pane3']);
    // 各自的檢視模式與根互不干擾
    expect(store.get('pane2')).toMatchObject({ preset: 'Items', roots: [P('docs')] });
    expect(store.get('pane3')).toMatchObject({ preset: 'Contents', roots: [P('images')] });
  });

  it('lets each child carry its own filter and root independently', async () => {
    const store = new PaneStateStore(new MemoryMemento());
    await store.enablePane('pane1', { roots: [P('shared')] });
    await store.enablePane('pane2', { roots: [P('shared')], parentPaneId: 'pane1', follow: true });
    await store.enablePane('pane3', { roots: [P('shared')], parentPaneId: 'pane1', follow: true });

    await store.setFilter('pane2', '*.md');
    await store.setFilter('pane3', '*.png');
    expect(store.get('pane2').filter).toBe('*.md');
    expect(store.get('pane3').filter).toBe('*.png');

    // 兩個子各自換根（模擬 cascade 對每個 follow 子寫入 switchRoot）
    await store.switchRoot('pane2', P('shared', 'docs'));
    await store.switchRoot('pane3', P('shared', 'images'));
    expect(activeRootOf(store, 'pane2')).toBe(P('shared', 'docs'));
    expect(activeRootOf(store, 'pane3')).toBe(P('shared', 'images'));
    // filter 不因換根被清掉
    expect(store.get('pane2').filter).toBe('*.md');
    expect(store.get('pane3').filter).toBe('*.png');
  });

  it('still rejects a cycle when linking a pane under its own descendant', async () => {
    const store = new PaneStateStore(new MemoryMemento());
    await store.enablePane('pane1', { roots: [P('a')] });
    await store.enablePane('pane2', { roots: [P('a')], parentPaneId: 'pane1', follow: true });
    await store.enablePane('pane3', { roots: [P('a')], parentPaneId: 'pane2', follow: true });
    // pane1 已在 pane2 的祖先鏈上，把 pane1 掛到 pane3 會成環
    await expect(store.setPaneParent('pane1', 'pane3', true)).rejects.toThrow(/acyclic/);
  });

  it('re-attaches all children of a closed middle pane to its parent', async () => {
    const store = new PaneStateStore(new MemoryMemento());
    await store.enablePane('pane1', { roots: [P('a')] });
    await store.enablePane('pane2', { roots: [P('a')], parentPaneId: 'pane1', follow: true });
    await store.enablePane('pane3', { roots: [P('a')], parentPaneId: 'pane2', follow: true });
    await store.enablePane('pane4', { roots: [P('a')], parentPaneId: 'pane2', follow: true });

    await store.disablePane('pane2');
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane3', 'pane4']);
    // 兩個子都重掛到 pane1（仍是一父多子）
    expect(store.get('pane3').parentPaneId).toBe('pane1');
    expect(store.get('pane4').parentPaneId).toBe('pane1');
  });
});
