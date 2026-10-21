import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceConfigEntry, SpaceOrigin } from '../../src/types';

const vscodeMock = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }> | undefined,
  workspaceFile: undefined as unknown,
  listener: undefined as ((event: { affectsConfiguration(section: string): boolean }) => void) | undefined,
  getConfiguration: vi.fn(),
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  workspace: {
    get workspaceFolders() { return vscodeMock.workspaceFolders; },
    get workspaceFile() { return vscodeMock.workspaceFile; },
    getConfiguration: vscodeMock.getConfiguration,
    onDidChangeConfiguration: (listener: typeof vscodeMock.listener) => {
      vscodeMock.listener = listener;
      return { dispose: vi.fn() };
    },
  },
}));

import { SpaceStore } from '../../src/spaces/spaceStore';

const abs = (value: string): string => path.resolve(value);

/**
 * v21-R4（使用者決策）：global roots **只**存在標準 user settings
 * （`ConfigurationTarget.Global` 的 `spaces.global`）；舊的自訂鏡像檔已退役，
 * 只保留一次性遷移（`importGlobalEntries`）。
 */
function createStore(workspace: SpaceConfigEntry[] = [], global: SpaceConfigEntry[] = [], hasWorkspace = true) {
  const data: Record<SpaceOrigin, SpaceConfigEntry[]> = { workspace: [...workspace], global: [...global] };
  const updates: Array<{ origin: SpaceOrigin; entries: SpaceConfigEntry[]; target: number }> = [];
  let failOn: SpaceOrigin | undefined;
  const store = new SpaceStore({
    get: (origin) => [...data[origin]],
    hasWorkspace: () => hasWorkspace,
    update: async (origin, entries, target) => {
      updates.push({ origin, entries: [...entries], target: target as number });
      if (origin === failOn) throw new Error('update failed');
      data[origin] = [...entries];
    },
  });
  return { store, data, updates, fail: (origin: SpaceOrigin) => { failOn = origin; } };
}

/** global 一律寫 User（Global）target：ConfigurationTarget.Global === 1。 */
const globalUpdates = (updates: Array<{ origin: SpaceOrigin; target: number }>) =>
  updates.filter((update) => update.origin === 'global');

beforeEach(() => {
  vscodeMock.workspaceFolders = [];
  vscodeMock.workspaceFile = undefined;
  vscodeMock.getConfiguration.mockReset();
});

describe('SpaceStore dual-source behavior（v21-R4：global 只存標準 user settings）', () => {
  it('interprets updateSpacePath sourceIndex only in the matching origin array', async () => {
    const { store, data } = createStore([abs('/ws')], [abs('/global')]);
    expect(await store.updateSpacePath(abs('/global'), abs('/global-new'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws')], global: [abs('/global-new')] });
  });

  it('interprets renameSpace sourceIndex only in the matching origin array', async () => {
    const { store, data } = createStore([abs('/ws')], [{ path: abs('/global'), name: 'Old' }]);
    expect(await store.renameSpace(abs('/global'), 'New')).toBe(true);
    expect(data.global).toEqual([{ path: abs('/global'), name: 'New' }]);
  });

  it('interprets removeSpace sourceIndex only in the matching origin array', async () => {
    const { store, data } = createStore([abs('/ws')], [abs('/global'), abs('/global-2')]);
    expect(await store.removeSpace(abs('/global'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws')], global: [abs('/global-2')] });
  });

  it('moves workspace definitions into user settings (Global target)', async () => {
    const { store, data, updates } = createStore([abs('/ws'), { path: abs('/move'), name: 'Move' }], [abs('/already')]);
    expect(await store.markAsGlobal(abs('/move'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws')], global: [abs('/already'), { path: abs('/move'), name: 'Move' }] });
    expect(globalUpdates(updates).every((update) => update.target === 1)).toBe(true);
  });

  it('rolls back the workspace layer when the global update fails', async () => {
    const { store, data, fail } = createStore([abs('/move')], [abs('/existing')]);
    fail('global');
    await expect(store.markAsGlobal(abs('/move'))).rejects.toThrow('update failed');
    expect(data).toEqual({ workspace: [abs('/move')], global: [abs('/existing')] });
  });

  it('moves global definitions back to the workspace', async () => {
    const { store, data } = createStore([abs('/ws')], [abs('/move')]);
    expect(await store.unmarkGlobal(abs('/move'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws'), abs('/move')], global: [] });
  });

  it('rolls back the global layer when the workspace update fails', async () => {
    const { store, data, fail } = createStore([abs('/existing')], [abs('/move')]);
    fail('workspace');
    await expect(store.unmarkGlobal(abs('/move'))).rejects.toThrow('update failed');
    expect(data).toEqual({ workspace: [abs('/existing')], global: [abs('/move')] });
  });

  it('adds to workspace when available and to user settings otherwise', async () => {
    const withWorkspace = createStore([], [], true);
    await withWorkspace.store.addSpace(abs('/ws-added'));
    expect(withWorkspace.updates[0]).toMatchObject({ origin: 'workspace', target: 2 });

    const withoutWorkspace = createStore([], [], false);
    await withoutWorkspace.store.addSpace(abs('/global-added'));
    expect(withoutWorkspace.updates[0]).toMatchObject({ origin: 'global', target: 1 });
    expect(withoutWorkspace.data.global).toEqual([abs('/global-added')]);
  });

  it('imports legacy entries once, keeping settings entries first and skipping duplicates', async () => {
    const { store, data } = createStore([], [abs('/existing')]);
    const imported = await store.importGlobalEntries([abs('/existing'), abs('/from-legacy'), { path: abs('/legacy-2'), name: 'Old' }]);
    expect(imported).toBe(2);
    expect(data.global).toEqual([abs('/existing'), abs('/from-legacy'), { path: abs('/legacy-2'), name: 'Old' }]);
  });

  it('does not touch settings when the legacy import has nothing new', async () => {
    const { store, updates } = createStore([], [abs('/existing')]);
    expect(await store.importGlobalEntries([abs('/existing')])).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('returns workspace definitions before global, with workspace winning duplicate paths', () => {
    const { store } = createStore([abs('/shared'), abs('/ws')], [abs('/shared'), abs('/global')]);
    expect(store.getDefinitions().map(({ basePath, origin }) => [basePath, origin])).toEqual([
      [abs('/shared'), 'workspace'], [abs('/ws'), 'workspace'], [abs('/global'), 'global'],
    ]);
  });
});

describe('markAsGlobal fallback（v2-R6 #7）', () => {
  it('adds an ad-hoc root to the global layer when it is not in any settings layer', async () => {
    const { store, data } = createStore([], []);
    const adhoc = abs('/adhoc/folder');
    expect(await store.markAsGlobal(adhoc)).toBe(false);
    expect(await store.addSpace(adhoc, 'adhoc', 'global')).toBe(true);
    expect(store.getDefinitions().find((definition) => definition.basePath === adhoc)?.origin).toBe('global');
    expect(store.isGlobal(adhoc)).toBe(true);
    expect(data.global).toEqual([{ path: adhoc, name: 'adhoc' }]);
  });
});
