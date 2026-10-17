import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeRoot,
  migrateV1ToV2,
  migrateV2ToV3,
  PaneStateStore,
  PANE_STATE_KEY,
  rootForUri,
  type MementoLike,
} from '../../src/spaces/viewState';

const P = (...parts: string[]): string => path.join(process.platform === 'win32' ? 'D:\\' : '/d', ...parts);

class MemoryMemento implements MementoLike {
  readonly values = new Map<string, unknown>();
  constructor(initial: Record<string, unknown> = {}) { Object.entries(initial).forEach(([key, value]) => this.values.set(key, value)); }
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

const sort = { key: 'mtime', direction: 'desc' };
const stack = [{ root: P('project'), preset: 'Explorer', filter: 'src', sort }];

describe('S4.1R11a multi-root pane state', () => {
  it('MR-U1 migrates v2 roots, follow default, and view state including active drill root', () => {
    const oldRoot = P('project', 'src');
    const result = migrateV2ToV3({ version: 2, panes: {
      pane2: { root: P('second'), preset: 'List', filter: 'b', sort, drillStack: [] },
      pane1: { root: oldRoot, preset: 'Files', filter: 'src', sort, drillStack: stack },
    } }, true);
    const pane = result.panes.pane1;
    expect(result.version).toBe(3);
    expect(pane.roots).toEqual([path.normalize(P('project'))]);
    expect(pane.drillRoot).toBe(path.normalize(oldRoot));
    expect(activeRoot(pane)).toBe(path.normalize(oldRoot));
    expect(pane).toMatchObject({ preset: 'Files', filter: 'src', sort, drillStack: stack, followWorkspaceDirectory: true });
    expect(result.panes.pane2.followWorkspaceDirectory).toBe(false);
  });

  it('MR-U2 migrates v1 through v2 to v3 without losing pane semantics', () => {
    const root = P('project');
    const v1 = { version: 1, bySpace: { [root]: { root, preset: 'Files', filter: 'needle', sort, drillStack: [] } },
      panes: { pane1: { root, parentPaneId: null, follow: false } } };
    const v2 = migrateV1ToV2(v1, [], true);
    const result = migrateV2ToV3(v2, false);
    expect(result.version).toBe(3);
    expect(result.panes.pane1).toMatchObject({ roots: [path.normalize(root)], drillRoot: null, preset: 'Files', filter: 'needle', sort });
    expect(activeRoot(result.panes.pane1)).toBe(path.normalize(root));
  });

  it('MR-U3 chooses the longest matching root prefix', () => {
    const roots = ['D:/a', 'D:/a/b'];
    expect(rootForUri(roots, 'D:/a/b/c.txt')).toBe('D:/a/b');
    expect(rootForUri(roots, 'D:/ab/c.txt')).toBeNull();
  });

  it('MR-U4 adds roots uniquely in order, removes without reordering, and guards empty roots', async () => {
    const a = P('a'); const b = P('b'); const c = P('c');
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 3, panes: { pane1: { roots: [a, b, c] } } } });
    const store = new PaneStateStore(memento);
    expect(await store.addPaneRoot('pane1', b)).toBe(false);
    expect(await store.addPaneRoot('pane1', P('d'))).toBe(true);
    expect(store.get('pane1').roots).toEqual([a, b, c, P('d')].map(path.normalize));
    expect(await store.removePaneRoot('pane1', b)).toBe(true);
    expect(store.get('pane1').roots).toEqual([a, c, P('d')].map(path.normalize));
    await store.setPaneRoots('pane1', []);
    expect(store.get('pane1').roots).toEqual([]);
    expect(activeRoot(store.get('pane1'))).toBeNull();
    expect(await store.removePaneRoot('pane1', a)).toBe(false);
  });

  it('addPaneRoot preserves drill navigation while changed roots restore the base view', async () => {
    const root = P('root'); const extra = P('extra'); const deep = P('root', 'deep');
    const baseView = { mode: 'tree', level: 2, content: 'folders' } as const;
    const store = new PaneStateStore(new MemoryMemento({ [PANE_STATE_KEY]: { version: 3, panes: { pane1: { roots: [root], preset: 'Files', view: baseView, filter: 'base', sort } } } }));
    await store.drillDown('pane1', P('root', 'one'));
    await store.drillDown('pane1', deep);
    expect(await store.addPaneRoot('pane1', extra)).toBe(true);
    expect(store.get('pane1').drillRoot).toBe(path.normalize(deep));
    expect(store.get('pane1').drillStack).toHaveLength(2);
    await store.setPaneRoots('pane1', [root, extra, P('third')]);
    expect(store.get('pane1')).toMatchObject({ drillRoot: null, drillStack: [], preset: 'Files', view: baseView, filter: 'base', sort });
    await store.drillDown('pane1', P('root', 'one'));
    await store.drillDown('pane1', deep);
    expect(await store.removePaneRoot('pane1', extra)).toBe(true);
    expect(store.get('pane1')).toMatchObject({ drillRoot: null, drillStack: [], preset: 'Files', view: baseView, filter: 'base', sort });
  });

  it('root changes with no drill stack clear only drillRoot, and unchanged roots do nothing', async () => {
    const root = P('root');
    const store = new PaneStateStore(new MemoryMemento({ [PANE_STATE_KEY]: { version: 3, panes: { pane1: { roots: [root], preset: 'Files', filter: 'keep', sort } } } }));
    store.get('pane1').drillRoot = P('stale');
    await store.setPaneRoots('pane1', [root, P('other')]);
    expect(store.get('pane1')).toMatchObject({ drillRoot: null, preset: 'Files', filter: 'keep', sort });
    store.get('pane1').drillRoot = P('stale');
    await store.setPaneRoots('pane1', [root, P('other')]);
    expect(store.get('pane1')).toMatchObject({ drillRoot: path.normalize(P('stale')), preset: 'Files', filter: 'keep', sort });
  });

  it('clears drillRoot when its ancestor root is removed (regression: direction of containment)', async () => {
    const outer = P('a'); const inner = P('a', 'b'); const deep = P('a', 'b', 'c');
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 3, panes: { pane1: { roots: [outer, inner] } } } });
    const store = new PaneStateStore(memento);
    await store.drillDown('pane1', deep);
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize(deep));
    // 移除 drillRoot 的祖先（outer）——drillRoot 已不在任何 root 之內，必須清空。
    expect(await store.removePaneRoot('pane1', outer)).toBe(true);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize(inner));
  });

  it('clears drillRoot when any root is removed, even if the active drill remains within another root', async () => {
    const a = P('a'); const b = P('b'); const underB = P('b', 'sub');
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 3, panes: { pane1: { roots: [a, b] } } } });
    const store = new PaneStateStore(memento);
    await store.drillDown('pane1', underB);
    // 不相關 root 移除亦會清空下鑽與返回堆疊，避免 stale navigation。
    expect(await store.removePaneRoot('pane1', a)).toBe(true);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(store.get('pane1').drillStack).toEqual([]);
    await store.drillDown('pane1', underB);
    expect(await store.removePaneRoot('pane1', b)).toBe(true);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(activeRoot(store.get('pane1'))).toBeNull();
  });

  it('restores drillRoot one level at a time, then returns to the top-level root', async () => {
    const root = P('project'); const one = P('project', 'one'); const two = P('project', 'one', 'two');
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 3, panes: { pane1: { roots: [root] } } } });
    const store = new PaneStateStore(memento);
    await store.drillDown('pane1', one);
    await store.drillDown('pane1', two);
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize(two));
    await store.drillUp('pane1');
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize(one));
    await store.drillUp('pane1');
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize(root));
  });
});
