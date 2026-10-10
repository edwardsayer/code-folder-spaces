import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceEntryNode, SpaceRootNode, SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { PaneStateStore } from '../../../src/spaces/viewState';
import { assertFixtureWorkspace, clearGlobalSettings, fixtureWorkspace, withGlobalSettings } from './helpers';

// F-42 檔案嵌套整合測試（驗收矩陣 FN-I1～FN-I6，見 dev/specs/file-nesting-design.md §7）。
// 與 spaceTree.test.ts 相同，直接建構 provider，透過真實 VS Code 設定驗證列舉語意；
// explorer.fileNesting.* 一律寫入 Global 並在 finally 逐項還原，不留殘值。

type Node = SpaceNode;

interface ExplorerNestingValues {
  enabled?: boolean;
  expand?: boolean;
  patterns?: Record<string, string>;
}

/** 僅改 explorer.fileNesting.* Global 設定，完成後逐項還原原值。 */
async function withExplorerNesting<T>(values: ExplorerNestingValues, run: () => Promise<T>): Promise<T> {
  const config = vscode.workspace.getConfiguration('explorer');
  const previous = {
    enabled: config.inspect<boolean>('fileNesting.enabled')?.globalValue,
    expand: config.inspect<boolean>('fileNesting.expand')?.globalValue,
    patterns: config.inspect<Record<string, string>>('fileNesting.patterns')?.globalValue,
  };
  try {
    if (values.enabled !== undefined) await config.update('fileNesting.enabled', values.enabled, vscode.ConfigurationTarget.Global);
    if (values.expand !== undefined) await config.update('fileNesting.expand', values.expand, vscode.ConfigurationTarget.Global);
    if (values.patterns !== undefined) await config.update('fileNesting.patterns', values.patterns, vscode.ConfigurationTarget.Global);
    return await run();
  } finally {
    await config.update('fileNesting.enabled', previous.enabled, vscode.ConfigurationTarget.Global);
    await config.update('fileNesting.expand', previous.expand, vscode.ConfigurationTarget.Global);
    await config.update('fileNesting.patterns', previous.patterns, vscode.ConfigurationTarget.Global);
  }
}

async function clearExplorerNestingSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('explorer');
  await config.update('fileNesting.enabled', undefined, vscode.ConfigurationTarget.Global);
  await config.update('fileNesting.expand', undefined, vscode.ConfigurationTarget.Global);
  await config.update('fileNesting.patterns', undefined, vscode.ConfigurationTarget.Global);
}

async function withNestingProvider<T>(run: (provider: SpaceTreeDataProvider) => Promise<T>, state?: PaneStateStore): Promise<T> {
  const store = new SpaceStore();
  const provider = new SpaceTreeDataProvider(store, state);
  try {
    return await run(provider);
  } finally {
    provider.dispose();
    store.dispose();
  }
}

const TS_PATTERN = { '*.ts': '${capture}.js, ${capture}.d.ts, ${capture}.js.map' } as const;

suite('檔案嵌套 provider 驗證（F-42）', () => {
  const nesting = path.join(fixtureWorkspace, 'spaces/nesting');

  suiteSetup(() => assertFixtureWorkspace());
  suiteTeardown(async () => {
    await clearExplorerNestingSettings();
    await clearGlobalSettings();
  });

  test('FN-I1 啟用後父列可折疊、子項自同層移除、展開後出現', async () => withGlobalSettings({ spaces: [nesting] }, () => withExplorerNesting({ enabled: true, patterns: TS_PATTERN }, async () => {
    const store = new SpaceStore();
    const provider = new SpaceTreeDataProvider(store);
    try {
      const root = (await provider.getChildren())[0];
      const children = await provider.getChildren(root) as Node[];
      // 巢狀子項不與同層平鋪；父列與無關檔案保留。
      assert.deepEqual(children.map(node => node.label), ['app.ts', 'notes.md', 'orphan.js']);
      const parent = children[0] as SpaceEntryNode;
      assert.ok(parent instanceof SpaceEntryNode && !parent.isDirectory);
      // D56：Expanded（expand 預設 true）、file 圖示、保留開啟命令與原生裝飾 resourceUri。
      assert.equal(parent.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      assert.equal((parent.iconPath as vscode.ThemeIcon).id, 'file');
      assert.equal(parent.command?.command, 'codeFolderSpaces.openEntry');
      assert.equal(parent.resourceUri?.fsPath, path.join(nesting, 'app.ts'));
      assert.equal(parent.contextValue, 'codeFolderSpaces.file');

      const nested = await provider.getChildren(parent) as Node[];
      assert.deepEqual(nested.map(node => node.label), ['app.d.ts', 'app.js', 'app.js.map']);
      assert.ok(nested.every(node => node instanceof SpaceEntryNode && !node.isDirectory));
      assert.ok(nested.every(node => (node as SpaceEntryNode).parent === parent));
      assert.ok(nested.every(node => node.collapsibleState === vscode.TreeItemCollapsibleState.None));
      // id 不重複（D54 單一父項的直接好處）。
      const ids = [parent, ...nested].map(node => node.id);
      assert.equal(new Set(ids).size, ids.length);
    } finally { provider.dispose(); store.dispose(); }
  })));

  test('FN-I2 enabled=false 時完全平鋪（與 F-42 前一致）', async () => withGlobalSettings({ spaces: [nesting] }, () => withExplorerNesting({ enabled: false, patterns: TS_PATTERN }, async () => {
    await withNestingProvider(async (provider) => {
      const root = (await provider.getChildren())[0];
      const children = await provider.getChildren(root) as Node[];
      assert.deepEqual(children.map(node => node.label), ['app.d.ts', 'app.js', 'app.js.map', 'app.ts', 'notes.md', 'orphan.js']);
      assert.ok(children.every(node => node.collapsibleState === vscode.TreeItemCollapsibleState.None));
      assert.ok(children.every(node => (node as SpaceEntryNode).nestedChildren.length === 0));
    });
  })));

  test('FN-I3 expand=false 時父列預設收合', async () => withGlobalSettings({ spaces: [nesting] }, () => withExplorerNesting({ enabled: true, expand: false, patterns: TS_PATTERN }, async () => {
    await withNestingProvider(async (provider) => {
      const root = (await provider.getChildren())[0];
      const children = await provider.getChildren(root) as Node[];
      const parent = children.find(node => node.label === 'app.ts')!;
      assert.equal(parent.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      // 收合不影響子項列舉（twisty 展開時仍取到巢狀層）。
      assert.deepEqual((await provider.getChildren(parent) as Node[]).map(node => node.label), ['app.d.ts', 'app.js', 'app.js.map']);
    });
  })));

  test('FN-I4 findNodeByPath 對嵌套子檔回傳同層父檔連結，reveal 父鏈正確', async () => withGlobalSettings({ spaces: [nesting] }, () => withExplorerNesting({ enabled: true, patterns: TS_PATTERN }, async () => {
    await withNestingProvider(async (provider) => {
      const node = await provider.findNodeByPath(path.join(nesting, 'app.js')) as Node | undefined;
      assert.ok(node);
      assert.equal(node.label, 'app.js');
      assert.equal(node.contextValue, 'codeFolderSpaces.file');
      // getParent 鏈：app.js → 同層父檔 app.ts → 空間根（而非直接掛在根下）。
      const parent = provider.getParent(node);
      assert.ok(parent instanceof SpaceEntryNode && !parent.isDirectory);
      assert.equal(parent.label, 'app.ts');
      assert.ok(parent.parent instanceof SpaceRootNode);
      // reveal 需要能從父列列舉到子列（getChildren 對檔案列回傳 nestedChildren）。
      assert.ok((await provider.getChildren(parent) as Node[]).some(child => child.id === node.id), 'reveal 父列必須能列舉出嵌套子列');
      // 非嵌套檔案維持原父鏈。
      const flat = await provider.findNodeByPath(path.join(nesting, 'notes.md')) as Node | undefined;
      assert.ok(flat);
      assert.ok(flat.parent instanceof SpaceRootNode);
    });
  })));

  test('FN-I5 過濾啟用時停用嵌套（D55），檔案平鋪', async () => withGlobalSettings({ spaces: [nesting] }, () => withExplorerNesting({ enabled: true, patterns: TS_PATTERN }, async () => {
    const values = new Map<string, unknown>();
    const state = new PaneStateStore({ get: key => values.get(key) as never, update: async (key, value) => { values.set(key, value); } });
    await state.setFilter(nesting, 'app');
    await withNestingProvider(async (provider) => {
      const root = (await provider.getChildren())[0];
      const children = await provider.getChildren(root) as Node[];
      // 若嵌套仍啟用，app.js 等不會出現在同層；此處應以平鋪方式通過過濾。
      assert.deepEqual(children.map(node => node.label), ['app.d.ts', 'app.js', 'app.js.map', 'app.ts']);
      assert.ok(children.every(node => node.collapsibleState === vscode.TreeItemCollapsibleState.None));
    }, state);
  })));

  test('FN-I6 explorer.fileNesting 變更觸發設定事件且重新列舉採用新 patterns', async () => {
    // extension.ts 的 onDidChangeConfiguration 以 affectsConfiguration('explorer.fileNesting')
    // 為條件呼叫 scheduleRefresh；此處驗證同一觸發條件成立，並驗證 provider 於列舉時
    // 重新讀取 patterns（refresh 清記憶化後樹形隨新設定改變）。
    let sawNestingEvent = false;
    const listener = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('explorer.fileNesting')) sawNestingEvent = true;
    });
    try {
      await withGlobalSettings({ spaces: [nesting] }, async () => {
        await withExplorerNesting({ enabled: true, patterns: TS_PATTERN }, async () => {
          const store = new SpaceStore();
          const provider = new SpaceTreeDataProvider(store);
          try {
            const root = (await provider.getChildren())[0];
            const before = await provider.getChildren(root) as Node[];
            assert.deepEqual(before.map(node => node.label), ['app.ts', 'notes.md', 'orphan.js']);

            // 注意：`explorer.fileNesting.patterns` 的 Global 值會與內建預設 patterns 合併，
            // 未覆寫的預設 key（例：`*.js`）仍會生效。因此本案例同時明確覆寫 `*.ts` 與 `*.js`，
            // 使期望不受 VS Code 內建預設值影響（`*.ts` 預設為 `${capture}.js`）。
            await vscode.workspace.getConfiguration('explorer').update('fileNesting.patterns', { '*.ts': '${capture}.js', '*.js': '${capture}.js.map' }, vscode.ConfigurationTarget.Global);
            assert.equal(sawNestingEvent, true, 'explorer.fileNesting.patterns 變更應觸發 affectsConfiguration 條件');
            provider.refresh();

            const after = await provider.getChildren(root) as Node[];
            // 新 patterns：app.ts 收 app.js（遞迴），app.js 再收 app.js.map；app.d.ts 回到同層。
            assert.deepEqual(after.map(node => node.label), ['app.d.ts', 'app.ts', 'notes.md', 'orphan.js']);
            const tsParent = after.find(node => node.label === 'app.ts')!;
            const jsChild = (await provider.getChildren(tsParent) as Node[])[0];
            assert.equal(jsChild.label, 'app.js');
            assert.deepEqual((await provider.getChildren(jsChild) as Node[]).map(node => node.label), ['app.js.map']);
          } finally { provider.dispose(); store.dispose(); }
        });
      });
    } finally {
      listener.dispose();
      await clearExplorerNestingSettings();
    }
  });
});
