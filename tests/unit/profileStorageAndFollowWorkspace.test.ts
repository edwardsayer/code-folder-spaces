import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_PANE_STATE_KEY, PaneStateStore, PANE_STATE_KEY } from '../../src/spaces/viewState';

describe('layout storage and workspace roots', () => {
  it('stores layout.v1 in the supplied workspace memento and ignores legacy pane state', async () => {
    const legacy = { version: 3, panes: { pane1: { roots: ['/legacy'] } } };
    const values = new Map<string, unknown>([[LEGACY_PANE_STATE_KEY, legacy]]);
    const store = new PaneStateStore({ get: key => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await store.initialize({ primaryRoot: '/workspace' });
    expect(store.get('pane1').roots).toEqual([path.normalize('/workspace')]);
    expect(values.get(PANE_STATE_KEY)).toBeDefined();
    expect(values.get(LEGACY_PANE_STATE_KEY)).toBe(legacy);
  });

  it('resets drill navigation when workspace roots change', async () => {
    const values = new Map<string, unknown>();
    const store = new PaneStateStore({ get: key => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await store.initialize({ primaryRoot: '/workspace/project' });
    await store.drillDown('pane1', '/workspace/project/sub');
    await store.setPaneRoots('pane1', ['/workspace/other']);
    expect(store.get('pane1').drillRoot).toBeNull();
    expect(store.get('pane1').drillStack).toEqual([]);
    expect(store.get('pane1').roots).toEqual([path.normalize('/workspace/other')]);
  });

  it('uses the workspace memento when a workspace is present and global memento otherwise', async () => {
    const workspace = new Map<string, unknown>();
    const global = new Map<string, unknown>();
    const make = (map: Map<string, unknown>) => ({ get: (key: string) => map.get(key) as never, update: async (key: string, value: unknown) => { map.set(key, value); } });
    await new PaneStateStore(make(workspace)).initialize({ primaryRoot: '/project' });
    await new PaneStateStore(make(global)).initialize({});
    expect(workspace.has(PANE_STATE_KEY)).toBe(true);
    expect(global.has(PANE_STATE_KEY)).toBe(true);
  });
});
