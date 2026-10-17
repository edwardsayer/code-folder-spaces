import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { PANE_STATE_KEY, type PaneStateDocument } from '../../../src/spaces/viewState';
import type { SpaceDefinition } from '../../../src/types';
import {
  assertFixtureWorkspace,
  paneRootNode,
  clearGlobalSettings,
  createPaneStateHarness,
  createTempTree,
  fixtureWorkspace,
  removeTempTree,
  seedPane,
  withPaneCascade,
  withPaneProviders,
} from './helpers';

// S4R6「pane 解耦」驗收矩陣 PD-I1～PD-I5（spec §2.4.5）。
// 這些案例斷言 v2 的核心產品語意：pane 是獨立 Folder Space（root 可為任意資料夾）、
// 檢視狀態以 paneId 為歸宿、pane 之間以父子鏈結傳遞焦點、插槽上限 8、啟用數不再受 spaces 數量限制。

suite('pane 解耦（S4R6 PD-I1～PD-I5）', () => {
  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');
  const beta = path.join(fixtureWorkspace, 'spaces/beta');
  const alphaNested = path.join(alpha, 'nested');
  const alphaDeeper = path.join(alphaNested, 'deeper');

  suiteSetup(() => assertFixtureWorkspace());
  suiteTeardown(async () => {
    await clearGlobalSettings();
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for pane state.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  test('PD-I1 兩個 pane 各自不同 root（含非 spaces 的任意資料夾）互不影響', async () => {
    const loose = createTempTree({
      'todo.md': 'todo',
      'notes/inner.txt': 'inner',
      'ignore.log': 'log',
    });
    try {
      await withPaneProviders(
        [alpha],
        [
          // pane1 指向已配置的 space；pane2 指向**不在 spaces 設定中**的任意資料夾（S4R6-D61/D69）。
          { paneId: 'pane1', root: alpha },
          { paneId: 'pane2', root: loose, overrides: { exclude: ['**/*.log'] } },
        ],
        async ({ provider, state }) => {
          const pane1Root = paneRootNode(provider('pane1'));
          const pane2Root = paneRootNode(provider('pane2'));

          assert.equal(pane1Root.rootPath, alpha);
          assert.equal(pane1Root.paneId, 'pane1');
          assert.deepEqual((await provider('pane1').getChildren(pane1Root) as SpaceNode[]).map(node => node.label), ['nested', 'a.txt', 'B.txt']);

          // 任意資料夾根：名稱退回 basename，內容由 workspace.fs 正確列舉（pane2 的 exclude 生效）。
          assert.equal(pane2Root.rootPath, loose);
          assert.equal(pane2Root.paneId, 'pane2');
          assert.equal(pane2Root.label, path.basename(loose));
          assert.deepEqual((await provider('pane2').getChildren(pane2Root) as SpaceNode[]).map(node => node.label), ['notes', 'todo.md']);
          const notes = (await provider('pane2').getChildren(pane2Root) as SpaceNode[]).find(node => node.label === 'notes')!;
          assert.deepEqual((await provider('pane2').getChildren(notes) as SpaceNode[]).map(node => node.label), ['inner.txt']);

          // pane2 解析不到 pane1 的路徑，反之亦然（根邊界是各自 pane root，D67）。
          assert.ok(await provider('pane1').findNodeByPath(path.join(alpha, 'a.txt')));
          assert.equal(await provider('pane2').findNodeByPath(path.join(alpha, 'a.txt')), undefined);
          assert.ok(await provider('pane2').findNodeByPath(path.join(loose, 'notes/inner.txt')));
          assert.equal(await provider('pane1').findNodeByPath(path.join(loose, 'todo.md')), undefined);
          assert.equal(await provider('pane1').findNodeByPath(path.join(loose, 'ignore.log')), undefined);

          // 兩份 pane 狀態互不干擾：改 pane2 的過濾不改 pane1。
          await state.setFilter('pane2', 'inner');
          assert.deepEqual((await provider('pane2').getChildren(pane2Root) as SpaceNode[]).map(node => node.label), []);
          assert.deepEqual((await provider('pane1').getChildren(pane1Root) as SpaceNode[]).map(node => node.label), ['nested', 'a.txt', 'B.txt']);
        }
      );
    } finally {
      removeTempTree(loose);
    }
  });

  test('PD-I2 同一資料夾在兩個 pane：preset／filter／sort／下鑽完全隔離（F-S4R4-8 回歸）', async () => withPaneProviders(
    [alpha],
    [
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: alpha },
    ],
    async ({ provider, state, sync }) => {
      // 根相同也必須是可共存的兩個節點：id 帶 paneId，TreeView 才不會把它們當作同一項。
      const pane1Root = paneRootNode(provider('pane1'));
      const pane2Root = paneRootNode(provider('pane2'));
      assert.equal(pane1Root.rootPath, pane2Root.rootPath);
      assert.notEqual(pane1Root.id, pane2Root.id);
      assert.equal(pane1Root.id, `codeFolderSpaces.pane1:root:${alpha}`);
      assert.equal(pane2Root.id, `codeFolderSpaces.pane2:root:${alpha}`);

      // pane1 改扁平 preset，pane2 維持樹狀。
      await state.setPreset('pane1', 'Files');
      const pane1Flat = await provider('pane1').getChildren(pane1Root) as SpaceNode[];
      assert.ok(pane1Flat.every(node => node.contextValue === 'codeFolderSpaces.file'));
      assert.ok(pane1Flat.some(node => String(node.label) === 'nested/deep.md'));
      const pane2Tree = await provider('pane2').getChildren(pane2Root) as SpaceNode[];
      assert.deepEqual(pane2Tree.map(node => node.label), ['nested', 'a.txt', 'B.txt']);
      assert.equal(pane2Tree[0].contextValue, 'codeFolderSpaces.folder');

      // filter 只落 pane1。
      await state.setFilter('pane1', 'deep');
      assert.deepEqual((await provider('pane1').getChildren(pane1Root) as SpaceNode[]).map(node => node.label), ['nested/deep.md', 'nested/deeper/two-level.md']);
      assert.deepEqual((await provider('pane2').getChildren(pane2Root) as SpaceNode[]).map(node => node.label), ['nested', 'a.txt', 'B.txt']);

      // sort 只落 pane2（pane1 維持 name asc）。
      await state.setSort('pane2', 'mtime', 'desc');
      assert.deepEqual(state.get('pane1').sort, { key: 'name', direction: 'asc' });
      assert.deepEqual(state.get('pane2').sort, { key: 'mtime', direction: 'desc' });

      // 下鑽只改 pane1 的 root；pane2 不受影響（v1 的 bySpace 共用是 F-S4R4-8 的根因）。
      await state.drillDown('pane1', alphaNested);
      sync('pane1');
      assert.equal(state.get('pane1').drillRoot, alphaNested);
      assert.equal(state.get('pane1').drillStack.length, 1);
      assert.equal(state.get('pane2').drillStack.length, 0);
      assert.deepEqual(state.get('pane2').roots, [alpha]);
      // pane2 仍能解析原根下的路徑；pane1 下鑽後該路徑不在其根內。
      assert.ok(await provider('pane2').findNodeByPath(path.join(alpha, 'a.txt')));
      assert.equal(await provider('pane1').findNodeByPath(path.join(alpha, 'a.txt')), undefined);
    }
  ));

  test('PD-I3 在此開子 pane：最低空閒插槽、parentPaneId、follow=true 並繼承來源顯示設定', async () => withPaneCascade(
    [alpha],
    [
      // pane2 已被佔用（來源 pane1 之下），「在此開子 pane」必須取 pane3 而非 pane2。
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: beta, parentPaneId: 'pane1', follow: false },
    ],
    async ({ state, provider, runtimes, sync, emit, attachCascade, reload }) => {
      // 來源 pane 先自訂顯示設定（子 pane 應繼承）。
      await state.setPaneDisplay('pane1', { showFiles: false, exclude: ['**/*.md'] });

      // extension.ts addChildPane 的 store 流程：最低空閒且大於來源編號的插槽。
      const childId = state.allocatePaneId(2);
      assert.equal(childId, 'pane3', 'pane2 已佔用時應分配 pane3');
      const source = state.get('pane1');
      await state.enablePane(childId, {
        roots: [alphaNested],
        parentPaneId: 'pane1',
        follow: true,
        showFiles: source.showFiles,
        include: [...source.include],
        exclude: [...source.exclude],
      });

      // 新插槽啟用＋鏈結與繼承。
      assert.deepEqual(state.getEnabledPaneIds(), ['pane1', 'pane2', 'pane3']);
      const child = state.get('pane3');
      assert.equal(child.parentPaneId, 'pane1');
      assert.equal(child.follow, true);
      assert.equal(child.roots[0] ?? null, alphaNested);
      assert.equal(child.showFiles, false, '顯示設定繼承來源 pane（D64）');
      assert.deepEqual(child.exclude, ['**/*.md']);
      assert.equal(state.get('pane2').roots[0] ?? null, beta, '既有 pane2 不受影響');

      // 新 pane 的 provider 正確列舉被點擊的資料夾（showFiles=false → 只列目錄）。
      const childProvider = provider('pane3');
      sync('pane3');
      attachCascade('pane3');
      const root = paneRootNode(childProvider);
      assert.equal(root.rootPath, alphaNested);
      assert.equal(root.id, `codeFolderSpaces.pane3:root:${alphaNested}`);
      assert.deepEqual((await childProvider.getChildren(root) as SpaceNode[]).map(node => node.label), ['deeper']);

      // 父焦點傳遞生效：pane1 選取 deeper → pane3 跟進，且 follow 維持 true。
      emit('pane1', { uri: vscode.Uri.file(alphaDeeper), isDirectory: true });
      await waitFor(() => (state.get('pane3').roots[0] ?? null) === alphaDeeper);
      assert.equal(runtimes.get('pane3')!.scope!.root, alphaDeeper);
      assert.equal(state.get('pane3').follow, true);

      // 持久化：同一 memento 重載後鏈結與 root 還在。
      const restored = reload().get('pane3');
      assert.equal(restored.parentPaneId, 'pane1');
      assert.equal(restored.roots[0] ?? null, alphaDeeper);
    }
  ));

  test('PD-I4 關閉中間 pane：子 pane 重掛到其父、v2 一致且重載後還原', async () => withPaneCascade(
    [alpha, beta],
    [
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: alphaNested, parentPaneId: 'pane1', follow: true },
      { paneId: 'pane3', root: alphaDeeper, parentPaneId: 'pane2', follow: true },
      // pane4 先放在另一個空間的資料夾，以便觀察重掛後的連動目標。
      { paneId: 'pane4', root: path.join(beta, 'nested'), parentPaneId: 'pane3', follow: true },
    ],
    async ({ state, provider, reload, memento, sync, emit }) => {
      await state.disablePane('pane3');

      // pane4 重掛到被關閉者的父（pane2）；被關的插槽從文件消失。
      assert.deepEqual(state.getEnabledPaneIds(), ['pane1', 'pane2', 'pane4']);
      assert.equal(state.get('pane4').parentPaneId, 'pane2');
      assert.equal(state.get('pane4').follow, true, '仍有父 → 維持 follow');
      assert.equal(state.getPaneLinks().pane3, undefined);
      assert.equal(state.getPaneLinks().pane2.parentPaneId, 'pane1');
      // 其餘 pane 的 root 不受影響（v2 無共用 bySpace 狀態）。
      assert.equal(state.get('pane2').roots[0] ?? null, alphaNested);
      assert.equal(state.get('pane1').roots[0] ?? null, alpha);

      // 重載（新 PaneStateStore 讀同一份 memento）→ 完整還原，不含 pane3。
      const restoredStore = reload();
      assert.deepEqual(restoredStore.getEnabledPaneIds(), ['pane1', 'pane2', 'pane4']);
      const restored = restoredStore.get('pane4');
      assert.equal(restored.parentPaneId, 'pane2');
      assert.equal(restored.roots[0] ?? null, path.join(beta, 'nested'));
      assert.equal(restored.follow, true);
      // panes.v3 文件級一致性：version 3、被關插槽已消失、無孤兒 parent 引用、無循環。
      const persisted = memento.get<PaneStateDocument>(PANE_STATE_KEY)!;
      assert.equal(persisted.version, 3);
      assert.deepEqual(Object.keys(persisted.panes).sort(), ['pane1', 'pane2', 'pane4']);
      assert.equal(persisted.panes.pane3, undefined);
      const enabled = new Set(restoredStore.getEnabledPaneIds());
      for (const paneId of enabled) {
        const parent = restoredStore.get(paneId).parentPaneId;
        assert.ok(parent === null || enabled.has(parent), `${paneId} 的 parentPaneId 指向未啟用的插槽`);
        let depth = 0;
        let cursor: string | null = parent;
        const seen = new Set<string>([paneId]);
        while (cursor) {
          assert.ok(!seen.has(cursor), `${paneId} 的鏈結出現循環`);
          seen.add(cursor);
          cursor = restoredStore.get(cursor).parentPaneId;
          depth++;
          assert.ok(depth <= 8, '鏈深度不得超過八個插槽');
        }
      }

      // 重掛後焦點傳遞仍然運作：pane2 選取 deeper → pane4 由另一空間跟進 pane2 的根內。
      sync('pane2');
      emit('pane2', { uri: vscode.Uri.file(alphaDeeper), isDirectory: true });
      await waitFor(() => (state.get('pane4').roots[0] ?? null) === alphaDeeper);
      assert.equal(state.get('pane4').parentPaneId, 'pane2');
      // 重掛後的子 pane 由新的父根列出內容（不再停留在原 pane3 的根）。
      const pane4Root = paneRootNode(provider('pane4'));
      assert.equal(pane4Root.rootPath, alphaDeeper);
      assert.deepEqual((await provider('pane4').getChildren(pane4Root) as SpaceNode[]).map(node => node.label), ['two-level.md']);
    }
  ));

  test('PD-I5 啟用數 = min(count, 8) 且不受 spaces 數量影響；無 spaces 時 pane 仍存在', async () => {
    const space = (basePath: string): SpaceDefinition => ({
      basePath,
      name: path.basename(basePath),
      showFiles: true,
      include: [],
      exclude: [],
      sourceIndex: 0,
    });
    const initContext = (spaces: SpaceDefinition[], configuredCount: number) => ({ spaces, showFilesDefault: true, configuredCount, followWorkspaceDirectoryDefault: false });

    // 無任何 spaces：仍然啟用 count 個 pane（v1 會因 min(spaces) 而降為 0／1）。
    const noSpaces = createPaneStateHarness();
    const created = await noSpaces.state.initialize(initContext([], 2));
    assert.equal(created.kind, 'created');
    assert.deepEqual(noSpaces.state.getEnabledPaneIds(), ['pane1', 'pane2']);
    assert.deepEqual(noSpaces.state.get('pane1').roots, []);
    assert.equal(noSpaces.state.get('pane2').parentPaneId, 'pane1');
    assert.equal(noSpaces.state.get('pane2').follow, true);

    // 只有 1 個 space、count 3：3 個 pane 都啟用（超出 space 數的 pane root 為 null）。
    const oneSpace = createPaneStateHarness();
    await oneSpace.state.initialize(initContext([space(alpha)], 3));
    assert.deepEqual(oneSpace.state.getEnabledPaneIds(), ['pane1', 'pane2', 'pane3']);
    assert.deepEqual(oneSpace.state.get('pane1').roots, [alpha]);
    assert.deepEqual(oneSpace.state.get('pane2').roots, []);

    // count 超過 8：以硬上限 8 截斷。
    const clamped = createPaneStateHarness();
    await clamped.state.initialize(initContext([], 20));
    assert.equal(clamped.state.getEnabledPaneIds().length, 8);
    assert.deepEqual(clamped.state.getEnabledPaneIds(), Array.from({ length: 8 }, (_, index) => `pane${index + 1}`));

    // 無 root 的 pane：provider 不列舉任何節點（由 viewsWelcome 接管畫面）。
    await withPaneCascade([], [{ paneId: 'pane1', root: null }], async ({ state, provider, sync }) => {
      assert.deepEqual(state.get('pane1').roots, []);
      sync('pane1');
      assert.deepEqual(await provider('pane1').getChildren(), []);
    });

    // 畫面替代：8 個插槽都貢獻了 !hasSpaces 的 viewsWelcome。
    const packageJSON = vscode.extensions.getExtension('edwardsayer.code-folder-spaces')?.packageJSON as
      | { contributes: { viewsWelcome: Array<{ view: string; contents: string; when?: string }> } }
      | undefined;
    assert.ok(packageJSON, '整合測試必須能讀到被測擴充套件的 packageJSON');
    const welcomes = packageJSON.contributes.viewsWelcome.filter(entry => entry.view.startsWith('codeFolderSpaces.pane'));
    assert.equal(welcomes.length, 8, '每個 pane 插槽都應有 viewsWelcome');
    assert.ok(welcomes.every(entry => entry.when === '!codeFolderSpaces.hasSpaces'));

    // pane1 無 root 時仍可被後續設為任意資料夾（不再受 spaces 清單限制）。
    const loose = createTempTree({ 'only.md': 'only' });
    try {
      await withPaneProviders([], [{ paneId: 'pane1', root: loose }], async ({ provider }) => {
        const root = paneRootNode(provider('pane1'));
        assert.equal(root.rootPath, loose);
        assert.deepEqual((await provider('pane1').getChildren(root) as SpaceNode[]).map(node => node.label), ['only.md']);
      });
    } finally {
      removeTempTree(loose);
    }
  });

  test('PD-I5 補充：來源 pane 不存在時 allocatePaneId 仍回最低空閒插槽（8 個用滿回 undefined）', async () => {
    const harness = createPaneStateHarness();
    await harness.state.initialize({ spaces: [], showFilesDefault: true, configuredCount: 8, followWorkspaceDirectoryDefault: false });
    assert.equal(harness.state.allocatePaneId(), undefined, '八個插槽用滿時不得再分配');
    await harness.state.disablePane('pane5');
    assert.equal(harness.state.allocatePaneId(), 'pane5', '關閉中間 pane 後釋放其插槽');
  });
});

suite('S4R6 命令接線（結構型節點驅動；審查 F-02／F-11）', () => {
  const api = async (): Promise<{ getPanes(): Array<{ id: string; root: string | null; parentPaneId: string | null; follow: boolean }> }> => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    return await extension.activate() as never;
  };

  test('pane.addChild 建立子窗格並在已有子窗格時重用它；非資料夾目標回退至 pane 根', async () => {
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    await vscode.commands.executeCommand('codeFolderSpaces.pane.remove', 'pane2');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-addchild-'));
    const before = (await api()).getPanes();
    // 結構型節點：與 SpaceEntryNode 同形（不再依賴 instanceof，見 F-02）。
    const folderNode = {
      uri: vscode.Uri.file(root),
      isDirectory: true,
      paneId: 'pane1',
      space: { basePath: before[0].root ?? root, name: 'x', showFiles: true, include: [], exclude: [], sourceIndex: 0 },
    };
    await vscode.commands.executeCommand('codeFolderSpaces.pane.addChild', folderNode);
    const after = (await api()).getPanes();
    assert.equal(after.length, before.length + 1);
    const child = after[after.length - 1];
    assert.equal(child.parentPaneId, 'pane1');
    assert.equal(child.follow, true);
    // Windows 的 Uri.file 會把磁碟機字母轉小寫，比對前先正規化大小寫（同 S4R4 的處置）。
    assert.equal(path.normalize(String(child.root ?? null)).toLowerCase(), path.normalize(root).toLowerCase());

    // 再按 + 時重用既有子窗格，切換其根且保持 follow／插槽數不變。
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-addchild-second-'));
    await vscode.commands.executeCommand('codeFolderSpaces.pane.addChild', { ...folderNode, uri: vscode.Uri.file(secondRoot) });
    const reused = (await api()).getPanes();
    assert.equal(reused.length, after.length);
    assert.equal(reused.find(pane => pane.id === child.id)?.follow, true);
    assert.equal(path.normalize(String(reused.find(pane => pane.id === child.id)?.root ?? null)).toLowerCase(), path.normalize(secondRoot).toLowerCase());

    // 非資料夾節點退回 pane1 的有效根，仍重用同一子窗格。
    await vscode.commands.executeCommand('codeFolderSpaces.pane.addChild', { ...folderNode, isDirectory: false });
    assert.equal((await api()).getPanes().length, after.length);

    // 清理：關閉剛建立的子窗格
    await vscode.commands.executeCommand('codeFolderSpaces.pane.remove', child.id);
    assert.equal((await api()).getPanes().length, before.length);
  });

  test('pane.remove 可關閉 pane1（S4.1R3），但拒絕最後一個窗格', async () => {
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    await vscode.commands.executeCommand('codeFolderSpaces.pane.remove', 'pane1');
    const afterFirst = (await api()).getPanes();
    assert.ok(!afterFirst.some((pane) => pane.id === 'pane1'), 'pane1 應已關閉');
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].parentPaneId, null, '剩餘窗格重掛為頂層');
    await vscode.commands.executeCommand('codeFolderSpaces.pane.remove', afterFirst[0].id);
    assert.equal((await api()).getPanes().length, 1, '最後一個窗格不可關閉');
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
  });

  test('PD-I6 成環操作被拒絕：反向／自我鏈結拋出且狀態不變（S4 DoD 補驗）', async () => {
    // 獨立於 unit 測試的 store 層取證：真實 PaneStateStore（整合層）拒絕建立環，
    // 且被拒後既有鏈結不受污染；forward 重新指派仍可設定。
    const { state } = createPaneStateHarness();
    const rootA = path.join(fixtureWorkspace, 'spaces/alpha');
    const rootB = path.join(fixtureWorkspace, 'spaces/beta');
    const rootC = path.join(fixtureWorkspace, 'spaces/alpha/nested/deeper');
    await seedPane(state, 'pane1', { root: rootA });
    await seedPane(state, 'pane2', { root: rootB, parentPaneId: 'pane1', follow: true });
    await seedPane(state, 'pane3', { root: rootC, parentPaneId: 'pane2', follow: true });

    // 反向鏈結：pane1 指向 pane3 會形成 pane1→pane2→pane3→pane1 環 → 拒絕。
    await assert.rejects(() => state.setPaneParent('pane1', 'pane3', true), /acyclic/);
    assert.equal(state.get('pane1').parentPaneId, null, '被拒後 pane1 不得有父');

    // 自我鏈結 → 拒絕且 pane2 原鏈結不變。
    await assert.rejects(() => state.setPaneParent('pane2', 'pane2', true), /acyclic/);
    assert.equal(state.get('pane2').parentPaneId, 'pane1', '被拒後 pane2 鏈結不變');

    // forward（pane3 改指 pane1，跳過 pane2）不構成環 → 接受。
    await state.setPaneParent('pane3', 'pane1', true);
    assert.equal(state.get('pane3').parentPaneId, 'pane1');
  });
});
