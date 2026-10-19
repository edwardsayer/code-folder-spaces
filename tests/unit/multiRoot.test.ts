import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeRoot, PaneStateStore, PANE_STATE_KEY, rootForUri, type MementoLike } from '../../src/spaces/viewState';

class MemoryMemento implements MementoLike {
  values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

describe('multi-root pane state', () => {
  it('selects the longest containing root', () => {
    expect(rootForUri(['/a', '/a/b'], '/a/b/c.txt')).toBe('/a/b');
    expect(rootForUri(['/a'], '/ab/c.txt')).toBeNull();
  });

  it('adds, removes, and replaces pane roots while retaining active-root semantics', async () => {
    const memento = new MemoryMemento();
    const store = new PaneStateStore(memento);
    await store.initialize({ primaryRoot: '/root' });
    expect(await store.addPaneRoot('pane1', '/extra')).toBe(true);
    expect(await store.addPaneRoot('pane1', '/extra')).toBe(false);
    expect(store.get('pane1').roots).toEqual(['/root', '/extra'].map(path.normalize));
    await store.drillDown('pane1', '/root/sub');
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize('/root/sub'));
    await store.setPaneRoots('pane1', ['/new']);
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize('/new'));
    expect(await store.removePaneRoot('pane1', '/new')).toBe(true);
    expect(memento.get(PANE_STATE_KEY)).toBeDefined();
  });
});
