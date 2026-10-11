import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFollowingChildPaneIds } from '../../src/spaces/paneLinks';
import {
  buildDefaultLayout,
  clampPaneCount,
  classifySpaceRename,
  defaultPaneState,
  getEnabledPaneCount,
  LEGACY_PANE_STATE_KEY,
  migrateV1ToV2,
  MAX_PANE_COUNT,
  normalizePane,
  normalizePaneState,
  normalizeSpaceKey,
  PaneStateStore,
  PANE_STATE_KEY,
  resolvePaneDefinition,
  rewritePaneDocumentRoots,
  type MementoLike,
  type PaneStateDocument,
} from '../../src/spaces/viewState';
import type { SpaceDefinition } from '../../src/types';
import { isAllowedSpaceRoot, validateSpaceName } from '../../src/spaces/spaceActions';

/** Absolute, platform-appropriate fixture path (Windows tests must not rely on POSIX roots). */
const P = (...segments: string[]): string =>
  path.join(process.platform === 'win32' ? 'C:\\spaces' : '/spaces', ...segments);

class MemoryMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  constructor(initial?: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial ?? {})) this.values.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    // Mirrors workspaceState semantics: writing undefined removes the key.
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }

  read(key: string = PANE_STATE_KEY): unknown {
    return this.values.get(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

function space(basePath: string, overrides: Partial<SpaceDefinition> = {}): SpaceDefinition {
  return {
    basePath,
    name: path.basename(basePath),
    showFiles: true,
    include: [],
    exclude: [],
    sourceIndex: 0,
    ...overrides,
  };
}

function doc(value: unknown): PaneStateDocument {
  return value as PaneStateDocument;
}

describe('pane view state v2 schema (S4R6-D60/D63)', () => {
  it('stores per-pane state under the v2 key and keeps v1 as a legacy source key only', () => {
    expect(PANE_STATE_KEY).toBe('codeFolderSpaces.panes.v2');
    expect(LEGACY_PANE_STATE_KEY).toBe('codeFolderSpaces.panes.v1');
  });

  it('normalizes a v2 document and preserves unknown document and pane fields', () => {
    const normalized = normalizePaneState({
      version: 2,
      future: 'retained',
      panes: {
        pane1: { root: P('alpha', '..', 'alpha'), futurePane: 7 },
        pane2: { root: P('beta'), parentPaneId: 'pane1', follow: true, preset: 'Files' },
      },
    });
    expect(normalized.version).toBe(2);
    expect(normalized.future).toBe('retained');
    expect(normalized.panes.pane1).toMatchObject({ root: path.normalize(P('alpha')), futurePane: 7 });
    expect(normalized.panes.pane2).toMatchObject({ parentPaneId: 'pane1', follow: true, preset: 'Files' });
  });

  it('drops unknown pane ids and any foreign-version document instead of half-reading it', () => {
    const normalized = normalizePaneState({
      version: 2,
      panes: { pane1: { root: P('alpha') }, pane9: { root: P('nine') }, bogus: { root: P('b') } },
    });
    expect(Object.keys(normalized.panes)).toEqual(['pane1']);
    expect(normalizePaneState({ version: 1, bySpace: { [P('alpha')]: { preset: 'Files' } } })).toEqual({ version: 2, panes: {} });
    expect(normalizePaneState(undefined)).toEqual({ version: 2, panes: {} });
    expect(normalizePaneState([])).toEqual({ version: 2, panes: {} });
    expect(normalizePaneState({ version: 2, panes: [] })).toEqual({ version: 2, panes: {} });
  });

  it('normalizes one pane to complete v2 defaults, coercing every malformed field', () => {
    const pane = normalizePane({
      root: P('alpha', 'nested'),
      parentPaneId: 'pane9',
      follow: 'yes',
      preset: 'bogus',
      filter: 42,
      sort: { key: 'bogus', direction: 'bogus' },
      drillStack: [{ root: P('alpha'), preset: 'Files', filter: '', sort: { key: 'mtime', direction: 'desc' } }, 'junk', { root: 1 }],
      name: '   ',
      icon: 'folder',
      showFiles: 'true',
      include: ['*.ts', 5, null],
      exclude: 'not-an-array',
    });
    expect(pane).toEqual({
      root: path.normalize(P('alpha', 'nested')),
      parentPaneId: null,
      follow: false,
      preset: 'Explorer',
      filter: '',
      sort: { key: 'name', direction: 'asc' },
      drillStack: [{ root: path.normalize(P('alpha')), preset: 'Files', filter: '', sort: { key: 'mtime', direction: 'desc' } }],
      name: null,
      icon: 'folder',
      showFiles: true,
      include: ['*.ts'],
      exclude: [],
    });
  });

  it('honors the showFiles fallback for an absent flag and keeps an explicit false', () => {
    expect(normalizePane({}, false).showFiles).toBe(false);
    expect(normalizePane({ showFiles: false }, true).showFiles).toBe(false);
    expect(defaultPaneState().showFiles).toBe(true);
    expect(defaultPaneState({ root: P('alpha'), parentPaneId: 'pane1', follow: true, preset: 'List', showFiles: false, include: ['a'], exclude: ['b'] })).toEqual({
      root: P('alpha'), parentPaneId: 'pane1', follow: true, preset: 'List', filter: '', sort: { key: 'name', direction: 'asc' },
      drillStack: [], name: null, icon: null, showFiles: false, include: ['a'], exclude: ['b'],
    });
  });
});

describe('pane activation count (S4R6-D65)', () => {
  it('clamps the configured count to the eight static slots without consulting spaces', () => {
    expect(clampPaneCount(99)).toBe(MAX_PANE_COUNT);
    expect(clampPaneCount(0)).toBe(1);
    expect(clampPaneCount(-3)).toBe(1);
    expect(clampPaneCount(7.9)).toBe(7);
    expect(clampPaneCount(Number.NaN)).toBe(2);
    expect(getEnabledPaneCount(0)).toBe(1);
    expect(getEnabledPaneCount(1)).toBe(1);
    expect(getEnabledPaneCount(2)).toBe(2);
    expect(getEnabledPaneCount(9)).toBe(MAX_PANE_COUNT);
  });

  it('builds min(count, 8) panes for a workspace with no configured spaces', () => {
    const empty = buildDefaultLayout([], 4, true);
    expect(Object.keys(empty.panes)).toEqual(['pane1', 'pane2', 'pane3', 'pane4']);
    expect(empty.panes.pane1.root).toBeNull();
    expect(empty.panes.pane2).toMatchObject({ root: null, parentPaneId: 'pane1', follow: true });

    const single = buildDefaultLayout([], 1, false);
    expect(Object.keys(single.panes)).toEqual(['pane1']);
    expect(single.panes.pane1.showFiles).toBe(false);
  });

  it('seeds each default pane from the space at the same position and chains it to its predecessor', () => {
    const spaces = [space(P('alpha'), { showFiles: false, include: ['*.ts'], exclude: ['tmp'] }), space(P('beta'), { icon: 'folder' })];
    const layout = buildDefaultLayout(spaces, 3, true);
    expect(layout.panes.pane1).toMatchObject({ root: path.normalize(P('alpha')), parentPaneId: null, follow: false, showFiles: false, include: ['*.ts'], exclude: ['tmp'] });
    expect(layout.panes.pane2).toMatchObject({ root: path.normalize(P('beta')), parentPaneId: 'pane1', follow: true, showFiles: true, include: [], exclude: [] });
    expect(layout.panes.pane3).toMatchObject({ root: null, parentPaneId: 'pane2', follow: true });
  });
});

describe('v1 → v2 migration (PD-U1, S4R6-D63/D72)', () => {
  it('moves bySpace view state into the matching pane and never keeps bySpace', () => {
    const alpha = P('alpha');
    const beta = P('beta');
    const v1 = {
      version: 1,
      bySpace: {
        [normalizeSpaceKey(alpha)]: { root: alpha, preset: 'Files', filter: 'src', sort: { key: 'mtime', direction: 'desc' }, drillStack: [] },
      },
      panes: {
        pane1: { root: alpha, parentPaneId: null, follow: false },
        pane2: { root: beta, parentPaneId: 'pane1', follow: true },
      },
    };
    const migrated = migrateV1ToV2(v1, [space(alpha, { showFiles: false, exclude: ['log'] })], true);

    expect(migrated.version).toBe(2);
    expect('bySpace' in migrated).toBe(false);
    expect(migrated.panes.pane1).toMatchObject({
      root: path.normalize(alpha), preset: 'Files', filter: 'src', sort: { key: 'mtime', direction: 'desc' }, drillStack: [],
      parentPaneId: null, follow: false, showFiles: false, exclude: ['log'], include: [],
    });
    // No bySpace entry and no matching space: documented defaults are used.
    expect(migrated.panes.pane2).toMatchObject({
      root: path.normalize(beta), preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [],
      parentPaneId: 'pane1', follow: true, showFiles: true, include: [], exclude: [],
    });
  });

  it('carries a drilled v1 pane to its bySpace display root together with the stack', () => {
    const alpha = P('alpha');
    const deep = path.join(alpha, 'deep');
    const migrated = migrateV1ToV2({
      version: 1,
      bySpace: { [normalizeSpaceKey(alpha)]: { root: deep, preset: 'Contents', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [{ root: alpha, preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' } }] } },
      panes: { pane1: { root: alpha, parentPaneId: null, follow: false } },
    }, [], true);
    expect(migrated.panes.pane1).toMatchObject({ root: path.normalize(deep), preset: 'Contents', drillStack: [{ root: path.normalize(alpha) }] });
  });

  it('inherits name/icon/display from a space whose root matches, otherwise leaves them null (S4R6-D70 seeding)', () => {
    const alpha = P('alpha');
    const other = P('other');
    const migrated = migrateV1ToV2({
      version: 1,
      bySpace: { [normalizeSpaceKey(alpha)]: { root: alpha, preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [] } },
      panes: { pane1: { root: alpha, parentPaneId: null, follow: false }, pane2: { root: other, parentPaneId: 'pane1', follow: true } },
    }, [space(alpha, { name: 'Alpha Space', icon: 'star', showFiles: false, include: ['*.md'] })], true);

    expect(migrated.panes.pane1).toMatchObject({ name: null, icon: null, showFiles: false, include: ['*.md'] });
    expect(migrated.panes.pane2).toMatchObject({ name: null, icon: null, showFiles: true, include: [], exclude: [] });
  });

  it('keeps the v1 enabled pane count exactly, without auto-filling to the configured count (S4R6-D72)', () => {
    const alpha = P('alpha');
    const migrated = migrateV1ToV2({
      version: 1,
      bySpace: { [normalizeSpaceKey(alpha)]: { root: alpha, preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' }, drillStack: [] } },
      panes: { pane1: { root: alpha, parentPaneId: null, follow: false } },
    }, [space(alpha)], true);
    expect(Object.keys(migrated.panes)).toEqual(['pane1']);

    const three = migrateV1ToV2({
      version: 1,
      bySpace: {},
      panes: {
        pane1: { root: P('a'), parentPaneId: null, follow: false },
        pane2: { root: P('b'), parentPaneId: 'pane1', follow: true },
        pane3: { root: P('c'), parentPaneId: 'pane2', follow: true },
      },
    }, [], true);
    expect(Object.keys(three.panes)).toEqual(['pane1', 'pane2', 'pane3']);
  });

  it('ignores pane ids outside the eight slots and rejects an unusable v1 document', () => {
    const migrated = migrateV1ToV2({ version: 1, bySpace: {}, panes: { pane1: { root: P('a') }, pane9: { root: P('b') } } }, [], true);
    expect(Object.keys(migrated.panes)).toEqual(['pane1']);
    expect(() => migrateV1ToV2(undefined, [], true)).toThrow();
    expect(() => migrateV1ToV2({ version: 2, panes: {} }, [], true)).toThrow();
    expect(() => migrateV1ToV2({ version: 1, panes: { pane1: {} } }, [], true)).toThrow(/bySpace/);
    expect(() => migrateV1ToV2({ version: 1, bySpace: {} }, [], true)).toThrow(/layout/);
  });
});

describe('PaneStateStore lifecycle', () => {
  it('creates the default layout for a fresh workspace and persists it under v2', async () => {
    const memento = new MemoryMemento();
    const store = new PaneStateStore(memento);
    const outcome = await store.initialize({ spaces: [space(P('alpha'))], showFilesDefault: true, configuredCount: 2 });
    expect(outcome).toEqual({ kind: 'created', enabled: 2 });
    expect(doc(memento.read()).version).toBe(2);
    expect(Object.keys(doc(memento.read()).panes)).toEqual(['pane1', 'pane2']);
  });

  it('migrates a stored v1 document once and removes the legacy key', async () => {
    const alpha = P('alpha');
    const memento = new MemoryMemento({
      [LEGACY_PANE_STATE_KEY]: {
        version: 1,
        bySpace: { [normalizeSpaceKey(alpha)]: { root: alpha, preset: 'Files', filter: 'x', sort: { key: 'mtime', direction: 'desc' }, drillStack: [] } },
        panes: { pane1: { root: alpha, parentPaneId: null, follow: false }, pane2: { root: P('beta'), parentPaneId: 'pane1', follow: true } },
      },
    });
    const store = new PaneStateStore(memento);
    const outcome = await store.initialize({ spaces: [space(alpha)], showFilesDefault: true, configuredCount: 8 });
    expect(outcome).toEqual({ kind: 'migrated', enabled: 2 });
    expect(memento.has(LEGACY_PANE_STATE_KEY)).toBe(false);
    expect(store.get('pane1')).toMatchObject({ root: path.normalize(alpha), preset: 'Files', filter: 'x' });
    // D72: eight configured panes must not auto-fill the two migrated panes.
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane2']);
  });

  it('restores an existing v2 document and clears a stale legacy key', async () => {
    const memento = new MemoryMemento({
      [PANE_STATE_KEY]: { version: 2, panes: { pane1: { root: P('alpha'), preset: 'List' } } },
      [LEGACY_PANE_STATE_KEY]: { version: 1, bySpace: {} },
    });
    const store = new PaneStateStore(memento);
    await expect(store.initialize({ spaces: [], showFilesDefault: true, configuredCount: 3 })).resolves.toEqual({ kind: 'restored', enabled: 1 });
    expect(memento.has(LEGACY_PANE_STATE_KEY)).toBe(false);
    expect(store.get('pane1').preset).toBe('List');
  });

  it('rebuilds the default layout when the stored document cannot be migrated', async () => {
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 1, bySpace: {} } });
    const store = new PaneStateStore(memento);
    const outcome = await store.initialize({ spaces: [space(P('alpha'))], showFilesDefault: true, configuredCount: 2 });
    expect(outcome.kind).toBe('rebuilt');
    expect(Object.keys(doc(memento.read()).panes)).toEqual(['pane1', 'pane2']);
  });

  it('rebuilds when the stored layout has invalid pane links or no pane1 (F-10)', async () => {
    // 反向鏈（pane1 掛在 pane2 之下）→ 佈局不合法
    const reversed = new MemoryMemento({ [PANE_STATE_KEY]: { version: 2, panes: {
      pane1: { root: P('alpha'), parentPaneId: 'pane2', follow: true },
      pane2: { root: P('beta') },
    } } });
    const reversedStore = new PaneStateStore(reversed);
    const reversedOutcome = await reversedStore.initialize({ spaces: [space(P('alpha')), space(P('beta'))], showFilesDefault: true, configuredCount: 2 });
    expect(reversedOutcome.kind).toBe('rebuilt');
    expect(reversedStore.get('pane1').parentPaneId).toBeNull();

    // 循環（pane2 ↔ pane3）
    const cyclic = new MemoryMemento({ [PANE_STATE_KEY]: { version: 2, panes: {
      pane1: { root: P('alpha') },
      pane2: { root: P('beta'), parentPaneId: 'pane3', follow: true },
      pane3: { root: P('gamma'), parentPaneId: 'pane2', follow: true },
    } } });
    const cyclicStore = new PaneStateStore(cyclic);
    await expect(cyclicStore.initialize({ spaces: [space(P('alpha'))], showFilesDefault: true, configuredCount: 2 })).resolves.toMatchObject({ kind: 'rebuilt' });

    // 缺 pane1（D71 要求 pane1 恆存在）
    const noPane1 = new MemoryMemento({ [PANE_STATE_KEY]: { version: 2, panes: { pane3: { root: P('gamma') } } } });
    const noPane1Store = new PaneStateStore(noPane1);
    const noPane1Outcome = await noPane1Store.initialize({ spaces: [space(P('alpha'))], showFilesDefault: true, configuredCount: 2 });
    expect(noPane1Outcome.kind).toBe('rebuilt');
    expect(noPane1Store.getEnabledPaneIds()).toEqual(['pane1', 'pane2']);
  });

  it('resets to the default layout for pane.resetLayout', async () => {
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 2, panes: { pane1: { root: P('alpha') }, pane4: { root: P('delta'), parentPaneId: 'pane1', follow: true } } } });
    const store = new PaneStateStore(memento);
    await store.resetToDefaults({ spaces: [space(P('alpha')), space(P('beta'))], showFilesDefault: true, configuredCount: 2 });
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane2']);
    expect(store.get('pane4')).toEqual(defaultPaneState());
  });

  it('treats disabled or unknown pane ids as an empty default pane', async () => {
    const store = new PaneStateStore(new MemoryMemento({ [PANE_STATE_KEY]: { version: 2, panes: { pane1: { root: P('alpha') } } } }));
    expect(store.get('pane7')).toEqual(defaultPaneState());
    expect(store.getEnabledPaneIds()).toEqual(['pane1']);
  });
});

describe('slot allocation (PD-U2, S4R6-D62)', () => {
  function loaded(paneIds: string[]): PaneStateStore {
    return new PaneStateStore(new MemoryMemento({
      [PANE_STATE_KEY]: { version: 2, panes: Object.fromEntries(paneIds.map((id, index) => [id, { root: P(`p${index}`), parentPaneId: index ? paneIds[index - 1] : null, follow: index > 0 }])) },
    }));
  }

  it('allocates the lowest free slot, reusing a gap left by a closed pane', () => {
    expect(loaded(['pane1']).allocatePaneId()).toBe('pane2');
    expect(loaded(['pane1', 'pane2', 'pane4']).allocatePaneId()).toBe('pane3');
    expect(loaded(['pane2', 'pane4']).allocatePaneId()).toBe('pane1');
    expect(loaded(['pane1', 'pane3']).allocatePaneId()).toBe('pane2');
    expect(loaded(['pane1', 'pane2', 'pane3']).allocatePaneId(3)).toBe('pane4');
  });

  it('returns undefined when all eight slots are used', () => {
    const full = loaded(['pane1', 'pane2', 'pane3', 'pane4', 'pane5', 'pane6', 'pane7', 'pane8']);
    expect(full.allocatePaneId()).toBeUndefined();
    expect(full.allocatePaneId(8)).toBeUndefined();
  });

  it('opens a child pane in the allocated slot, inheriting the source pane display settings (S4R6-D64/D75)', async () => {
    const store = loaded(['pane1', 'pane2']);
    // 先給來源窗格可辨識的非預設值，否則斷言無區辨力（審查 F-07）。
    await store.setPreset('pane1', 'Files');
    await store.setFilter('pane1', 'keep-me');
    await store.setPaneDisplay('pane1', { showFiles: false, include: ['**/*.ts'], exclude: ['**/skip/**'] });
    const slot = store.allocatePaneId();
    expect(slot).toBe('pane3');
    const source = store.get('pane1');
    // 與 extension.ts 的 addChildPane 同形：**只**帶顯示設定（D75），preset／filter／sort 不繼承。
    await store.enablePane(slot as string, {
      root: P('alpha', 'nested'),
      parentPaneId: 'pane1',
      follow: true,
      showFiles: source.showFiles,
      include: source.include,
      exclude: source.exclude,
    });
    const child = store.get('pane3');
    expect(child).toMatchObject({ root: path.join(P('alpha'), 'nested'), parentPaneId: 'pane1', follow: true, drillStack: [] });
    // D75：只繼承顯示設定（來源值）。
    expect(child.showFiles).toBe(false);
    expect(child.include).toEqual(['**/*.ts']);
    expect(child.exclude).toEqual(['**/skip/**']);
    // D75：來源窗格的當下檢視狀態不隨新窗格帶入。
    expect(child.preset).toBe('Explorer');
    expect(child.filter).toBe('');
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane2', 'pane3']);
  });

  it('rejects an already-enabled or malformed slot id, and a link that would form a cycle', async () => {
    const store = loaded(['pane1', 'pane2']);
    await expect(store.enablePane('pane1')).rejects.toThrow(/already enabled/);
    await expect(store.enablePane('pane9')).rejects.toThrow(/Invalid pane id/);
    await expect(store.enablePane('pane3', { parentPaneId: 'pane3' })).rejects.toThrow(/acyclic/);
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane2']);
  });

  it('re-links a pane and refuses backwards parents; removing the parent clears follow', async () => {
    const store = loaded(['pane1', 'pane2', 'pane3']);
    await store.setPaneParent('pane3', 'pane1', true);
    expect(store.get('pane3')).toMatchObject({ parentPaneId: 'pane1', follow: true });
    await expect(store.setPaneParent('pane1', 'pane2', true)).rejects.toThrow(/acyclic/);
    await store.setPaneParent('pane2', null, true);
    expect(store.get('pane2')).toMatchObject({ parentPaneId: null, follow: false });
  });
});

describe('closing a pane through the store (PD-U3 persistence)', () => {
  function chainStore() {
    const memento = new MemoryMemento({
      [PANE_STATE_KEY]: { version: 2, panes: {
        pane1: { root: P('a'), parentPaneId: null, follow: false },
        pane2: { root: P('b'), parentPaneId: 'pane1', follow: true },
        pane3: { root: P('c'), parentPaneId: 'pane2', follow: true },
      } },
    });
    return { memento, store: new PaneStateStore(memento) };
  }

  it('re-attaches the closed pane children to its parent and persists v2', async () => {
    const { memento, store } = chainStore();
    await store.disablePane('pane2');
    expect(store.getEnabledPaneIds()).toEqual(['pane1', 'pane3']);
    expect(doc(memento.read()).panes.pane3).toMatchObject({ parentPaneId: 'pane1', follow: true });
    // The freed slot is the lowest free one for the next child pane.
    expect(store.allocatePaneId()).toBe('pane2');
  });

  it('promotes children to top-level when a root pane is closed, and ignores unknown ids', async () => {
    const { memento, store } = chainStore();
    await store.disablePane('pane1');
    expect(doc(memento.read()).panes.pane2).toMatchObject({ parentPaneId: null, follow: false });
    expect(store.get('pane1')).toEqual(defaultPaneState());
    await store.disablePane('pane7');
    expect(store.getEnabledPaneIds()).toEqual(['pane2', 'pane3']);
  });
});

describe('per-pane view state is keyed by paneId (S4R6-D63)', () => {
  async function twoPanes() {
    const memento = new MemoryMemento();
    const store = new PaneStateStore(memento);
    await store.initialize({ spaces: [space(P('alpha')), space(P('beta'))], showFilesDefault: true, configuredCount: 2 });
    return { memento, store };
  }

  it('switching a pane root resets only that pane drill stack', async () => {
    const { store } = await twoPanes();
    await store.setPreset('pane1', 'Files');
    await store.drillDown('pane1', path.join(P('alpha'), 'nested'));
    await store.setPreset('pane2', 'Contents');
    await store.switchRoot('pane1', P('other'));
    expect(store.get('pane1')).toMatchObject({ root: path.normalize(P('other')), preset: 'Explorer', drillStack: [] });
    expect(store.get('pane2')).toMatchObject({ root: path.normalize(P('beta')), preset: 'Contents' });
  });

  it('drills down and up per pane, restoring the previous view state', async () => {
    const { store } = await twoPanes();
    await store.setPreset('pane1', 'Files');
    await store.setFilter('pane1', 'nested');
    await store.setSort('pane1', 'mtime', 'desc');
    await store.drillDown('pane1', path.join(P('alpha'), 'nested'));
    expect(store.get('pane1')).toMatchObject({
      root: path.join(path.normalize(P('alpha')), 'nested'), preset: 'Explorer', filter: 'nested', sort: { key: 'mtime', direction: 'desc' },
      drillStack: [{ root: path.normalize(P('alpha')), preset: 'Files', filter: 'nested', sort: { key: 'mtime', direction: 'desc' } }],
    });
    // A sibling pane drilling into the same space is unaffected (F-S4R4-8 regression).
    await store.drillDown('pane2', path.join(P('beta'), 'nested'));
    expect(store.get('pane2').root).toBe(path.join(path.normalize(P('beta')), 'nested'));
    expect(store.get('pane1').root).toBe(path.join(path.normalize(P('alpha')), 'nested'));

    await store.setFilter('pane1', 'other');
    await expect(store.drillUp('pane1')).resolves.toBe(true);
    expect(store.get('pane1')).toMatchObject({ root: path.normalize(P('alpha')), preset: 'Files', filter: 'nested', sort: { key: 'mtime', direction: 'desc' }, drillStack: [] });
    await expect(store.drillUp('pane1')).resolves.toBe(false);
  });

  it('resetRoot returns a drilled pane to the bottom of its own stack', async () => {
    const { store } = await twoPanes();
    await store.drillDown('pane1', path.join(P('alpha'), 'a'));
    await store.drillDown('pane1', path.join(P('alpha'), 'b'));
    await store.resetRoot('pane1');
    expect(store.get('pane1')).toMatchObject({ root: path.normalize(P('alpha')), drillStack: [] });
  });

  it('persists preset, filter, sort, and display patches under the v2 key for every pane', async () => {
    const { memento, store } = await twoPanes();
    await store.setPreset('pane2', 'List');
    await store.setFilter('pane2', 'todo');
    await store.setSort('pane2', 'ctime', 'desc');
    await store.setPaneDisplay('pane2', { name: 'Notes', icon: 'book', showFiles: false, include: ['*.md'], exclude: ['drafts'] });
    await store.clearFilter('pane2');

    const saved = doc(memento.read());
    expect(saved.version).toBe(2);
    expect('bySpace' in saved).toBe(false);
    expect(saved.panes.pane2).toMatchObject({
      preset: 'List', filter: '', sort: { key: 'ctime', direction: 'desc' },
      name: 'Notes', icon: 'book', showFiles: false, include: ['*.md'], exclude: ['drafts'],
    });
    // Writes are pane-scoped: the sibling pane keeps its seeded state.
    expect(saved.panes.pane1).toMatchObject({ preset: 'Explorer', filter: '', name: null, icon: null, showFiles: true });
  });

  it('ignores view-state writes addressed to a disabled pane', async () => {
    const { memento, store } = await twoPanes();
    await store.setPreset('pane7', 'Files');
    await store.setPaneRoot('pane7', P('ghost'));
    await store.setPaneDisplay('pane7', { name: 'Ghost' });
    expect(Object.keys(doc(memento.read()).panes)).toEqual(['pane1', 'pane2']);
  });
});

describe('pane display fallbacks (S4R6-D69/D70)', () => {
  it('uses the matched space name and icon when the pane does not define them', () => {
    const alpha = P('alpha');
    const pane = normalizePane({ root: alpha });
    const definition = resolvePaneDefinition(pane, [space(alpha, { name: 'Alpha Space', icon: 'star' })]);
    expect(definition).toEqual({ basePath: alpha, name: 'Alpha Space', icon: 'star', showFiles: true, include: [], exclude: [], sourceIndex: 0 });
  });

  it('falls back to the root basename and no icon when the root is not a configured space', () => {
    const anyFolder = P('not-a-space', 'deep');
    const definition = resolvePaneDefinition(normalizePane({ root: anyFolder }), [space(P('alpha'))]);
    expect(definition).toMatchObject({ basePath: anyFolder, name: path.basename(anyFolder), icon: undefined, sourceIndex: -1 });
  });

  it('keeps explicit pane name/icon authoritative over the space definition', () => {
    const alpha = P('alpha');
    const definition = resolvePaneDefinition(normalizePane({ root: alpha, name: 'My Pane', icon: 'book' }), [space(alpha, { name: 'Alpha Space', icon: 'star', showFiles: false, include: ['*.ts'] })]);
    expect(definition).toMatchObject({ name: 'My Pane', icon: 'book', showFiles: true, include: [] });
  });

  it('resolves nothing for a pane without a root', () => {
    expect(resolvePaneDefinition(defaultPaneState(), [])).toBeNull();
  });
});

describe('follow with a temporary manual root (PD-U4, S4R6-D61/D74)', () => {
  async function parentChild(follow: boolean) {
    const parent = P('alpha');
    const memento = new MemoryMemento({
      [PANE_STATE_KEY]: {
        version: 2,
        panes: {
          pane1: { root: path.join(parent, 'first'), parentPaneId: null, follow: false },
          pane2: { root: path.join(parent, 'first'), parentPaneId: 'pane1', follow },
        },
      },
    });
    return { memento, store: new PaneStateStore(memento), parent };
  }

  it('keeps follow enabled while a manual root switch takes effect', async () => {
    const { store, parent } = await parentChild(true);
    const manual = path.join(parent, 'manual');
    await store.switchRoot('pane2', manual);
    expect(store.get('pane2')).toMatchObject({ root: path.normalize(manual), follow: true, parentPaneId: 'pane1' });
    // The cascade still targets this child on the next parent selection.
    expect(getFollowingChildPaneIds(store.getPaneLinks(), 'pane1')).toEqual(['pane2']);
  });

  it('lets the next parent selection overwrite the manual root without touching follow', async () => {
    const { store, parent } = await parentChild(true);
    await store.switchRoot('pane2', path.join(parent, 'manual'));
    // PaneCascadeStateAdapter.setPaneRoot is exactly this store write (S4R6-D74).
    const nextParentSelection = path.join(parent, 'next');
    await store.setPaneRoot('pane2', nextParentSelection);
    expect(store.get('pane2')).toMatchObject({ root: path.normalize(nextParentSelection), follow: true });
    expect(store.get('pane1').root).toBe(path.join(parent, 'first'));
  });

  it('leaves a paused child alone when the parent moves', async () => {
    const { store, parent } = await parentChild(false);
    const manual = path.join(parent, 'manual');
    await store.switchRoot('pane2', manual);
    expect(getFollowingChildPaneIds(store.getPaneLinks(), 'pane1')).toEqual([]);
    await store.setPaneRoot('pane2', path.join(parent, 'next'));
    expect(store.get('pane2')).toMatchObject({ root: path.normalize(path.join(parent, 'next')), follow: false });
  });

  it('exposes the follow projection that the cascade controller consumes', async () => {
    const { store, parent } = await parentChild(true);
    expect(store.getPaneLinks()).toEqual({
      pane1: { root: path.join(parent, 'first'), parentPaneId: null, follow: false },
      pane2: { root: path.join(parent, 'first'), parentPaneId: 'pane1', follow: true },
    });
    await store.setPaneParent('pane2', 'pane1', false);
    expect(store.getPaneLinks().pane2).toEqual({ root: path.join(parent, 'first'), parentPaneId: 'pane1', follow: false });
  });
});

describe('rename handling is pane-scoped (S4R6-D68 support)', () => {
  it('rewrites pane roots and drill entries under the renamed directory only', () => {
    const root = P('space');
    const document = normalizePaneState({
      version: 2,
      panes: {
        pane1: { root: path.join(root, 'old', 'nested'), parentPaneId: null, follow: false, drillStack: [{ root: path.join(root, 'old', 'x'), preset: 'Explorer', filter: '', sort: { key: 'name', direction: 'asc' } }] },
        pane2: { root: path.join(root, 'keep'), parentPaneId: 'pane1', follow: true },
        pane3: { root: P('elsewhere'), parentPaneId: 'pane1', follow: true },
      },
    });
    const rewritten = rewritePaneDocumentRoots(document, path.join(root, 'old'), path.join(root, 'new'));
    expect(rewritten.panes.pane1.root).toBe(path.join(path.join(root, 'new'), 'nested'));
    expect(rewritten.panes.pane1.drillStack[0].root).toBe(path.join(path.join(root, 'new'), 'x'));
    expect(rewritten.panes.pane2.root).toBe(path.join(root, 'keep'));
    expect(rewritten.panes.pane3.root).toBe(P('elsewhere'));
  });

  it('persists rewritten roots through the store', async () => {
    const root = P('space');
    const memento = new MemoryMemento({ [PANE_STATE_KEY]: { version: 2, panes: { pane1: { root: path.join(root, 'old') } } } });
    const store = new PaneStateStore(memento);
    await store.rewriteRoots(path.join(root, 'old'), path.join(root, 'new'));
    expect(doc(memento.read()).panes.pane1.root).toBe(path.join(root, 'new'));
  });

  it('classifies space-root, inside-space, and unrelated renames for setting staleness', () => {
    expect(classifySpaceRename([P('space')], P('space'))).toEqual({ kind: 'space-root' });
    expect(classifySpaceRename([P('space')], path.join(P('space'), 'a'))).toEqual({ kind: 'inside-space', basePath: P('space') });
    expect(classifySpaceRename([P('space')], P('other'))).toEqual({ kind: 'unrelated' });
  });
});

describe('path key normalization', () => {
  it('normalizes path keys for host platform semantics', () => {
    expect(normalizeSpaceKey(path.join(P('alpha'), '..', 'alpha'))).toBe(normalizeSpaceKey(P('alpha')));
    if (process.platform === 'win32') {
      expect(normalizeSpaceKey('C:\\Workspace\\Alpha')).toBe(normalizeSpaceKey('c:\\workspace\\alpha'));
    } else {
      expect(normalizeSpaceKey('/workspace/Alpha')).not.toBe(normalizeSpaceKey('/workspace/alpha'));
    }
  });
});

describe('space root candidates (unchanged pure helpers)', () => {
  it('validates candidate roots within the original root and rejects outside paths', () => {
    const base = P('alpha');
    const inside = path.join(base, 'nested');
    expect(isAllowedSpaceRoot(base, base)).toBe(true);
    expect(isAllowedSpaceRoot(base, inside)).toBe(true);
    expect(isAllowedSpaceRoot(base, P('alphabet'))).toBe(false);
  });

  it('allows descendants when the space root is the filesystem root', () => {
    const filesystemRoot = path.parse(path.resolve(path.sep)).root;
    expect(isAllowedSpaceRoot(filesystemRoot, path.join(filesystemRoot, 'folder'))).toBe(true);
  });

  it('accepts only changed nonblank space names', () => {
    expect(validateSpaceName('Alpha', '   ')).toBeUndefined();
    expect(validateSpaceName('Alpha', 'Alpha')).toBeUndefined();
    expect(validateSpaceName('Alpha', '  New name  ')).toBe('New name');
  });
});
