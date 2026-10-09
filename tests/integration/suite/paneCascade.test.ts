import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PaneCascadeController } from '../../../src/spaces/paneCascade';
import type { PaneCascadeRuntime, PaneCascadeSelection } from '../../../src/spaces/paneCascade';
import { isAllowedSpaceRoot } from '../../../src/spaces/spaceActions';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceEntryNode, SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import { PaneStateStore } from '../../../src/spaces/viewState';
import type { PaneLinkState } from '../../../src/spaces/viewState';
import { assertFixtureWorkspace, fixtureWorkspace, withGlobalSettings } from './helpers';

suite('pane cascade controller integration', () => {
  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');
  const nested = path.join(alpha, 'nested');
  const deeper = path.join(nested, 'deeper');
  const samePath = (left: string, right: string): boolean => {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === 'win32'
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  };

  suiteSetup(() => assertFixtureWorkspace());

  async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for pane cascade.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async function withCascade<T>(run: (args: {
    state: PaneStateStore;
    controller: PaneCascadeController;
    runtimes: Map<string, PaneCascadeRuntime>;
    emit: (paneId: string, selection: PaneCascadeSelection | undefined) => void;
    providers: SpaceTreeDataProvider[];
  }) => Promise<T>): Promise<T> {
    return withGlobalSettings({ spaces: [alpha] }, async () => {
      const mementoValues = new Map<string, unknown>();
      const memento = {
        get: <T>(key: string): T | undefined => mementoValues.get(key) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => { mementoValues.set(key, value); },
      };
      const state = new PaneStateStore(memento);
      const links: Record<string, PaneLinkState> = {
        pane1: { root: alpha, parentPaneId: null, follow: false },
        pane2: { root: alpha, parentPaneId: 'pane1', follow: true },
        pane3: { root: alpha, parentPaneId: 'pane2', follow: true },
      };
      await state.setPaneLinks(links);
      const store = new SpaceStore();
      const providers: SpaceTreeDataProvider[] = [];
      const runtimes = new Map<string, PaneCascadeRuntime>();
      const emitters = new Map<string, vscode.EventEmitter<PaneCascadeSelection | undefined>>();
      for (const id of Object.keys(links)) {
        const scope = { basePath: alpha, root: alpha };
        const provider = new SpaceTreeDataProvider(store, state, scope);
        providers.push(provider);
        runtimes.set(id, {
          id, scope, provider,
          treeView: { message: '' },
        });
        emitters.set(id, new vscode.EventEmitter<PaneCascadeSelection | undefined>());
      }
      const controller = new PaneCascadeController({
        state,
        getRuntime: id => runtimes.get(id),
        isAllowedRoot: isAllowedSpaceRoot,
        stat: async uri => await vscode.workspace.fs.stat(uri),
        directoryType: vscode.FileType.Directory,
      });
      for (const id of emitters.keys()) {
        controller.attach(id, listener => emitters.get(id)!.event(listener));
      }
      try {
        return await run({
          state, controller, runtimes, providers,
          emit: (paneId, selection) => emitters.get(paneId)!.fire(selection),
        });
      } finally {
        controller.dispose();
        for (const emitter of emitters.values()) emitter.dispose();
        for (const provider of providers) provider.dispose();
        store.dispose();
      }
    });
  }

  async function directoryNode(provider: SpaceTreeDataProvider, wantedPath: string): Promise<SpaceEntryNode> {
    const root = (await provider.getChildren())[0];
    const children = await provider.getChildren(root);
    const node = children.find(child => child instanceof SpaceEntryNode && samePath(child.uri.fsPath, wantedPath));
    assert.ok(node instanceof SpaceEntryNode && node.isDirectory, `Expected directory node ${wantedPath}`);
    return node;
  }

  test('pane1→2→3 selection persists roots; file, follow-off and drill root changes do not cascade', async () => withCascade(async ({ state, runtimes, providers, emit }) => {
    const selectedNested = await directoryNode(providers[0], nested);
    emit('pane1', selectedNested);
    await waitFor(() => runtimes.get('pane2')!.scope!.root === nested);
    assert.equal((await state.getPaneLinks())?.pane2.root, nested);
    assert.equal((await providers[1].getChildren())[0].label, path.basename(nested));

    const selectedDeeper = await directoryNode(providers[1], deeper);
    emit('pane2', selectedDeeper);
    await waitFor(() => runtimes.get('pane3')!.scope!.root === deeper);
    assert.equal((await state.getPaneLinks())?.pane3.root, deeper);

    const file = (await providers[0].getChildren((await providers[0].getChildren())[0]))
      .find(child => child instanceof SpaceEntryNode && !child.isDirectory) as SpaceEntryNode;
    const beforeFile = runtimes.get('pane2')!.scope!.root;
    emit('pane1', file);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(runtimes.get('pane2')!.scope!.root, beforeFile);

    const links = { ...(state.getPaneLinks() ?? {}) };
    links.pane2 = { ...links.pane2, follow: false };
    await state.setPaneLinks(links);
    const alphaRoot = (await providers[0].getChildren())[0];
    emit('pane1', { uri: vscode.Uri.file(alphaRoot.uri.fsPath), isDirectory: true });
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(runtimes.get('pane2')!.scope!.root, beforeFile);

    const drillStackBefore = state.get(alpha).drillStack?.length ?? 0;
    const pane3RootBeforeDrill = (state.getPaneLinks() ?? {}).pane3.root;
    await state.drillDown(alpha, nested);
    assert.equal(state.get(alpha).drillStack?.length, drillStackBefore + 1);
    assert.equal((state.getPaneLinks() ?? {}).pane3.root, pane3RootBeforeDrill);
    assert.equal(runtimes.get('pane3')!.scope!.root, deeper);
    // 此處只驗證 drillDown 未發出 selection event；不代表已驗 UI 父 pane root 渲染。

    // scope guard：follow 明確開啟，之後模擬 child 已切至不同空間。
    const currentLinks = { ...(state.getPaneLinks() ?? {}) };
    currentLinks.pane2 = { ...currentLinks.pane2, follow: true };
    await state.setPaneLinks(currentLinks);
    const childRootBeforeGuard = runtimes.get('pane2')!.scope!.root;
    const linkRootBeforeGuard = (state.getPaneLinks() ?? {}).pane2.root;
    runtimes.get('pane2')!.scope!.basePath = deeper;
    emit('pane1', selectedNested);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(runtimes.get('pane2')!.scope!.root, childRootBeforeGuard);
    assert.equal((state.getPaneLinks() ?? {}).pane2.root, linkRootBeforeGuard);
  }));

  test('expectedRoot suppresses only the matching root event; a different folder still follows', async () => withCascade(async ({ runtimes, providers, emit }) => {
    const selectedNested = await directoryNode(providers[0], nested);
    emit('pane1', selectedNested);
    await waitFor(() => runtimes.get('pane2')!.scope!.root === nested);
    // Re-delivering the child root event is the TreeView echo caused by refresh.
    emit('pane2', { uri: vscode.Uri.file(nested), isDirectory: true });
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(runtimes.get('pane3')!.scope!.root, alpha);

    emit('pane2', { uri: vscode.Uri.file(deeper), isDirectory: true });
    await waitFor(() => runtimes.get('pane3')!.scope!.root === deeper);
  }));

  test('state persistence in flight is serialized so the queued newer selection wins', async () => withCascade(async ({ state, runtimes, providers }) => {
    let releaseFirstWrite!: () => void;
    let startedFirstWrite!: () => void;
    let startSecondStat!: () => void;
    let finishSecondStat!: () => void;
    let secondCascadeQueued!: () => void;
    const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
    const firstWriteStarted = new Promise<void>(resolve => { startedFirstWrite = resolve; });
    const secondStatStarted = new Promise<void>(resolve => { startSecondStat = resolve; });
    const secondStatFinished = new Promise<void>(resolve => { finishSecondStat = resolve; });
    const secondQueued = new Promise<void>(resolve => { secondCascadeQueued = resolve; });
    let statCount = 0;
    let secondStatComplete = false;
    let notifiedQueued = false;
    let writeCount = 0;
    const writeRoots: Array<string | null> = [];
    const raceSafe = new PaneCascadeController({
      state: {
        getPaneLinks: () => {
          const result = state.getPaneLinks();
          if (secondStatComplete && !notifiedQueued) {
            notifiedQueued = true;
            // getPaneLinks 在 enqueue 操作之前呼叫；microtask 令同步 enqueue 完成後再解鎖首筆寫入。
            queueMicrotask(secondCascadeQueued);
          }
          return result;
        },
        setPaneLinks: async links => {
          writeRoots.push(links.pane2.root);
          if (writeCount++ === 0) {
            startedFirstWrite();
            await firstWriteGate;
          }
          await state.setPaneLinks(links);
        },
      },
      getRuntime: id => runtimes.get(id),
      isAllowedRoot: isAllowedSpaceRoot,
      stat: async uri => {
        if (++statCount === 2) {
          startSecondStat();
          const result = await vscode.workspace.fs.stat(uri);
          secondStatComplete = true;
          finishSecondStat();
          return result;
        }
        return await vscode.workspace.fs.stat(uri);
      },
      directoryType: vscode.FileType.Directory,
    });
    const emitter = new vscode.EventEmitter<PaneCascadeSelection | undefined>();
    raceSafe.attach('pane1', listener => emitter.event(listener));
    emitter.fire(await directoryNode(providers[0], nested));
    await firstWriteStarted;
    emitter.fire({ uri: vscode.Uri.file(deeper), isDirectory: true });
    await secondStatStarted;
    await secondStatFinished;
    await secondQueued;
    releaseFirstWrite();
    await waitFor(() => writeRoots.length === 2 && runtimes.get('pane2')!.scope!.root === deeper);
    assert.deepEqual(writeRoots, [nested, deeper]);
    assert.equal((state.getPaneLinks() ?? {}).pane2.root, deeper);
    assert.equal(runtimes.get('pane2')!.scope!.root, deeper);
    raceSafe.dispose();
    emitter.dispose();
  }));

  test('parent scope snapshot changes invalidate a deferred selection', async () => withCascade(async ({ state, controller, runtimes, providers }) => {
    controller.dispose();
    const parent = runtimes.get('pane1')!;
    const originalChildRoot = (state.getPaneLinks() ?? {}).pane2.root;
    for (const changedField of ['root', 'basePath'] as const) {
      let releaseStat!: () => void;
      let startedStat!: () => void;
      const statGate = new Promise<void>(resolve => { releaseStat = resolve; });
      const statStarted = new Promise<void>(resolve => { startedStat = resolve; });
      const delayed = new PaneCascadeController({
        state,
        getRuntime: id => runtimes.get(id),
        isAllowedRoot: isAllowedSpaceRoot,
        stat: async uri => { startedStat(); await statGate; return await vscode.workspace.fs.stat(uri); },
        directoryType: vscode.FileType.Directory,
      });
      const emitter = new vscode.EventEmitter<PaneCascadeSelection | undefined>();
      delayed.attach('pane1', listener => emitter.event(listener));
      emitter.fire(await directoryNode(providers[0], nested));
      await statStarted;
      if (changedField === 'root') parent.scope!.root = deeper;
      else parent.scope!.basePath = deeper;
      releaseStat();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((state.getPaneLinks() ?? {}).pane2.root, originalChildRoot);
      assert.equal(runtimes.get('pane2')!.scope!.root, alpha);
      if (changedField === 'root') parent.scope!.root = alpha;
      else parent.scope!.basePath = alpha;
      delayed.dispose();
      emitter.dispose();
    }
  }));

  test('removing the child runtime and link during pending stat prevents persistence', async () => withCascade(async ({ state, runtimes, providers }) => {
    let releaseStat!: () => void;
    let startedStat!: () => void;
    const statGate = new Promise<void>(resolve => { releaseStat = resolve; });
    const statStarted = new Promise<void>(resolve => { startedStat = resolve; });
    let controllerWrites = 0;
    const removable = new PaneCascadeController({
      state: {
        getPaneLinks: () => state.getPaneLinks(),
        setPaneLinks: async links => { controllerWrites++; await state.setPaneLinks(links); },
      },
      getRuntime: id => runtimes.get(id),
      isAllowedRoot: isAllowedSpaceRoot,
      stat: async uri => { startedStat(); await statGate; return await vscode.workspace.fs.stat(uri); },
      directoryType: vscode.FileType.Directory,
    });
    const emitter = new vscode.EventEmitter<PaneCascadeSelection | undefined>();
    removable.attach('pane1', listener => emitter.event(listener));
    emitter.fire(await directoryNode(providers[0], nested));
    await statStarted;
    const removedScope = runtimes.get('pane2')!.scope!;
    runtimes.delete('pane2');
    const links = { ...(state.getPaneLinks() ?? {}) };
    delete links.pane2;
    await state.setPaneLinks(links);
    releaseStat();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(controllerWrites, 0);
    assert.equal((state.getPaneLinks() ?? {}).pane2, undefined);
    assert.equal(removedScope.root, alpha);
    removable.dispose();
    emitter.dispose();
  }));
});
