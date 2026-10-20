import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeRoot, classifySpaceRename, effectiveView, normalizeSpaceKey, PaneStateStore, PANE_STATE_KEY, resolvePaneDefinitions, rootForUri, toggleViewMode } from '../../src/spaces/viewState';
import type { MementoLike } from '../../src/spaces/viewState';

class MemoryMemento implements MementoLike {
  values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

const normalize = path.normalize;

describe('viewState compatibility layer', () => {
  it('normalizes path keys and finds the most specific root', () => {
    expect(normalizeSpaceKey('/a/../b')).toBe(normalize('/b'));
    expect(rootForUri(['/a', '/a/b'], '/a/b/file.txt')).toBe('/a/b');
    expect(rootForUri(['/a'], '/other/file.txt')).toBeNull();
  });

  it('toggles a pane view between tree and flat without changing its other axes', () => {
    const tree = { mode: 'tree' as const, level: 'all' as const, content: 'all' as const };
    const flat = toggleViewMode(tree);
    expect(flat).toEqual({ ...tree, mode: 'flat' });
    expect(toggleViewMode(flat)).toEqual(tree);
  });

  it('classifies configured root renames', () => {
    expect(classifySpaceRename(['/a'], '/a')).toEqual({ kind: 'space-root' });
    expect(classifySpaceRename(['/a'], '/a/child')).toEqual({ kind: 'inside-space', basePath: '/a' });
    expect(classifySpaceRename(['/a'], '/b')).toEqual({ kind: 'unrelated' });
  });

  it('resolves roots and exposes pane state through LayoutStore', async () => {
    const memento = new MemoryMemento();
    const store = new PaneStateStore(memento);
    await store.initialize({ primaryRoot: '/workspace' });
    expect(store.getEnabledPaneIds()).toEqual(['pane1']);
    expect(activeRoot(store.get('pane1'))).toBe(normalize('/workspace'));
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'tree', level: 'all', content: 'all' });
    expect(resolvePaneDefinitions(store.get('pane1'), []).map(item => item.basePath)).toEqual([normalize('/workspace')]);
    await store.setMode('dual');
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane2']);
    await store.switchRoot('pane2', '/secondary');
    expect(store.getMode()).toBe('dual');
    expect(store.get('pane2').roots).toEqual([normalize('/secondary')]);
    await store.addPaneRoot('pane1', '/extra');
    expect(store.get('pane1').roots).toEqual([normalize('/workspace'), normalize('/extra')]);
    await store.removePaneRoot('pane1', '/extra');
    await store.setFilter('pane1', 'needle');
    await store.setSort('pane1', 'mtime', 'desc');
    expect(store.get('pane1')).toMatchObject({ filter: 'needle', sort: { key: 'mtime', direction: 'desc' } });
    await store.drillDown('pane1', '/workspace/child');
    expect(activeRoot(store.get('pane1'))).toBe(normalize('/workspace/child'));
    expect(await store.drillUp('pane1')).toBe(true);
    expect(activeRoot(store.get('pane1'))).toBe(normalize('/workspace'));
    expect(memento.get(PANE_STATE_KEY)).toBeDefined();
  });
});
