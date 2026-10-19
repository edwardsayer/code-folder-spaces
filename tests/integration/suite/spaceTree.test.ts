import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceRootNode, SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { effectiveView, resolvePaneDefinition } from '../../../src/spaces/viewState';
import { VIEW_PRESETS } from '../../../src/spaces/viewPresets';
import type { SpaceConfigEntry } from '../../../src/types';
import {
  assertFixtureWorkspace,
  clearGlobalSettings,
  createPaneStateHarness,
  fixtureWorkspace,
  seedPane,
  withGlobalSettings,
  withPaneProviders,
} from './helpers';

// activation.test.ts 驗證 Extension Host 中 extension/view/commands 的啟用與註冊；
// 本檔獨立建構 provider，透過真實 VS Code 設定與 workspace.fs 驗證樹節點語意，避免依賴 activation 私有實例。
//
// S4R6（pane 解耦，spec §2.4）改寫說明：
// - 一個 provider 只代表**一個 pane**，節點來自該 pane 自己的 root（PaneProviderScope = { paneId, definition }）。
//   舊版「未帶 scope 的 provider 一次列出所有 spaces 根」屬 v1 語意，本檔一律改寫為「每 pane 一個根列」。
// - 檢視狀態（preset／filter／sort／下鑽）以 **paneId** 為 key；下鑽直接改變 pane.root，
//   因此根變更後必須 sync（等同 extension.ts 的 applyPaneScope）才能觀察到新根列舉。
// - 根節點 id 為 `codeFolderSpaces.<paneId>:root:<basePath>`（v1 的 `codeFolderSpaces.space:<root>` 已過時）。

type Node = SpaceNode;

async function rootOf(provider: SpaceTreeDataProvider): Promise<SpaceRootNode> {
  const scope = provider.scope;
  assert.ok(scope?.definitions[0]);
  return new SpaceRootNode(scope.definitions[0], scope.paneId);
}

suite('空間樹 provider', () => {
  suiteSetup(() => assertFixtureWorkspace());
  suiteTeardown(() => clearGlobalSettings());

  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');
  const beta = path.join(fixtureWorkspace, 'spaces/beta');
  const logs = path.join(fixtureWorkspace, 'spaces/logs');

  test('pane scoped provider 只呈現該 pane 的根並使用其定義', async () => withPaneProviders(
    [alpha, beta],
    [{ paneId: 'pane1', root: path.join(beta, 'nested') }],
    async ({ provider }) => {
      const scoped = provider('pane1');
      const scopedRoot = path.join(beta, 'nested');
      const children = await scoped.getChildren();
      assert.deepEqual(children.map(node => node.label), ['c.txt']);
      assert.ok(children.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
      assert.equal(await scoped.findNodeByPath(scopedRoot), undefined);
    }
  ));

  test('未帶 scope 的 provider 不列舉任何節點（v3：pane 是唯一列舉單位）', async () => withGlobalSettings({ spaces: [alpha, beta] }, async () => {
    const store = new SpaceStore();
    const { state } = createPaneStateHarness();
    const provider = new SpaceTreeDataProvider(store, state);
    try {
      assert.deepEqual(await provider.getChildren(), []);
      assert.equal(await provider.findNodeByPath(path.join(alpha, 'a.txt')), undefined);
    } finally {
      provider.dispose();
      store.dispose();
    }
  }));

  test('失效下鑽根 fallback 至既有 roots 並公開有效 definitions', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state, sync }) => {
      const scoped = provider('pane1');
      await state.drillDown('pane1', path.join(fixtureWorkspace, 'spaces/not-a-root'));
      // drillDown 會一併切換為 Contents（扁平）預設集；本案例要驗的是「無效下鑽根 → fallback 回 pane 既有 roots」，
      // 故先回復樹狀預設集（Explorer），否則扁平呈現（第一層僅資料夾群組）會被誤判為 fallback 失敗。
      await state.setPreset('pane1', 'Explorer');
      sync('pane1');
      assert.deepEqual(scoped.effectiveDefinitions().map(definition => definition.basePath), [alpha]);
      const children = await scoped.getChildren();
      assert.ok(children.some(node => node.label === 'nested'));
      assert.ok(children.some(node => node.label === 'a.txt'));
    }
  ));

  test('已下鑽的 pane 顯示下鑽根，返回後回復下鑽前根（spec §2.4.2）', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state, sync }) => {
      const scoped = provider('pane1');
      const drillRoot = path.join(alpha, 'nested');

      // 未下鑽 → 列舉 pane 自己的 root，可解析其可見路徑。
      const initial = await scoped.getChildren();
      assert.ok(initial.some(node => node.label === 'nested'));
      assert.ok(initial.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
      assert.equal((await scoped.findNodeByPath(path.join(alpha, 'a.txt')))?.label, 'a.txt');

      // 就地下鑽：v3 以 drillRoot 記錄下鑽位置，provider 需同步 scope。
      await state.drillDown('pane1', drillRoot);
      sync('pane1');
      const drilled = await scoped.getChildren();
      assert.ok(drilled.some(node => node.label === 'deeper'));
      assert.ok(drilled.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
      assert.equal(state.get('pane1').drillRoot, drillRoot);
      assert.equal((await scoped.findNodeByPath(path.join(alpha, 'nested/deep.md')))?.label, 'deep.md');
      // 下鑽根之外的路徑不得被視為可見。
      assert.equal(await scoped.findNodeByPath(path.join(alpha, 'a.txt')), undefined);

      // drillUp 後 stack 清空 → 回復下鑽前的根。
      assert.equal(await state.drillUp('pane1'), true);
      sync('pane1');
      const restored = await scoped.getChildren();
      assert.ok(restored.some(node => node.label === 'nested'));
      assert.ok(restored.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
      assert.equal((await scoped.findNodeByPath(path.join(alpha, 'a.txt')))?.label, 'a.txt');
    }
  ));

  test('pane 的 root 是列舉的唯一權威：resolvePaneDefinition 依 paneId 解析（v3 取代舊 resolveActiveRoot）', async () => withGlobalSettings({ spaces: [alpha] }, async () => {
    const store = new SpaceStore();
    const { state } = createPaneStateHarness();
    try {
      const space = store.getDefinitions()[0];
      await seedPane(state, 'pane1', { roots: [alpha] });
      // 未下鑽：definition.basePath = pane root，命中 space 時沿用其 name／icon。
      assert.equal(resolvePaneDefinition(state.get('pane1'), store.getDefinitions())?.basePath, alpha);
      assert.equal(resolvePaneDefinition(state.get('pane1'), store.getDefinitions())?.name, space.name);

      // 下鑽後由 pane.drillRoot 記錄目前有效根（v3 不再以 legacy root 欄位作持久狀態）。
      const drillRoot = path.join(alpha, 'nested');
      await state.drillDown('pane1', drillRoot);
      const drilled = resolvePaneDefinition(state.get('pane1'), store.getDefinitions());
      assert.equal(drilled?.basePath, alpha);
      assert.equal(drilled?.name, space.name);

      // 無 root 的 pane（viewsWelcome 情境）解析為 null。
      await seedPane(state, 'pane2', { roots: [] });
      assert.equal(resolvePaneDefinition(state.get('pane2'), store.getDefinitions()), null);
    } finally {
      store.dispose();
    }
  }));

  test('下鑽後 provider 從新根列舉，返回還原原檢視狀態', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state, sync }) => {
      const paneProvider = provider('pane1');
      await state.setPreset('pane1', 'Files');
      await state.setFilter('pane1', 'deep');
      await state.drillDown('pane1', path.join(alpha, 'nested'));
      sync('pane1');
      const drilled = await paneProvider.getChildren() as Node[];
      // v2-redesign D4：下鑽不再切換 preset/view，維持 Files（flat/all/files）→ 直接列出扁平的僅檔名。
      assert.deepEqual(drilled.map(node => node.label).sort(), ['deep.md', 'deeper/two-level.md']);
      assert.deepEqual(effectiveView(state.get('pane1')), { mode: 'flat', level: 'all', content: 'files' });
      assert.equal(await state.drillUp('pane1'), true);
      sync('pane1');
      const returned = await rootOf(paneProvider) as SpaceRootNode;
      assert.equal(returned.rootPath, alpha, '返回後根列應以 pane 的原始 root 為路徑');
      assert.equal(returned.id, `codeFolderSpaces.pane1:root:${alpha}`, 'root row id 應含 pane id 與 root 路徑');
      // 下鑽返回只還原 root，同時還原進入堆疊時的 preset／filter（v3 snapshot 語意）。
      assert.deepEqual(
        { view: effectiveView(state.get('pane1')), filter: state.get('pane1').filter, sort: state.get('pane1').sort, roots: state.get('pane1').roots, drillRoot: state.get('pane1').drillRoot, drillStack: state.get('pane1').drillStack },
        { view: { mode: 'flat', level: 'all', content: 'files' }, filter: 'deep', sort: { key: 'name', direction: 'asc' }, roots: [alpha], drillRoot: null, drillStack: [] }
      );
    }
  ));

  test('切換根更新 provider 樹但不改空間設定，並清空下鑽堆疊', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: path.join(alpha, 'nested') }],
    async ({ provider, state, sync }) => {
      const paneProvider = provider('pane1');
      const beforeSetting = vscode.workspace.getConfiguration('codeFolderSpaces').inspect('spaces')?.globalValue;
      const drilledRoot = await rootOf(paneProvider) as SpaceRootNode;
      assert.deepEqual((await paneProvider.getChildren(drilledRoot) as Node[]).map(node => node.label), ['deeper', 'deep.md']);
      await state.switchRoot('pane1', alpha);
      sync('pane1');
      const afterRoot = await rootOf(paneProvider) as SpaceRootNode;
      assert.equal(afterRoot.uri.fsPath, alpha);
      assert.deepEqual((await paneProvider.getChildren(afterRoot) as Node[]).map(node => node.label), ['nested', 'a.txt', 'B.txt']);
      assert.deepEqual(state.get('pane1').drillStack, []);
      assert.deepEqual(vscode.workspace.getConfiguration('codeFolderSpaces').inspect('spaces')?.globalValue, beforeSetting);
    }
  ));

  test('SpaceStore 重新命名會寫回設定名稱且保留原始路徑', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const previous = config.inspect<SpaceConfigEntry[]>('spaces')?.workspaceValue;
    try {
      await config.update('spaces', [alpha], vscode.ConfigurationTarget.Workspace);
      const store = new SpaceStore();
      try {
        assert.equal(await store.renameSpace(alpha, '新名稱'), true);
        const saved = config.inspect<SpaceConfigEntry[]>('spaces')?.workspaceValue;
        assert.deepEqual(saved, [{ path: alpha, name: '新名稱' }]);
      } finally { store.dispose(); }
    } finally {
      await config.update('spaces', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('MR-UI3 與 root metadata：單 root 不渲染根列，多 root 根列 id 唯一且名稱採 D70 fallback', async () => withPaneProviders(
    [{ path: alpha, name: 'Alpha space' }],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state, sync }) => {
      const singleProvider = provider('pane1');
      const singleRootNode = await singleProvider.getTreeItem(await rootOf(singleProvider));
      assert.equal((await singleProvider.getChildren()).some(node => node.contextValue === 'codeFolderSpaces.spaceRoot'), false,
        '單 root 模式應展平內容，不渲染根目錄列');
      assert.equal(singleRootNode.label, 'Alpha space', '命中 space 時使用 space name');
      assert.equal(singleRootNode.id, `codeFolderSpaces.pane1:root:${alpha}`);

      const fallbackRoot = path.join(path.dirname(alpha), 'unconfigured-fallback');
      await state.addPaneRoot('pane1', fallbackRoot);
      sync('pane1');
      const multiRoots = await provider('pane1').getChildren() as SpaceRootNode[];
      assert.equal(multiRoots.length, 2, '多 root 模式應渲染每個根列');
      assert.equal(new Set(multiRoots.map(node => node.id)).size, 2, '根列 id 必須唯一');
      assert.deepEqual(multiRoots.map(node => String(node.label)), ['Alpha space', 'unconfigured-fallback'],
        'D70 label 為命中 space.name，未命中時 fallback 至 root basename');
      assert.deepEqual(multiRoots.map(node => node.rootPath), [alpha, fallbackRoot]);
    }
  ));

  test('兩個單 root pane 各自平鋪呈現自己的根內容', async () => withPaneProviders(
    [alpha, { path: beta, name: '自訂空間' }],
    [{ paneId: 'pane1', root: alpha }, { paneId: 'pane2', root: beta }],
    async ({ provider, state }) => {
      // v2-redesign §2.2：`secondary` 的預設檢視是 `Contents`（flat）；本案例要驗「兩個 pane 各自
      // 平鋪呈現自己的根」，故明確把 pane2 設回 `Explorer`（tree/all/all），不依賴隱含預設。
      await state.setView('pane2', VIEW_PRESETS.Explorer);
      assert.deepEqual((await provider('pane1').getChildren()).map(node => node.label), ['nested', 'a.txt', 'B.txt']);
      assert.deepEqual((await provider('pane2').getChildren()).map(node => node.label), ['nested', 'b.md']);
      assert.ok((await provider('pane1').getChildren()).every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
      assert.equal(state.getEnabledPaneIds().join(','), 'pane1,pane2');
    }
  ));

  test('展開目錄優先且不分大小寫排序', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider }) => {
      const root = await rootOf(provider('pane1'));
      const children = await provider('pane1').getChildren(root) as Node[];
      // B.txt 存在時，ASCII 大小寫敏感排序會讓 B 排在 a 前，因此可偵測 sensitivity:'base' 回歸。
      assert.deepEqual(children.map((node) => node.label), ['nested', 'a.txt', 'B.txt']);
      assert.equal(children[0].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.equal(children[1].collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.equal(children[1].contextValue, 'codeFolderSpaces.file');
      assert.equal(children[1].command?.command, 'codeFolderSpaces.openEntry');
    }
  ));

  test('exclude 過濾檔案且空目錄不可展開', async () => withPaneProviders(
    [{ path: path.dirname(logs), exclude: ['**/*.log'] }],
    [{ paneId: 'pane1', root: path.dirname(logs) }],
    async ({ provider }) => {
      const root = await rootOf(provider('pane1'));
      const children = await provider('pane1').getChildren(root) as Node[];
      const logsNode = children.find((node) => node.label === 'logs');
      assert.ok(logsNode);
      assert.equal(logsNode.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.ok(!children.some((node) => node.label === 'trace.log'));
      assert.deepEqual(await provider('pane1').getChildren(logsNode), []);
    }
  ));

  test('include 僅顯示各層符合的 Markdown 檔案', async () => withPaneProviders(
    [
      { path: alpha, include: ['**/*.md'] },
      { path: beta, include: ['**/*.md'] },
    ],
    [{ paneId: 'pane1', root: alpha }, { paneId: 'pane2', root: beta }],
    async ({ provider, state }) => {
      // v2-redesign §2.2：pane2 預設 `Contents`（flat）；本案例比對「各層資料夾結構」，故明確設回 Explorer。
      await state.setView('pane2', VIEW_PRESETS.Explorer);
      const alphaChildren = await provider('pane1').getChildren(await rootOf(provider('pane1'))) as Node[];
      assert.deepEqual(alphaChildren.map((node) => node.label), ['nested']);
      const nestedChildren = await provider('pane1').getChildren(alphaChildren[0]) as Node[];
      assert.deepEqual(nestedChildren.map((node) => node.label), ['deeper', 'deep.md']);
      const deeperChildren = await provider('pane1').getChildren(nestedChildren[0]) as Node[];
      assert.deepEqual(deeperChildren.map((node) => node.label), ['two-level.md']);
      const betaChildren = await provider('pane2').getChildren(await rootOf(provider('pane2'))) as Node[];
      assert.deepEqual(betaChildren.map((node) => node.label), ['nested', 'b.md']);
      assert.equal(betaChildren[0].collapsibleState, vscode.TreeItemCollapsibleState.None);
    }
  ));

  test('showFiles 固定 true，space 設定中的舊值不隱藏檔案', async () => withPaneProviders(
    [{ path: alpha, showFiles: false }],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider }) => {
      const root = await rootOf(provider('pane1'));
      const children = await provider('pane1').getChildren(root) as Node[];
      assert.ok(children.some(node => node.contextValue === 'codeFolderSpaces.file'));
    }
  ));

  test('下鑽後 findNodeByPath 以有效根解析並拒絕該根外或過濾路徑', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state, sync }) => {
      const paneProvider = provider('pane1');
      await state.drillDown('pane1', path.join(alpha, 'nested'));
      sync('pane1');
      const filePath = path.join(alpha, 'nested/deep.md');
      const file = await paneProvider.findNodeByPath(filePath) as Node | undefined;
      assert.ok(file);
      assert.equal(file.contextValue, 'codeFolderSpaces.file');
      assert.equal(file.resourceUri?.fsPath, filePath);
      assert.equal(await paneProvider.findNodeByPath(path.join(alpha, 'a.txt')), undefined);
      await state.setFilter('pane1', 'not-a-match');
      assert.equal(await paneProvider.findNodeByPath(filePath), undefined);
    }
  ));

  test('findNodeByPath 解析可見路徑並拒絕過濾或外部路徑', async () => withPaneProviders(
    [alpha, { path: path.dirname(logs), exclude: ['**/*.log'] }],
    [{ paneId: 'pane1', root: alpha }, { paneId: 'pane2', root: path.dirname(logs) }],
    async ({ provider }) => {
      const filePath = path.join(alpha, 'a.txt');
      const file = await provider('pane1').findNodeByPath(filePath) as Node | undefined;
      assert.ok(file);
      assert.equal(file.contextValue, 'codeFolderSpaces.file');
      assert.equal(file.resourceUri?.fsPath, filePath);
      // 工作區外的不存在檔案、以及**不屬於該 pane root** 的路徑都必須被拒絕（S4R6-D67 邊界）。
      assert.equal(await provider('pane1').findNodeByPath(path.join(logs, 'trace.log')), undefined);
      assert.equal(await provider('pane1').findNodeByPath(path.join(os.tmpdir(), 'outside-folder-spaces.txt')), undefined);
      assert.equal(await provider('pane1').findNodeByPath(alpha), undefined);
      // 被 exclude 的檔案在其所屬 pane 仍不可見。
      assert.equal(await provider('pane2').findNodeByPath(path.join(logs, 'trace.log')), undefined);
    }
  ));

  test('扁平 Files 預設集列出遞迴檔案、保留 URI 與根相對路徑', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state }) => {
      await state.setPreset('pane1', 'Files');
      const root = await rootOf(provider('pane1'));
      const files = await provider('pane1').getChildren(root) as Node[];
      // OP-10：Files 為第一級清單，名稱為自 pane root 起的完整相對路徑。
      const deep = files.find((node) => node.label === 'nested/deep.md');
      assert.ok(deep);
      assert.equal(deep.resourceUri?.fsPath, path.join(alpha, 'nested/deep.md'));
      assert.equal(deep.description, undefined);
      assert.equal(deep.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.ok(files.every((node) => node.contextValue === 'codeFolderSpaces.file'));
      // 單 root 已隱藏根列，扁平列舉的首層項目沒有父列。
      assert.equal(provider('pane1').getParent(deep), undefined);
    }
  ));

  test('List 只列根層檔案，Files 遞迴列檔且 Contents 同時列目錄與檔案', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state }) => {
      const root = await rootOf(provider('pane1'));

      await state.setPreset('pane1', 'List');
      const list = await provider('pane1').getChildren(root) as Node[];
      assert.ok(list.length > 0);
      assert.ok(list.every((node) => node.contextValue === 'codeFolderSpaces.file'));
      assert.ok(!list.some((node) => String(node.label) === 'nested/deep.md'));

      await state.setPreset('pane1', 'Files');
      const files = await provider('pane1').getChildren(root) as Node[];
      assert.ok(files.some((node) => String(node.label) === 'nested/deep.md'));
      assert.ok(files.every((node) => node.contextValue === 'codeFolderSpaces.file'));

      await state.setPreset('pane1', 'Contents');
      const contents = await provider('pane1').getChildren(root) as Node[];
      // OP-10：Contents 第一層只有資料夾群組（root 直屬檔案歸入「.」），第二層才是僅檔名的檔案。
      assert.ok(contents.every((node) => node.contextValue === 'codeFolderSpaces.folder' || node.contextValue === 'codeFolderSpaces.flatRootGroup'));
      const labels = contents.map((node) => String(node.label));
      assert.ok(labels.includes('.'));
      assert.ok(labels.includes('nested'));
      assert.ok(labels.includes('nested/deeper'));
      const nested = contents.find((node) => node.label === 'nested')!;
      assert.notEqual(nested.collapsibleState, vscode.TreeItemCollapsibleState.None);
      const nestedFiles = await provider('pane1').getChildren(nested) as Node[];
      assert.deepEqual(nestedFiles.map((node) => String(node.label)), ['deep.md']);
      assert.ok(nestedFiles.every((node) => node.contextValue === 'codeFolderSpaces.file'));
      assert.equal(provider('pane1').getParent(nestedFiles[0])?.id, nested.id);
      // 檔案可由 findNodeByPath 以「群組＞檔案」兩層 reveal。
      const found = await provider('pane1').findNodeByPath(path.join(alpha, 'nested/deep.md')) as Node;
      assert.equal(String(found.label), 'deep.md');
      assert.equal(String((provider('pane1').getParent(found) as Node).label), 'nested');
    }
  ));

  test('Columns 限制為一層、Context 為兩層且 Navigate 僅顯示資料夾', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state }) => {
      const root = await rootOf(provider('pane1'));
      await state.setPreset('pane1', 'Columns');
      let nested = (await provider('pane1').getChildren(root) as Node[]).find((node) => node.label === 'nested')!;
      assert.equal(nested.collapsibleState, vscode.TreeItemCollapsibleState.None);
      await state.setPreset('pane1', 'Context');
      nested = (await provider('pane1').getChildren(root) as Node[]).find((node) => node.label === 'nested')!;
      assert.equal(nested.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      const second = await provider('pane1').getChildren(nested) as Node[];
      assert.deepEqual(second.map((node) => node.label), ['deeper']);
      assert.equal(second[0].collapsibleState, vscode.TreeItemCollapsibleState.None);
      await state.setPreset('pane1', 'Navigate');
      assert.ok((await provider('pane1').getChildren(root) as Node[]).every((node) => node.contextValue === 'codeFolderSpaces.folder'));
    }
  ));

  test('mtime 排序與路徑過濾可套用並清除，且回報符合數／總數', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state }) => {
      const paneProvider = provider('pane1');
      const root = await rootOf(paneProvider);
      await state.setSort('pane1', 'mtime', 'asc');
      const items = await paneProvider.getChildren(root) as Node[];
      const actualTimes = await Promise.all(items.map(async node => (await vscode.workspace.fs.stat(node.resourceUri!)).mtime));
      const expectedOrder = items.map((node, index) => ({ label: String(node.label), time: actualTimes[index] }))
        .sort((a, b) => a.time - b.time || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })).map(item => item.label);
      assert.deepEqual(items.map(node => node.label), expectedOrder);
      await state.setFilter('pane1', 'NESTED');
      const filtered = await paneProvider.getChildren(root) as Node[];
      assert.deepEqual(filtered.map(node => node.label), ['nested']);
      assert.equal(paneProvider.filterMessage, '1 / 3 matches');
      await state.setFilter('pane1', 'does-not-exist');
      assert.deepEqual(await paneProvider.getChildren(root), []);
      assert.equal(paneProvider.filterMessage, '0 / 3 matches');
      await state.clearFilter('pane1');
      assert.equal((await paneProvider.getChildren(root)).length, 3);
      assert.equal(paneProvider.filterMessage, '');
    }
  ));

  test('單 root pane 首層直接列出 root 子項，且不顯示根列（D3）', async () => withPaneProviders(
    [alpha],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider }) => {
      const children = await provider('pane1').getChildren();
      assert.deepEqual(children.map(node => node.label), ['nested', 'a.txt', 'B.txt']);
      assert.ok(children.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
      assert.ok(children.every(node => node.label !== path.basename(alpha)));
    }
  ));

  test('多 root pane 首層各列出一個根列（D3）', async () => withPaneProviders(
    [alpha, beta],
    [{ paneId: 'pane1', root: alpha }],
    async ({ provider, state, sync }) => {
      await state.addPaneRoot('pane1', beta);
      sync('pane1');
      const roots = await provider('pane1').getChildren();
      assert.equal(roots.length, 2);
      assert.ok(roots.every(node => node instanceof SpaceRootNode));
      assert.deepEqual(roots.map(node => (node as SpaceRootNode).rootPath).sort(), [alpha, beta].sort());
      assert.ok(roots.every(node => node.contextValue === 'codeFolderSpaces.spaceRoot'));
    }
  ));

  test('pane root label 命中 space name，未命中時 fallback 至 basename（S4R6-D70）', async () => withPaneProviders(
    [alpha, { path: beta, name: '設定名稱' }],
    [
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: beta },
      { paneId: 'pane3', root: path.join(path.dirname(alpha), 'unconfigured-fallback') },
    ],
    async ({ provider }) => {
      assert.equal((await rootOf(provider('pane1'))).label, 'alpha');
      assert.equal((await rootOf(provider('pane2'))).label, '設定名稱');
      assert.equal((await rootOf(provider('pane3'))).label, 'unconfigured-fallback');
    }
  ));
});
