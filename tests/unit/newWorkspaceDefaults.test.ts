import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefaultLayout, LayoutStore } from '../../src/spaces/layout';
import { activeRoot } from '../../src/spaces/viewState';

describe('new workspace layout defaults', () => {
  it('builds a primary root and empty secondary in tree mode', () => {
    const layout = buildDefaultLayout({ primaryRoot: '/project' });
    expect(layout.mode).toBe('tree');
    expect(layout.primary.roots).toEqual([path.normalize('/project')]);
    expect(layout.secondary.roots).toEqual([]);
  });

  it('enables dual mode with primary root copied to secondary only when empty', async () => {
    const values = new Map<string, unknown>();
    const store = new LayoutStore({ get: key => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await store.initialize({ primaryRoot: '/project' });
    await store.setMode('dual');
    expect(activeRoot(store.get('pane2'))).toBe(path.normalize('/project'));
    await store.switchRoot('pane2', '/custom');
    await store.setMode('tree');
    await store.setMode('dual');
    expect(activeRoot(store.get('pane2'))).toBe(path.normalize('/custom'));
  });
});
