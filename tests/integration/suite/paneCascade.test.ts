import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PaneCascadeStateAdapter } from '../../../src/spaces/paneCascade';
import { SpaceEntryNode, type SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import { assertFixtureWorkspace, fixtureWorkspace, sameFixturePath, withPaneCascade } from './helpers';

// S4R6（pane 解耦，spec §2.4）改寫說明：
// - `PaneCascadeScope` 由 `{ basePath, root }` 改為 `{ paneId, root }`：cascade 的允許根守門改為
//   **父 pane 自己的 root**（D67），不再要求子 pane 命中同一個 space。
// - 狀態寫入由 `setPaneLinks(all)` 改為 `setPaneRoot(paneId, root)`（D74）：父 pane 每次選取不同
//   資料夾都覆寫子 root；子 pane 的手動值是暫時覆寫，`follow` 維持不變。
// - v1「子 pane 已切至不同空間 → 拒絕連動」的 scope guard 案例改寫為 D61/D74 等價行為
//   （見「父 pane 選取一律覆寫子 pane 的手動 root」），並新增 D67 邊界案例。
// - 關閉 pane 走 `disablePane(paneId)`（子樹重掛語意另見 PD-I4 與單元 PD-U3）。

suite('pane cascade controller integration', () => {
  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');
  const nested = path.join(alpha, 'nested');
  const deeper = path.join(nested, 'deeper');
  const beta = path.join(fixtureWorkspace, 'spaces/beta');
  const betaNested = path.join(beta, 'nested');

  suiteSetup(() => assertFixtureWorkspace());

  async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for pane cascade.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async function settle(ms = 180): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  async function directoryNode(provider: SpaceTreeDataProvider, wantedPath: string): Promise<SpaceEntryNode> {
    const root = (await provider.getChildren())[0];
    const children = await provider.getChildren(root);
    const node = children.find(child => child instanceof SpaceEntryNode && sameFixturePath(child.uri.fsPath, wantedPath));
    assert.ok(node instanceof SpaceEntryNode && node.isDirectory, `Expected directory node ${wantedPath}`);
    return node;
  }

  const chainSeeds = [
    { paneId: 'pane1', root: alpha },
    { paneId: 'pane2', root: alpha, parentPaneId: 'pane1', follow: true },
    { paneId: 'pane3', root: alpha, parentPaneId: 'pane2', follow: true },
  ];

  test('pane1→2→3 selection persists roots; file, follow-off and drill changes do not cascade', async () => withPaneCascade(
    [alpha],
    chainSeeds,
    async ({ state, provider, runtimes, emit, sync }) => {
      const selectedNested = await directoryNode(provider('pane1'), nested);
      emit('pane1', selectedNested);
      await waitFor(() => runtimes.get('pane2')!.scope!.root === nested);
      assert.equal(state.getPaneLinks().pane2.root, nested);
      assert.equal(state.get('pane2').follow, true);
      assert.equal((await provider('pane2').getChildren())[0].label, path.basename(nested));

      const selectedDeeper = await directoryNode(provider('pane2'), deeper);
      emit('pane2', selectedDeeper);
      await waitFor(() => runtimes.get('pane3')!.scope!.root === deeper);
      assert.equal(state.getPaneLinks().pane3.root, deeper);

      // 檔案選取不連動。
      const file = (await provider('pane1').getChildren((await provider('pane1').getChildren())[0]))
        .find(child => child instanceof SpaceEntryNode && !child.isDirectory) as SpaceEntryNode;
      const beforeFile = runtimes.get('pane2')!.scope!.root;
      emit('pane1', file);
      await settle(160);
      assert.equal(runtimes.get('pane2')!.scope!.root, beforeFile);

      // follow 關閉後不連動；root 維持現值。
      await state.setPaneParent('pane2', 'pane1', false);
      emit('pane1', { uri: vscode.Uri.file(alpha), isDirectory: true });
      await settle();
      assert.equal(runtimes.get('pane2')!.scope!.root, beforeFile);
      await state.setPaneParent('pane2', 'pane1', true);
      assert.equal(state.get('pane2').follow, true);

      // 下鑽只改該 pane 自己的 root（v2 無 bySpace 共用）；未發出 selection event 故不連動。
      const pane2RootBefore = runtimes.get('pane2')!.scope!.root;
      const pane3RootBefore = runtimes.get('pane3')!.scope!.root;
      const stackBefore = state.get('pane1').drillStack.length;
      await state.drillDown('pane1', nested);
      sync('pane1');
      assert.equal(state.get('pane1').drillStack.length, stackBefore + 1);
      assert.equal(state.get('pane2').root, nested);
      assert.equal(state.get('pane3').root, deeper);
      await settle(160);
      assert.equal(runtimes.get('pane2')!.scope!.root, pane2RootBefore);
      assert.equal(runtimes.get('pane3')!.scope!.root, pane3RootBefore);
      // 此處只驗證 drillDown 未發出 selection event；不代表已驗 UI 父 pane root 渲染。
    }
  ));

  test('父 pane 選取一律覆寫子 pane 的手動 root（S4R6-D61/D74；取代 v1 跨空間 scope guard）', async () => withPaneCascade(
    [alpha, beta],
    [
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: alpha, parentPaneId: 'pane1', follow: true },
    ],
    async ({ state, provider, runtimes, emit, sync }) => {
      const selectedNested = await directoryNode(provider('pane1'), nested);
      emit('pane1', selectedNested);
      await waitFor(() => runtimes.get('pane2')!.scope!.root === nested);

      // 使用者在子 pane 手動換到「另一個 space 的資料夾」（v1 會在此之後拒絕連動）。
      await state.switchRoot('pane2', betaNested);
      sync('pane2');
      assert.equal(state.get('pane2').root, betaNested);
      assert.equal(state.get('pane2').follow, true, '手動換根不得關閉 follow（D61）');

      // 父 pane 下次選取不同資料夾 → 子 pane 再次跟隨父（父焦點事件為最終權威，D74）。
      emit('pane1', { uri: vscode.Uri.file(deeper), isDirectory: true });
      await waitFor(() => runtimes.get('pane2')!.scope!.root === deeper);
      assert.equal(state.get('pane2').root, deeper);
      assert.equal(state.get('pane2').follow, true);
    }
  ));

  test('父 pane root 之外的選取不連動（D67：邊界是父 pane 自己的 root）', async () => withPaneCascade(
    [alpha, beta],
    [
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: beta, parentPaneId: 'pane1', follow: true },
    ],
    async ({ state, runtimes, emit }) => {
      emit('pane1', { uri: vscode.Uri.file(betaNested), isDirectory: true });
      await settle(200);
      assert.equal(runtimes.get('pane2')!.scope!.root, beta);
      assert.equal(state.get('pane2').root, beta);
      assert.equal(state.get('pane2').follow, true);
    }
  ));

  test('expectedRoot suppresses only the matching root event; a different folder still follows', async () => withPaneCascade(
    [alpha],
    chainSeeds,
    async ({ provider, runtimes, emit }) => {
      const selectedNested = await directoryNode(provider('pane1'), nested);
      emit('pane1', selectedNested);
      await waitFor(() => runtimes.get('pane2')!.scope!.root === nested);
      // Re-delivering the child root event is the TreeView echo caused by refresh.
      emit('pane2', { uri: vscode.Uri.file(nested), isDirectory: true });
      await settle(160);
      assert.equal(runtimes.get('pane3')!.scope!.root, alpha);

      emit('pane2', { uri: vscode.Uri.file(deeper), isDirectory: true });
      await waitFor(() => runtimes.get('pane3')!.scope!.root === deeper);
    }
  ));

  test('state persistence in flight is serialized so the queued newer selection wins', async () => withPaneCascade(
    [alpha],
    chainSeeds,
    async ({ state, adapter, provider, runtimes, createController, makeChannel }) => {
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
      const gatedAdapter: PaneCascadeStateAdapter = {
        getPaneLinks: () => {
          const result = adapter.getPaneLinks();
          if (secondStatComplete && !notifiedQueued) {
            notifiedQueued = true;
            // getPaneLinks 在 enqueue 操作之前呼叫；microtask 令同步 enqueue 完成後再解鎖首筆寫入。
            queueMicrotask(secondCascadeQueued);
          }
          return result;
        },
        setPaneRoot: async (paneId, root) => {
          writeRoots.push(root);
          if (writeCount++ === 0) {
            startedFirstWrite();
            await firstWriteGate;
          }
          await adapter.setPaneRoot(paneId, root);
        },
      };
      const raceSafe = createController(gatedAdapter, {
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
      });
      const channel = makeChannel('pane1', raceSafe);
      const selectedNested = await directoryNode(provider('pane1'), nested);
      channel.fire(selectedNested);
      await firstWriteStarted;
      channel.fire({ uri: vscode.Uri.file(deeper), isDirectory: true });
      await secondStatStarted;
      await secondStatFinished;
      await secondQueued;
      releaseFirstWrite();
      await waitFor(() => writeRoots.length === 2 && runtimes.get('pane2')!.scope!.root === deeper);
      assert.deepEqual(writeRoots, [nested, deeper]);
      assert.equal(state.getPaneLinks().pane2.root, deeper);
      assert.equal(runtimes.get('pane2')!.scope!.root, deeper);
      channel.dispose();
      raceSafe.dispose();
    }
  ));

  test('parent scope snapshot changes invalidate a deferred selection', async () => withPaneCascade(
    [alpha],
    chainSeeds,
    async ({ state, controller, provider, runtimes, createController, makeChannel }) => {
      controller.dispose();
      const originalChildRoot = state.getPaneLinks().pane2.root;
      // v2 scope 只有 paneId／root：root 被改、paneId 不符都是「快照過期」。
      for (const changedField of ['root', 'paneId'] as const) {
        const parent = runtimes.get('pane1')!;
        let releaseStat!: () => void;
        let startedStat!: () => void;
        const statGate = new Promise<void>(resolve => { releaseStat = resolve; });
        const statStarted = new Promise<void>(resolve => { startedStat = resolve; });
        // 用不帶 scope 同步的 adapter：若守門失效，延後寫入會真的落地並被下面斷言抓到。
        const delayed = createController({
          getPaneLinks: () => state.getPaneLinks(),
          setPaneRoot: async (paneId, root) => await state.setPaneRoot(paneId, root),
        }, {
          stat: async uri => {
            startedStat();
            await statGate;
            return await vscode.workspace.fs.stat(uri);
          },
        });
        const channel = makeChannel('pane1', delayed);
        channel.fire(await directoryNode(provider('pane1'), nested));
        await statStarted;
        if (changedField === 'root') parent.scope!.root = deeper;
        else parent.scope!.paneId = 'pane9';
        releaseStat();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(state.getPaneLinks().pane2.root, originalChildRoot);
        assert.equal(runtimes.get('pane2')!.scope!.root, alpha);
        if (changedField === 'root') parent.scope!.root = alpha;
        else parent.scope!.paneId = 'pane1';
        channel.dispose();
        delayed.dispose();
      }
    }
  ));

  test('removing the child runtime and link during pending stat prevents persistence', async () => withPaneCascade(
    [alpha],
    chainSeeds,
    async ({ state, provider, runtimes, createController, makeChannel }) => {
      let releaseStat!: () => void;
      let startedStat!: () => void;
      const statGate = new Promise<void>(resolve => { releaseStat = resolve; });
      const statStarted = new Promise<void>(resolve => { startedStat = resolve; });
      let controllerWrites = 0;
      const removable = createController({
        getPaneLinks: () => state.getPaneLinks(),
        setPaneRoot: async (paneId, root) => {
          controllerWrites++;
          await state.setPaneRoot(paneId, root);
        },
      }, {
        stat: async uri => {
          startedStat();
          await statGate;
          return await vscode.workspace.fs.stat(uri);
        },
      });
      const channel = makeChannel('pane1', removable);
      channel.fire(await directoryNode(provider('pane1'), nested));
      await statStarted;
      const removedScope = runtimes.get('pane2')!.scope!;
      // v2：關閉 pane 走 disablePane（並重掛其子 pane），等价於 v1 移除 pane2 的 link。
      runtimes.delete('pane2');
      await state.disablePane('pane2');
      releaseStat();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(controllerWrites, 0);
      assert.equal(state.getPaneLinks().pane2, undefined);
      assert.equal(removedScope.root, alpha);
      channel.dispose();
      removable.dispose();
    }
  ));
});
