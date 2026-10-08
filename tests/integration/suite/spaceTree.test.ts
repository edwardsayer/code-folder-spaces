import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceRootNode, SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceConfigEntry } from '../../../src/types';
import { assertFixtureWorkspace, clearGlobalSettings, fixtureWorkspace, withGlobalSettings } from './helpers';

// activation.test.ts 驗證 Extension Host 中 extension/view/commands 的啟用與註冊；
// 本檔獨立建構 provider，透過真實 VS Code 設定與 workspace.fs 驗證樹節點語意，避免依賴 activation 私有實例。

type Node = SpaceNode;

suite('空間樹 provider', () => {
  suiteSetup(() => assertFixtureWorkspace());
  suiteTeardown(() => clearGlobalSettings());

  async function withProvider<T>(spaces: SpaceConfigEntry[], run: (provider: SpaceTreeDataProvider) => Promise<T>, showFiles?: boolean): Promise<T> {
    return withGlobalSettings({ spaces, ...(showFiles === undefined ? {} : { showFiles }) }, async () => {
      const store = new SpaceStore();
      const provider = new SpaceTreeDataProvider(store);
      try {
        return await run(provider);
      } finally {
        provider.dispose();
        store.dispose();
      }
    });
  }

  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');
  const beta = path.join(fixtureWorkspace, 'spaces/beta');
  const logs = path.join(fixtureWorkspace, 'spaces/logs');
  const spaces = [alpha, beta];

  test('空間根保留設定順序與資源路徑', async () => withProvider(spaces, async (provider) => {
    const roots = await provider.getChildren() as Node[];
    assert.deepEqual(roots.map((node) => node.label), ['alpha', 'beta']);
    assert.ok(roots.every((node) => node.contextValue === 'codeFolderSpaces.spaceRoot'));
    assert.deepEqual(roots.map((node) => node.resourceUri?.fsPath), spaces);
    assert.ok(roots.every((node) => node.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
  }));

  test('展開目錄優先且不分大小寫排序', async () => withProvider([alpha], async (provider) => {
    const root = (await provider.getChildren())[0];
    const children = await provider.getChildren(root) as Node[];
    // B.txt 存在時，ASCII 大小寫敏感排序會讓 B 排在 a 前，因此可偵測 sensitivity:'base' 回歸。
    assert.deepEqual(children.map((node) => node.label), ['nested', 'a.txt', 'B.txt']);
    assert.equal(children[0].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(children[1].collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(children[1].contextValue, 'codeFolderSpaces.file');
    assert.equal(children[1].command?.command, 'vscode.open');
  }));

  test('exclude 過濾檔案且空目錄不可展開', async () => withProvider([{ path: path.dirname(logs), exclude: ['**/*.log'] }], async (provider) => {
    const root = (await provider.getChildren())[0];
    const children = await provider.getChildren(root) as Node[];
    const logsNode = children.find((node) => node.label === 'logs');
    assert.ok(logsNode);
    assert.equal(logsNode.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.ok(!children.some((node) => node.label === 'trace.log'));
    assert.deepEqual(await provider.getChildren(logsNode), []);
  }));

  test('include 僅顯示各層符合的 Markdown 檔案', async () => withProvider([
    { path: alpha, include: ['**/*.md'] },
    { path: beta, include: ['**/*.md'] },
  ], async (provider) => {
    const roots = await provider.getChildren();
    const alphaChildren = await provider.getChildren(roots[0]) as Node[];
    assert.deepEqual(alphaChildren.map((node) => node.label), ['nested']);
    const nestedChildren = await provider.getChildren(alphaChildren[0]) as Node[];
    assert.deepEqual(nestedChildren.map((node) => node.label), ['deep.md']);
    const betaChildren = await provider.getChildren(roots[1]) as Node[];
    assert.deepEqual(betaChildren.map((node) => node.label), ['nested']);
    assert.equal(betaChildren[0].collapsibleState, vscode.TreeItemCollapsibleState.None);
  }));

  test('per-space 與全域 showFiles=false 均隱藏檔案', async () => {
    await withProvider([{ path: alpha, showFiles: false }], async (provider) => {
      const root = (await provider.getChildren())[0];
      const children = await provider.getChildren(root) as Node[];
      assert.ok(children.length > 0);
      assert.ok(children.every((node) => node.contextValue !== 'codeFolderSpaces.file'));
    });
    await withProvider([alpha], async (provider) => {
      const root = (await provider.getChildren())[0];
      const children = await provider.getChildren(root) as Node[];
      assert.ok(children.length > 0);
      assert.ok(children.every((node) => node.contextValue !== 'codeFolderSpaces.file'));
    }, false);
  });

  test('findNodeByPath 解析可見路徑並拒絕過濾或外部路徑', async () => withProvider([
    alpha,
    { path: path.dirname(logs), exclude: ['**/*.log'] },
  ], async (provider) => {
    const filePath = path.join(alpha, 'a.txt');
    const file = await provider.findNodeByPath(filePath) as Node | undefined;
    assert.ok(file);
    assert.equal(file.contextValue, 'codeFolderSpaces.file');
    assert.equal(file.resourceUri?.fsPath, filePath);
    assert.equal(await provider.findNodeByPath(path.join(logs, 'trace.log')), undefined);
    assert.equal(await provider.findNodeByPath(path.join(os.tmpdir(), 'outside-folder-spaces.txt')), undefined);
    assert.ok(await provider.findNodeByPath(alpha) instanceof SpaceRootNode);
  }));

  test('空間名稱預設為 basename 並可由 name 覆寫', async () => withProvider([
    alpha,
    { path: beta, name: '自訂空間' },
  ], async (provider) => {
    const roots = await provider.getChildren();
    assert.deepEqual(roots.map((node) => node.label), ['alpha', '自訂空間']);
  }));
});
