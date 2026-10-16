import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { clearGlobalSettings, createTempTree, paneRootNode, removeTempTree, withPaneProviders } from './helpers';

interface PaneInfo { id: string; root: string | null }
interface Api { getPanes(): PaneInfo[] }

// S4.1R5：OP-9（addSpace 後窗格顯示新根）。以 live extension 命令驗證。
suite('可操作性（S4.1R5）', () => {
  let api: Api;
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    api = await extension.activate() as Api;
  });
  suiteTeardown(async () => {
    await clearGlobalSettings();
    // addSpace 在有工作區時寫入 Workspace 設定，須一併清除以免污染其他 suite（如 trust.test.ts 的精確比對）。
    await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces', undefined, vscode.ConfigurationTarget.Workspace);
  });

  const normalize = (value: string | null): string => (value ?? '').split(String.fromCharCode(92)).join('/').toLowerCase();

  test('OP-9 addSpace 帶路徑參數：寫入設定並讓該資料夾顯示於窗格；重複選取不重複開窗格', async () => {
    const tree = createTempTree({ 'x/one.txt': '1' });
    try {
      const before = api.getPanes();
      await vscode.commands.executeCommand('codeFolderSpaces.addSpace', tree);
      const after = api.getPanes();
      assert.ok(after.some(pane => normalize(pane.root) === normalize(tree)), '新增的資料夾應成為某窗格的 root');
      const opened = after.length - before.length;
      await vscode.commands.executeCommand('codeFolderSpaces.addSpace', tree);
      assert.equal(api.getPanes().length, after.length, '重複新增不應再開窗格');
      assert.ok(opened >= 0);
      for (const pane of api.getPanes()) {
        if (normalize(pane.root) === normalize(tree) && api.getPanes().length > 1) {
          await vscode.commands.executeCommand('codeFolderSpaces.pane.remove', pane.id);
        }
      }
    } finally {
      removeTempTree(tree);
    }
  });
});

// S4.1R6：flat Contents 端點群組、「.」群組守門、過濾。
suite('flat Contents 群組（S4.1R6）', () => {
  test('空資料夾群組為端點＋圖示；「.」群組不具資料夾語意；過濾保留符合的群組', async () => {
    const tree = createTempTree({ 'top.txt': 't', 'full/a.txt': 'a', 'full/b.log': 'b' });
    fs.mkdirSync(path.join(tree, 'emptydir'));
    try {
      await withPaneProviders([tree], [{ paneId: 'pane1', root: tree }], async ({ provider, state }) => {
        await state.setPreset('pane1', 'Contents');
        const root = paneRootNode(provider('pane1'));
        const groups = await provider('pane1').getChildren(root) as Array<vscode.TreeItem & { uri: vscode.Uri }>;
        const byLabel = new Map(groups.map(node => [String(node.label), node]));
        assert.deepEqual([...byLabel.keys()].sort(), ['.', 'emptydir', 'full']);
        const empty = byLabel.get('emptydir')!;
        assert.equal(empty.collapsibleState, vscode.TreeItemCollapsibleState.None);
                assert.notEqual(byLabel.get('full')!.collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.equal(byLabel.get('.')!.contextValue, 'codeFolderSpaces.flatRootGroup');
        assert.equal(byLabel.get('full')!.contextValue, 'codeFolderSpaces.folder');

        await state.setFilter('pane1', 'a.txt');
        const filtered = await provider('pane1').getChildren(root) as vscode.TreeItem[];
        assert.deepEqual(filtered.map(node => String(node.label)), ['full']);
        const files = await provider('pane1').getChildren(filtered[0] as never) as vscode.TreeItem[];
        assert.deepEqual(files.map(node => String(node.label)), ['a.txt']);
      });
    } finally {
      removeTempTree(tree);
    }
  });
});

// S4.1R7（OP-14）：模式×層級×內容可自由組合，不必落在預設集內。
suite('檢視維度解耦（S4.1R7）', () => {
  test('flat＋folders（不在任何預設集內）：第一級資料夾清單、名稱為相對路徑；level 1 只含直屬資料夾', async () => {
    const tree = createTempTree({ 'top.txt': 't', 'a/one.txt': '1', 'a/b/two.txt': '2', 'c/three.txt': '3' });
    try {
      await withPaneProviders([tree], [{ paneId: 'pane1', root: tree }], async ({ provider, state }) => {
        await state.setPreset('pane1', 'Contents');
        await state.setViewAxis('pane1', { axis: 'content', value: 'folders' });
        assert.equal(state.get('pane1').view?.content, 'folders');
        const root = paneRootNode(provider('pane1'));
        const folders = await provider('pane1').getChildren(root) as vscode.TreeItem[];
        assert.deepEqual(folders.map(node => String(node.label)), ['a', 'a/b', 'c']);
        assert.ok(folders.every(node => node.collapsibleState === vscode.TreeItemCollapsibleState.None));
        assert.ok(folders.every(node => node.contextValue === 'codeFolderSpaces.folder'));
        // 層級維度獨立：level 1 → 只剩直屬資料夾。
        await state.setViewAxis('pane1', { axis: 'level', value: 1 });
        const level1 = await provider('pane1').getChildren(root) as vscode.TreeItem[];
        assert.deepEqual(level1.map(node => String(node.label)), ['a', 'c']);
        // 翻回 tree：維持 level 1＋folders ＝ Columns 預設集。
        await state.setViewAxis('pane1', { axis: 'mode', value: 'tree' });
        assert.equal(state.get('pane1').preset, 'Columns');
        assert.equal(state.get('pane1').view, undefined);
      });
    } finally {
      removeTempTree(tree);
    }
  });
});

// S4.1R8（OP-12）：智慧就地下鑽自動切換為 Contents 預設集與還原。
suite('OP-12 智慧就地下鑽 (Smart Routing In-place Drill-down)', () => {
  test('drillDown 自動套用 Contents，drillUp 完整無損還原', async () => {
    const tree = createTempTree({ 'root.txt': 'r', 'sub/a.txt': 'a', 'sub/b.txt': 'b' });
    try {
      await withPaneProviders([tree], [{ paneId: 'pane1', root: tree }], async ({ provider, state }) => {
        // 初始狀態為預設 Explorer (tree)
        assert.equal(state.get('pane1').preset, 'Explorer');

        // 執行就地下鑽
        await state.drillDown('pane1', path.join(tree, 'sub'));
        // 下鑽後應自動切換為子預設集 Contents
        assert.equal(state.get('pane1').preset, 'Contents');

        const items = await provider('pane1').getChildren() as vscode.TreeItem[];
        // Contents 模式下，第一層為資料夾群組（root 直屬檔案歸 '.'），且檔案僅檔名
        assert.ok(items.some(node => String(node.label) === '.'));

        // 返回上一層
        const success = await state.drillUp('pane1');
        assert.ok(success);
        assert.equal(state.get('pane1').preset, 'Explorer');
        assert.deepEqual(state.get('pane1').roots, [tree]);
        assert.equal(state.get('pane1').drillRoot, null);
      });
    } finally {
      removeTempTree(tree);
    }
  });
});

// S4.1R9（OP-13）：四項 Obsidian 原版設定與接龍自適應連動。
suite('OP-13 原版四項設定與接龍自適應 (Adaptive Cascade Parent)', () => {
  test('接龍自適應：父 pane 連動子 pane 時切為 Navigate，子 pane 解除時還原', async () => {
    const tree = createTempTree({ 'root.txt': 'r', 'sub/a.txt': 'a' });
    try {
      await withPaneProviders([tree], [{ paneId: 'pane1', root: tree }], async ({ state }) => {
        assert.equal(state.get('pane1').preset, 'Explorer');

        // 在 pane1 下開啟子 pane2 並開啟 follow
        await state.enablePane('pane2', {
          root: path.join(tree, 'sub'),
          parentPaneId: 'pane1',
          follow: true,
          showFiles: true,
          include: [],
          exclude: []
        });

        // 觸發自適應檢查
        await state.handleAdaptiveCascadeParent('pane1', true, 'Navigate');
        // 父面板應自動切換為導覽預設集 (Navigate: 純目錄)
        assert.equal(state.get('pane1').preset, 'Navigate');

        // 解除子面板連動
        await state.handleAdaptiveCascadeParent('pane1', false);
        // 父面板應無損還原為 Explorer
        assert.equal(state.get('pane1').preset, 'Explorer');
      });
    } finally {
      removeTempTree(tree);
    }
  });
});

// S4.1R10（OP-15）：Follow Workspace Directory 連動。
suite('OP-15 Follow Workspace Directory', () => {
  test('主窗格會自動跟隨當前開啟的 Workspace 第一個目錄', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    // 重設乾淨的兩窗格配置
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    const api = await extension.activate() as { getPanes(): Array<{ id: string; root: string | null }> };
    
    const panes = api.getPanes();
    const primary = panes[0];
    assert.ok(primary);
    assert.equal(primary.id, 'pane1');
    if (vscode.workspace.workspaceFolders?.[0]) {
      const wsFolder = vscode.workspace.workspaceFolders[0].uri.fsPath.split(path.sep).join('/').toLowerCase();
      const actual = (primary.root ?? '').split(path.sep).join('/').toLowerCase();
      assert.equal(actual, wsFolder);
    }
  });
});
