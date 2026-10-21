import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceConfigEntry, SpaceOrigin } from '../../src/types';
import type { UserGlobalRootsIO } from '../../src/spaces/userGlobalRoots';

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
 * v2.1：global 來源改為「使用者層級檔案」（跨 profile／跨專案），舊 `spaces.global` 設定仍會被合併。
 * 測試以 `file` 代表該檔案內容、`data.global` 代表舊設定。
 */
function createStore(workspace: SpaceConfigEntry[] = [], file: SpaceConfigEntry[] = [], hasWorkspace = true, legacyGlobal: SpaceConfigEntry[] = []) {
  const data: Record<SpaceOrigin, SpaceConfigEntry[]> = { workspace: [...workspace], global: [...legacyGlobal] };
  const updates: Array<{ origin: SpaceOrigin; entries: SpaceConfigEntry[]; target: number }> = [];
  let failOn: SpaceOrigin | undefined;
  let failFileWrite = false;
  const fileStore = {
    filePath: '/tmp/global-roots.json',
    read: () => [...file],
    write: (entries: readonly SpaceConfigEntry[]) => {
      if (failFileWrite) throw new Error('file write failed');
      file.length = 0;
      file.push(...entries);
    },
  } satisfies UserGlobalRootsIO;
  const store = new SpaceStore({
    get: (origin) => [...data[origin]],
    hasWorkspace: () => hasWorkspace,
    update: async (origin, entries, target) => {
      updates.push({ origin, entries: [...entries], target: target as number });
      if (origin === failOn) throw new Error('update failed');
      data[origin] = [...entries];
    },
  }, fileStore);
  return {
    store, data, file, updates,
    fail: (origin: SpaceOrigin) => { failOn = origin; },
    failFile: () => { failFileWrite = true; },
  };
}

beforeEach(() => {
  vscodeMock.workspaceFolders = [];
  vscodeMock.workspaceFile = undefined;
  vscodeMock.getConfiguration.mockReset();
});

describe('SpaceStore dual-source behavior（v2.1：global 存使用者層級檔案）', () => {
  it('interprets updateSpacePath sourceIndex only in the matching origin array', async () => {
    const { store, file } = createStore([abs('/ws')], [abs('/global')]);
    expect(await store.updateSpacePath(abs('/global'), abs('/global-new'))).toBe(true);
    expect(file).toEqual([abs('/global-new')]);
  });

  it('interprets renameSpace sourceIndex only in the matching origin array', async () => {
    const { store, file } = createStore([abs('/ws')], [{ path: abs('/global'), name: 'Old' }]);
    expect(await store.renameSpace(abs('/global'), 'New')).toBe(true);
    expect(file).toEqual([{ path: abs('/global'), name: 'New' }]);
  });

  it('interprets removeSpace sourceIndex only in the matching origin array', async () => {
    const { store, file } = createStore([abs('/ws')], [abs('/global'), abs('/global-2')]);
    expect(await store.removeSpace(abs('/global'))).toBe(true);
    expect(file).toEqual([abs('/global-2')]);
  });

  it('moves workspace definitions to the user-level file', async () => {
    const { store, data, file } = createStore([abs('/ws'), { path: abs('/move'), name: 'Move' }], [abs('/already')]);
    expect(await store.markAsGlobal(abs('/move'))).toBe(true);
    expect(data.workspace).toEqual([abs('/ws')]);
    expect(file).toEqual([abs('/already'), { path: abs('/move'), name: 'Move' }]);
  });

  it('rolls back the workspace layer when the file write fails', async () => {
    const { store, data, file, failFile } = createStore([abs('/move')], [abs('/existing')]);
    failFile();
    await expect(store.markAsGlobal(abs('/move'))).rejects.toThrow('file write failed');
    expect(data.workspace).toEqual([abs('/move')]);
    expect(file).toEqual([abs('/existing')]);
  });

  it('moves global definitions from the file back to the workspace', async () => {
    const { store, data, file } = createStore([abs('/ws')], [abs('/move')]);
    expect(await store.unmarkGlobal(abs('/move'))).toBe(true);
    expect(data.workspace).toEqual([abs('/ws'), abs('/move')]);
    expect(file).toEqual([]);
  });

  it('rolls back the file when the workspace update fails', async () => {
    const { store, data, file, fail } = createStore([abs('/existing')], [abs('/move')]);
    fail('workspace');
    await expect(store.unmarkGlobal(abs('/move'))).rejects.toThrow('update failed');
    expect(data.workspace).toEqual([abs('/existing')]);
    expect(file).toEqual([abs('/move')]);
  });

  it('adds to workspace when available and to the file otherwise', async () => {
    const withWorkspace = createStore([], [], true);
    await withWorkspace.store.addSpace(abs('/ws-added'));
    expect(withWorkspace.updates[0]).toMatchObject({ origin: 'workspace', target: 2 });

    const withoutWorkspace = createStore([], [], false);
    await withoutWorkspace.store.addSpace(abs('/global-added'));
    expect(withoutWorkspace.file).toEqual([abs('/global-added')]);
  });

  it('merges the legacy spaces.global setting with the file and clears it on write', async () => {
    const { store, data, file } = createStore([abs('/ws')], [abs('/from-file')], true, [abs('/legacy-global')]);
    expect(store.getDefinitions().map(({ basePath }) => basePath)).toEqual([abs('/ws'), abs('/legacy-global'), abs('/from-file')]);
    await store.markAsGlobal(abs('/ws'));
    expect(file.sort()).toEqual([abs('/from-file'), abs('/legacy-global'), abs('/ws')].sort());
    expect(data.global).toEqual([]);
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
    const { store, file } = createStore([], []);
    const adhoc = abs('/adhoc/folder');
    expect(await store.markAsGlobal(adhoc)).toBe(false);
    expect(await store.addSpace(adhoc, 'adhoc', 'global')).toBe(true);
    expect(store.getDefinitions().find(d => d.basePath === adhoc)?.origin).toBe('global');
    expect(store.isGlobal(adhoc)).toBe(true);
    expect(file).toEqual([{ path: adhoc, name: 'adhoc' }]);
  });
});
