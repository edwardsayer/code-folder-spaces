import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeRoot, effectiveView, PaneStateStore } from '../../src/spaces/viewState';

describe('smart routing and in-place drill-down', () => {
  const createStore = async () => {
    const map = new Map<string, unknown>();
    const store = new PaneStateStore({ get: key => map.get(key) as never, update: async (key, value) => { map.set(key, value); } });
    await store.initialize({});
    return store;
  };

  it('drills into a child view and restores the prior view and root', async () => {
    const store = await createStore();
    await store.switchRoot('pane1', '/workspace/root');
    await store.drillDown('pane1', '/workspace/root/subfolder', { mode: 'flat', level: 'all', content: 'all' });
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize('/workspace/root/subfolder'));
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'flat', level: 'all', content: 'all' });
    expect(await store.drillUp('pane1')).toBe(true);
    expect(activeRoot(store.get('pane1'))).toBe(path.normalize('/workspace/root'));
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'tree', level: 'all', content: 'all' });
  });

  it('restores a custom view after drill-up', async () => {
    const store = await createStore();
    await store.switchRoot('pane1', '/workspace/root');
    await store.setView('pane1', { mode: 'tree', level: 1, content: 'folders' });
    await store.drillDown('pane1', '/workspace/root/nested', { mode: 'flat', level: 'all', content: 'all' });
    await store.drillUp('pane1');
    expect(effectiveView(store.get('pane1'))).toEqual({ mode: 'tree', level: 1, content: 'folders' });
  });
});
