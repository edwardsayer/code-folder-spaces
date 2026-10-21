import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LayoutStore,
  LAYOUT_KEY,
  LEGACY_PANE_STATE_KEY,
  buildDefaultLayout,
  normalizeLayout,
  type LayoutDocument,
  type MementoLike,
} from '../../src/spaces/layout';
import { VIEW_PRESETS } from '../../src/spaces/viewPresets';

const P = (...segments: string[]): string => path.join(process.platform === 'win32' ? 'C:\\spaces' : '/spaces', ...segments);

class MemoryMemento implements MementoLike {
  readonly values = new Map<string, unknown>();
  updates: string[] = [];

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updates.push(key);
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

function sample(): LayoutDocument {
  return buildDefaultLayout({ primaryRoot: P('alpha') });
}

describe('dual mode view behavior', () => {
  it('uses Navigate and Contents in dual mode, then Explorer in tree mode', async () => {
    const store = new LayoutStore(new MemoryMemento({ [LAYOUT_KEY]: sample() }));
    await store.initialize({});
    await store.setMode('dual');
    await store.setView('pane1', VIEW_PRESETS.Navigate);
    await store.setView('pane2', VIEW_PRESETS.Contents);
    expect(store.get('pane1').view).toEqual(VIEW_PRESETS.Navigate);
    expect(store.get('pane2').view).toEqual(VIEW_PRESETS.Contents);

    await store.setMode('tree');
    await store.setView('pane1', VIEW_PRESETS.Explorer);
    expect(store.get('pane1').view).toEqual(VIEW_PRESETS.Explorer);
  });

  it('adopts pane2 root into pane1 drill state and restores Explorer view', async () => {
    const store = new LayoutStore(new MemoryMemento({ [LAYOUT_KEY]: sample() }));
    await store.initialize({});
    await store.setMode('dual');
    const childRoot = P('alpha', 'child');
    await store.setPaneRoots('pane2', [childRoot]);
    await store.setMode('tree');
    await store.drillDown('pane1', childRoot);
    await store.setView('pane1', VIEW_PRESETS.Explorer);
    expect(store.getMode()).toBe('tree');
    expect(store.get('pane1').drillRoot).toBe(childRoot);
    expect(store.get('pane1').view).toEqual(VIEW_PRESETS.Explorer);
  });

  it('closes dual mode without drilling when pane2 has no root', async () => {
    const store = new LayoutStore(new MemoryMemento({ [LAYOUT_KEY]: sample() }));
    await store.initialize({});
    await store.setMode('dual');
    const previousDrillRoot = store.get('pane1').drillRoot;
    await store.setMode('tree');
    expect(store.getMode()).toBe('tree');
    expect(store.get('pane1').drillRoot).toBe(previousDrillRoot);
  });
});

describe('layout normalization', () => {
  it.each([null, undefined, {}, { version: 2, mode: 'tree', primary: {}, secondary: {} }, { version: 1, mode: 'tree', primary: {}, secondary: [], panes: [] }, { version: 1, mode: 'tree', secondary: {} }])('rejects malformed documents %#', value => {
    expect(normalizeLayout(value)).toBeNull();
  });

  it('normalizes paths and falls back for invalid view, sort, and filter values', () => {
    const result = normalizeLayout({
      version: 1,
      mode: 'dual',
      primary: { roots: [P('alpha', '..', 'alpha')], drillRoot: P('alpha', '.', 'child'), view: { mode: 'invalid' }, sort: { key: 'invalid', direction: 'invalid' }, filter: 7 },
      secondary: {},
    });
    expect(result?.primary).toMatchObject({
      roots: [path.normalize(P('alpha'))],
      drillRoot: path.normalize(P('alpha', 'child')),
      view: VIEW_PRESETS.Explorer,
      sort: { key: 'name', direction: 'asc' },
      filter: '',
    });
    expect('showFiles' in (result?.primary ?? {})).toBe(false);
    expect('preset' in (result?.primary ?? {})).toBe(false);
    expect('parentPaneId' in (result?.primary ?? {})).toBe(false);
    expect('follow' in (result?.primary ?? {})).toBe(false);
    expect('adaptiveParentBackup' in (result?.primary ?? {})).toBe(false);
  });
});

describe('LayoutStore initialization and modes', () => {
  it('creates defaults on first initialization and ignores legacy pane state', async () => {
    const memento = new MemoryMemento({ [LEGACY_PANE_STATE_KEY]: { version: 3, panes: {} } });
    const store = new LayoutStore(memento);
    expect(await store.initialize({ primaryRoot: P('alpha') })).toEqual({ kind: 'created' });
    expect(memento.get(LAYOUT_KEY)).toEqual(store.getDocument());
    expect(memento.values.has(LEGACY_PANE_STATE_KEY)).toBe(true);
    expect(memento.updates).toEqual([LAYOUT_KEY]);
  });

  it('restores legal data and rebuilds a corrupt layout', async () => {
    const valid = sample();
    const restoredMemento = new MemoryMemento({ [LAYOUT_KEY]: valid });
    expect(await new LayoutStore(restoredMemento).initialize({})).toEqual({ kind: 'restored' });
    const broken = new MemoryMemento({ [LAYOUT_KEY]: { version: 9 }, [LEGACY_PANE_STATE_KEY]: 'untouched' });
    const store = new LayoutStore(broken);
    expect(await store.initialize({ primaryRoot: P('fresh') })).toMatchObject({ kind: 'rebuilt' });
    expect(store.getPane('primary').roots).toEqual([path.normalize(P('fresh'))]);
    expect(broken.get(LEGACY_PANE_STATE_KEY)).toBe('untouched');
  });

  it('maps pane ids, mode, and secondary state', async () => {
    const store = new LayoutStore(new MemoryMemento());
    await store.initialize({ primaryRoot: P('one') });
    expect(store.getMode()).toBe('tree');
    expect(store.get('pane1')).toBe(store.getPane('primary'));
    // v2.1：pane2 預設改為 flat 第 1 層檔案清單（List）。
    expect(store.getPane('secondary').view).toEqual(VIEW_PRESETS.List);
    await store.setMode('dual');
    expect(store.getMode()).toBe('dual');
    expect(store.get('pane8')).toBe(store.getPane('secondary'));
    expect(store.getPane('secondary').roots).toEqual([path.normalize(P('one'))]);
  });

  it('persists same-mode writes without resetting state, seeds secondary only when switching to dual, and retains it in tree mode', async () => {
    const memento = new MemoryMemento();
    const store = new LayoutStore(memento);
    await store.initialize({ primaryRoot: P('one') });
    await store.setMode('tree');
    expect(memento.updates.at(-1)).toBe(LAYOUT_KEY);
    await store.setPaneRoots('pane2', [P('custom')]);
    await store.setMode('dual');
    expect(store.get('pane2').roots).toEqual([path.normalize(P('custom'))]);
    await store.setMode('tree');
    expect(store.get('pane2').roots).toEqual([path.normalize(P('custom'))]);
  });
});

describe('LayoutStore pane and drill operations', () => {
  it('switches roots, deduplicates additions, and clears drill state when roots change', async () => {
    const store = new LayoutStore(new MemoryMemento());
    await store.initialize({ primaryRoot: P('one') });
    await store.drillDown('pane1', P('one', 'child'));
    await store.switchRoot('pane1', P('two'));
    expect(store.get('pane1')).toMatchObject({ roots: [path.normalize(P('two'))], drillRoot: null, drillStack: [] });
    expect(await store.addPaneRoot('pane1', P('two', '..', 'two'))).toBe(false);
    expect(await store.addPaneRoot('pane1', P('three'))).toBe(true);
    await store.drillDown('pane1', P('two', 'child'));
    await store.setPaneRoots('pane1', [P('four')]);
    expect(store.get('pane1')).toMatchObject({ roots: [path.normalize(P('four'))], drillRoot: null, drillStack: [] });
  });

  it('restores view, filter, and sort when drilling up and returns false for an empty stack', async () => {
    const store = new LayoutStore(new MemoryMemento());
    await store.initialize({ primaryRoot: P('one') });
    await store.setView('pane1', VIEW_PRESETS.Files);
    await store.setFilter('pane1', 'before');
    await store.setSort('pane1', 'mtime', 'desc');
    await store.drillDown('pane1', P('one', 'child'), VIEW_PRESETS.Contents);
    await store.setFilter('pane1', 'inside');
    await store.setSort('pane1', 'ctime', 'asc');
    expect(await store.drillUp('pane1')).toBe(true);
    // 單層下鑽返回＝堆疊清空＝回到頂層，drillRoot 必須為 null（不可殘留下鑽根）。
    expect(store.get('pane1')).toMatchObject({ drillRoot: null, view: VIEW_PRESETS.Files, filter: 'before', sort: { key: 'mtime', direction: 'desc' } });
    expect(await store.drillUp('pane1')).toBe(false);
  });

  it('keeps the parent drill root when popping a nested drill level', async () => {
    const store = new LayoutStore(new MemoryMemento());
    await store.initialize({ primaryRoot: P('one') });
    await store.drillDown('pane1', P('one', 'child'));
    await store.drillDown('pane1', P('one', 'child', 'nested'));
    expect(store.get('pane1').drillRoot).toBe(path.normalize(P('one', 'child', 'nested')));
    expect(await store.drillUp('pane1')).toBe(true);
    // 多層：回到上一層下鑽根，而非頂層。
    expect(store.get('pane1').drillRoot).toBe(path.normalize(P('one', 'child')));
    expect(await store.drillUp('pane1')).toBe(true);
    expect(store.get('pane1').drillRoot).toBeNull();
  });

  it('rewrites roots and drill paths under a renamed directory', async () => {
    const store = new LayoutStore(new MemoryMemento());
    const oldPath = P('old');
    const nextPath = P('new');
    await store.initialize({ primaryRoot: oldPath });
    await store.addPaneRoot('pane1', path.join(oldPath, 'other'));
    await store.drillDown('pane1', path.join(oldPath, 'child'));
    await store.drillDown('pane1', path.join(oldPath, 'child', 'nested'));
    await store.rewriteRoots(oldPath, nextPath);
    expect(store.get('pane1')).toMatchObject({
      roots: [path.normalize(nextPath), path.join(path.normalize(nextPath), 'other')],
      drillRoot: path.join(path.normalize(nextPath), 'child', 'nested'),
      drillStack: [{ root: path.normalize(nextPath) }, { root: path.join(path.normalize(nextPath), 'child') }],
    });
  });

  it('resets to the initialized defaults', async () => {
    const store = new LayoutStore(new MemoryMemento());
    await store.initialize({ primaryRoot: P('default'), primaryView: VIEW_PRESETS.List });
    await store.setMode('dual');
    await store.switchRoot('pane1', P('changed'));
    await store.reset();
    expect(store.getDocument()).toEqual(buildDefaultLayout({ primaryRoot: P('default'), primaryView: VIEW_PRESETS.List }));
  });
});
