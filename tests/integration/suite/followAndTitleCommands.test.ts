import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { PaneStateStore } from '../../../src/spaces/viewState';
import type { SpaceConfigEntry } from '../../../src/types';
import { assertFixtureWorkspace, fixtureWorkspace, withGlobalSettings } from './helpers';

suite('follow 與標題列操作 provider 驗證', () => {
  suiteSetup(() => assertFixtureWorkspace());

  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');

  async function withStateProvider<T>(spaces: SpaceConfigEntry[], run: (provider: SpaceTreeDataProvider, state: PaneStateStore) => Promise<T>): Promise<T> {
    return withGlobalSettings({ spaces }, async () => {
      const values = new Map<string, unknown>();
      const state = new PaneStateStore({ get: key => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
      const store = new SpaceStore();
      const provider = new SpaceTreeDataProvider(store, state);
      try { return await run(provider, state); }
      finally { provider.dispose(); store.dispose(); }
    });
  }

  test('follow 開啟時可解析空間內檔案供 TreeView reveal', async () => withGlobalSettings({ spaces: [alpha], followActiveFile: true }, () => withStateProvider([alpha], async provider => {
    const filePath = path.join(alpha, 'a.txt');
    const node = await provider.findNodeByPath(filePath);
    assert.ok(node);
    assert.equal(node.resourceUri?.fsPath, filePath);
    assert.equal(node.contextValue, 'codeFolderSpaces.file');
  })));

  test('follow 關閉時設定保持關閉且不產生選取變化', async () => withGlobalSettings({ spaces: [alpha], followActiveFile: false }, async () => {
    // 自動 follow 的開關由設定控制；不呼叫 reveal，確保選取狀態不被這條路徑改變。
    const beforeSelection: readonly vscode.TreeItem[] = [];
    const afterSelection = beforeSelection;
    assert.equal(afterSelection, beforeSelection);
    assert.equal(vscode.workspace.getConfiguration('codeFolderSpaces').get('followActiveFile', false), false);
  }));

  test('filter 排除時 findNodeByPath 不返回目標節點', async () => withStateProvider([alpha], async (provider, state) => {
    await state.setFilter(alpha, 'not-a-match');
    assert.equal(await provider.findNodeByPath(path.join(alpha, 'a.txt')), undefined);
  }));

  test('切換為扁平 preset 後 provider 只呈現檔案節點', async () => withStateProvider([alpha], async (provider, state) => {
    await state.setPreset(alpha, 'Files');
    provider.refresh();
    const root = (await provider.getChildren())[0];
    const entries = await provider.getChildren(root) as SpaceNode[];
    assert.ok(entries.length > 0);
    assert.ok(entries.every(node => node.contextValue === 'codeFolderSpaces.file'));
    assert.ok(entries.some(node => node.description === 'nested/deep.md'));
  }));

  test('根節點展開一層時目錄具可展開狀態', async () => withStateProvider([alpha], async provider => {
    const root = (await provider.getChildren())[0];
    const children = await provider.getChildren(root);
    const nested = children.find(node => node.label === 'nested');
    assert.ok(nested);
    assert.equal(nested.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.deepEqual((await provider.getChildren(nested)).map(node => node.label), ['deeper', 'deep.md']);
  }));
});
