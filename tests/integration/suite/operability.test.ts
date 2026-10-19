import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { clearGlobalSettings, createTempTree, paneRootNode, removeTempTree, withPaneProviders } from './helpers';
import { effectiveView } from '../../../src/spaces/viewState';
import { matchPresetName } from '../../../src/spaces/viewPresets';

interface PaneInfo { id: string; root: string | null; roots: string[]; mode: 'tree' | 'dual'; slot: 'primary' | 'secondary' }
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
    await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.workspace', undefined, vscode.ConfigurationTarget.Workspace);
  });

  const normalize = (value: string | null): string => (value ?? '').split(String.fromCharCode(92)).join('/').toLowerCase();

  test('OP-9 addSpace 帶路徑參數：寫入設定並讓該資料夾顯示於窗格；重複選取不重複開窗格', async () => {
    const tree = createTempTree({ 'x/one.txt': '1' });
    try {
      const before = api.getPanes();
      await vscode.commands.executeCommand('codeFolderSpaces.addSpace', tree);
      const after = api.getPanes();
      // P2-10：原 `opened = after.length - before.length; assert(opened > 0)` 近乎恆真；
      // 改為直接斷言「新增的 pane」— 它必須是啟用中的 pane，且 root 指向該資料夾。
      const openedPanes = after.filter(pane => !before.some(prior => prior.id === pane.id));
      assert.ok(openedPanes.length > 0, '新增尚未存在的空間應開啟至少一個 pane');
      assert.ok(openedPanes.every(pane => normalize(pane.root) === normalize(tree)),
        `新增的 pane 必須以該資料夾為 root：${JSON.stringify(openedPanes)}`);
      await vscode.commands.executeCommand('codeFolderSpaces.addSpace', tree);
      assert.equal(api.getPanes().length, after.length, '重複新增不應再開窗格');
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
        // 翻回 tree：維持 level 1＋folders；v2 的 `view` 恆為顯式組合（已無 preset 欄位），
        // 命名投影僅由 `matchPresetName` 提供。
        await state.setViewAxis('pane1', { axis: 'mode', value: 'tree' });
        assert.equal(matchPresetName(effectiveView(state.get('pane1'))) , 'Columns');
        assert.deepEqual(state.get('pane1').view, { mode: 'tree', level: 1, content: 'folders' });
      });
    } finally {
      removeTempTree(tree);
    }
  });
});

// v2-redesign D4（2026-10-19）：就地下鑽**不再切換 preset/view**，只做 root 切換＋返回堆疊。
// 原本 S4.1R8／OP-12 的「自動套用 Contents」已由 spec §8 推翻，本 suite 改驗 v2 語意。
suite('v2 D4 就地下鑽（不再切換 preset）', () => {
  test('drillDown 只換根、不動 view；drillUp 完整還原原檢視狀態', async () => {
    const tree = createTempTree({ 'root.txt': 'r', 'sub/a.txt': 'a', 'sub/b.txt': 'b' });
    try {
      await withPaneProviders([tree], [{ paneId: 'pane1', root: tree }], async ({ provider, state }) => {
        // 初始狀態為預設 Explorer (tree)
        assert.equal(matchPresetName(effectiveView(state.get('pane1'))) , 'Explorer');

        // 執行就地下鑽
        await state.drillDown('pane1', path.join(tree, 'sub'));
        // v2 D4：下鑽不切 preset——view 維持 Explorer（tree/all/all）
        assert.equal(matchPresetName(effectiveView(state.get('pane1'))) , 'Explorer');

        const items = await provider('pane1').getChildren() as vscode.TreeItem[];
        // tree 模式下直接列出下鑽根的內容（檔案＋資料夾），不產生 '.' 資料夾群組列。
        assert.deepEqual(items.map(node => String(node.label)).sort(), ['a.txt', 'b.txt']);

        // 返回上一層
        const success = await state.drillUp('pane1');
        assert.ok(success);
        assert.equal(matchPresetName(effectiveView(state.get('pane1'))) , 'Explorer');
        assert.deepEqual(state.get('pane1').roots, [tree]);
        assert.equal(state.get('pane1').drillRoot, null);
      });
    } finally {
      removeTempTree(tree);
    }
  });
});

// v2-R1：OP-13（adaptive cascade parent）已由 spec §7 移除，無 v2 承接功能，相關案例整併刪除。

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
