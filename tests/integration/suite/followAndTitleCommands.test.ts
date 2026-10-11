import * as assert from 'node:assert/strict';
import { shouldFollowActiveFile } from '../../../src/spaces/followActiveFile';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceConfigEntry } from '../../../src/types';
import { assertFixtureWorkspace, fixtureWorkspace, withGlobalSettings, withPaneProviders } from './helpers';

// S4R6：provider 一律綁定單一 pane（scope = paneId＋definition），檢視狀態亦以 paneId 為 key。
// 「標題列命令」在这里验证的是 provider 端可观察效果（filter／preset／根列），
// 命令本身只写 pane 状态（extension.ts 的 setFilterForPane／setPresetForPane）。

suite('follow 與標題列操作 provider 驗證', () => {
  suiteSetup(() => assertFixtureWorkspace());

  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');

  async function withStateProvider<T>(spaces: SpaceConfigEntry[], run: (args: Parameters<Parameters<typeof withPaneProviders>[2]>[0]) => Promise<T>): Promise<T> {
    const first = typeof spaces[0] === 'string' ? spaces[0] : spaces[0]?.path;
    if (!first) throw new Error('withStateProvider 需要至少一個空間作為 pane1 root');
    return withPaneProviders(spaces, [{ paneId: 'pane1', root: first }], run);
  }

  test('follow 開啟時可解析空間內檔案供 TreeView reveal', async () => withGlobalSettings({ spaces: [alpha], followActiveFile: true }, () => withStateProvider([alpha], async ({ provider }) => {
    const filePath = path.join(alpha, 'a.txt');
    const node = await provider('pane1').findNodeByPath(filePath);
    assert.ok(node);
    assert.equal(node.resourceUri?.fsPath, filePath);
    assert.equal(node.contextValue, 'codeFolderSpaces.file');
  })));

  test('follow 關閉時設定保持關閉且不產生選取變化', async () => withGlobalSettings({ spaces: [alpha], followActiveFile: false }, async () => {
    // 自動 follow 的開關由設定控制：關閉時 provider 解析仍可運作，但 extension 的 follow 路徑
    // 會因 enabled=false 而提前 return（見 followActiveFile.shouldFollow），故不會有任何 reveal 副作用。
    assert.equal(vscode.workspace.getConfiguration('codeFolderSpaces').get('followActiveFile', false), false);
    assert.equal(shouldFollowActiveFile({ enabled: false, visible: true, generation: 1, currentGeneration: 1 }), false);
    assert.equal(shouldFollowActiveFile({ enabled: true, visible: true, generation: 1, currentGeneration: 1 }), true);
    assert.equal(shouldFollowActiveFile({ enabled: true, visible: false, generation: 1, currentGeneration: 1 }), false);
    assert.equal(shouldFollowActiveFile({ enabled: true, visible: true, generation: 1, currentGeneration: 2 }), false);
  }));

  test('filter 排除時 findNodeByPath 不返回目標節點', async () => withStateProvider([alpha], async ({ provider, state }) => {
    await state.setFilter('pane1', 'not-a-match');
    assert.equal(await provider('pane1').findNodeByPath(path.join(alpha, 'a.txt')), undefined);
  }));

  test('切換為扁平 preset 後 provider 只呈現檔案節點', async () => withStateProvider([alpha], async ({ provider, state }) => {
    await state.setPreset('pane1', 'Files');
    provider('pane1').refresh();
    const root = (await provider('pane1').getChildren())[0];
    const entries = await provider('pane1').getChildren(root);
    assert.ok(entries.length > 0);
    assert.ok(entries.every(node => node.contextValue === 'codeFolderSpaces.file'));
    assert.ok(entries.some(node => node.description === 'nested/deep.md'));
  }));

  test('根節點展開一層時目錄具可展開狀態', async () => withStateProvider([alpha], async ({ provider }) => {
    const root = (await provider('pane1').getChildren())[0];
    const children = await provider('pane1').getChildren(root);
    const nested = children.find(node => node.label === 'nested');
    assert.ok(nested);
    assert.equal(nested.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.deepEqual((await provider('pane1').getChildren(nested)).map(node => node.label), ['deeper', 'deep.md']);
  }));
});
