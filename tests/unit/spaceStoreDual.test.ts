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

beforeEach(() => {
  vscodeMock.workspaceFolders = [];
  vscodeMock.workspaceFile = undefined;
  vscodeMock.getConfiguration.mockReset();
});

describe('SpaceStore dual-source behavior', () => {
  it('interprets updateSpacePath sourceIndex only in the matching origin array', async () => {
    const { store, data } = createStore([abs('/ws')], [abs('/global')]);
    expect(await store.updateSpacePath(abs('/global'), abs('/global-new'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws')], global: [abs('/global-new')] });
  });

  it('interprets renameSpace sourceIndex only in the matching origin array', async () => {
    const { store, data } = createStore([abs('/ws')], [{ path: abs('/global'), name: 'Old' }]);
    expect(await store.renameSpace(abs('/global'), 'New')).toBe(true);
    expect(data.workspace).toEqual([abs('/ws')]);
    expect(data.global).toEqual([{ path: abs('/global'), name: 'New' }]);
  });

  it('interprets removeSpace sourceIndex only in the matching origin array', async () => {
    const { store, data } = createStore([abs('/ws')], [abs('/global'), abs('/global-2')]);
    expect(await store.removeSpace(abs('/global'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws')], global: [abs('/global-2')] });
  });

  it('moves workspace definitions to global with both layers updated', async () => {
    const { store, data } = createStore([abs('/ws'), { path: abs('/move'), name: 'Move' }], [abs('/already')]);
    expect(await store.markAsGlobal(abs('/move'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws')], global: [abs('/already'), { path: abs('/move'), name: 'Move' }] });
  });

  it('rolls back the first layer if the second markAsGlobal update fails', async () => {
    const { store, data, fail } = createStore([abs('/move')], [abs('/existing')]);
    fail('global');
    await expect(store.markAsGlobal(abs('/move'))).rejects.toThrow('update failed');
    expect(data).toEqual({ workspace: [abs('/move')], global: [abs('/existing')] });
  });

  it('moves global definitions back to workspace', async () => {
    const { store, data } = createStore([abs('/ws')], [abs('/move')]);
    expect(await store.unmarkGlobal(abs('/move'))).toBe(true);
    expect(data).toEqual({ workspace: [abs('/ws'), abs('/move')], global: [] });
  });

  it('rolls back the first layer if the second unmarkGlobal update fails', async () => {
    const { store, data, fail } = createStore([abs('/existing')], [abs('/move')]);
    fail('workspace');
    await expect(store.unmarkGlobal(abs('/move'))).rejects.toThrow('update failed');
    expect(data).toEqual({ workspace: [abs('/existing')], global: [abs('/move')] });
  });

  it('adds to workspace when available and global otherwise', async () => {
    const withWorkspace = createStore([], [], true);
    await withWorkspace.store.addSpace(abs('/ws-added')); 
    expect(withWorkspace.updates[0]).toMatchObject({ origin: 'workspace', target: 2 });
    const withoutWorkspace = createStore([], [], false);
    await withoutWorkspace.store.addSpace(abs('/global-added')); 
    expect(withoutWorkspace.updates[0]).toMatchObject({ origin: 'global', target: 1 });
  });

  it('ignores the legacy spaces key without reading or writing it', () => {
    const configuration = { 'spaces.workspace': [], 'spaces.global': [], spaces: [{ path: '/legacy' }] };
    const get = vi.fn((key: string, fallback: unknown) => key in configuration ? configuration[key as keyof typeof configuration] : fallback);
    vscodeMock.getConfiguration.mockReturnValue({ get, update: vi.fn() });
    const store = new SpaceStore();
    expect(store.getDefinitions()).toEqual([]);
    expect(get.mock.calls.map(([key]) => key)).toEqual(['spaces.workspace', 'spaces.global']);
    expect(get.mock.calls.some(([key]) => key === 'spaces')).toBe(false);
    expect(vscodeMock.getConfiguration.mock.results[0].value.update).not.toHaveBeenCalled();
  });

  it('returns workspace definitions before global, with workspace winning duplicate paths', () => {
    const { store } = createStore([abs('/shared'), abs('/ws')], [abs('/shared'), abs('/global')]);
    expect(store.getDefinitions().map(({ basePath, origin }) => [basePath, origin])).toEqual([
      [abs('/shared'), 'workspace'], [abs('/ws'), 'workspace'], [abs('/global'), 'global'],
    ]);
  });
});
