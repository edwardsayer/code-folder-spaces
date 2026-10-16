import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import type { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { clearGlobalSettings, createPaneProvider, createPaneStateHarness, paneRootNode, seedPane } from './helpers';

suite('S1-5 大型目錄量測', () => {
  let tmpRoot: string;

  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-s1-5-'));
    for (let index = 0; index < 1500; index += 1) {
      const directory = path.join(tmpRoot, `directory-${String(index).padStart(4, '0')}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'child.txt'), 'child');
    }
    for (let index = 0; index < 3000; index += 1) {
      fs.writeFileSync(path.join(tmpRoot, `file-${String(index).padStart(4, '0')}.txt`), 'file');
    }
    const deepDirectory = path.join(tmpRoot, 'deep', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten');
    fs.mkdirSync(deepDirectory, { recursive: true });
    fs.writeFileSync(path.join(deepDirectory, 'target.txt'), 'target');
  });

  suiteTeardown(async () => {
    await clearGlobalSettings();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('量測大型樹的根列舉、單層子目錄展開及深度路徑解析', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const previous = config.inspect<unknown[]>('spaces');
    const store = new SpaceStore();
    let provider: SpaceTreeDataProvider | undefined;
    try {
      await config.update('spaces', [{ path: tmpRoot }], vscode.ConfigurationTarget.Global);
      // S4R6：provider 綁定單一 pane，scope 由 pane 狀態＋空間定義解析。
      const { state: viewState } = createPaneStateHarness();
      await seedPane(viewState, 'pane1', { root: tmpRoot });
      provider = createPaneProvider(store, viewState, 'pane1');
      const root = paneRootNode(provider);
      const deepPath = path.join(tmpRoot, 'deep', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'target.txt');
      await provider.getChildren(root); // warm-up
      await provider.getChildren(root);
      const samples: Record<string, number[]> = { rootMilliseconds: [], expansionMilliseconds: [], findPathMilliseconds: [] };
      for (let iteration = 0; iteration < 3; iteration += 1) {
        let started = performance.now();
        const rootChildren = await provider.getChildren() as SpaceNode[];
        samples.rootMilliseconds.push(performance.now() - started);
        assert.equal(rootChildren.length, 4501);
        assert.ok(rootChildren.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));

        started = performance.now();
        const children = await provider.getChildren(root) as SpaceNode[];
        samples.expansionMilliseconds.push(performance.now() - started);
        assert.equal(children.length, 4501);

        started = performance.now();
        const target = await provider.findNodeByPath(deepPath);
        samples.findPathMilliseconds.push(performance.now() - started);
        assert.ok(target);
      }
      await viewState.setSort('pane1', 'mtime', 'asc');
      provider.refresh();
      const statSortMilliseconds: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const started = performance.now();
        assert.equal((await provider.getChildren(root)).length, 4501);
        statSortMilliseconds.push(performance.now() - started);
        provider.refresh();
      }
      const medians = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, [...values].sort((a, b) => a - b)[1]]));
      const statSortMedianMilliseconds = [...statSortMilliseconds].sort((a, b) => a - b)[1];
      console.log(`S1-5-MEASUREMENT ${JSON.stringify({ phase: process.env.S1_5_PHASE ?? 'unspecified', platform: process.platform, node: process.version, vscode: vscode.version, localFileSystem: 'Node fs temporary directory + vscode.workspace.fs provider', directoryCount: 1500, filesPerDirectory: 1, topLevelFiles: 3000, depth: 11, samples, medians, statSortMilliseconds, statSortMedianMilliseconds })}`);
    } finally {
      provider?.dispose();
      store.dispose();
      await config.update('spaces', previous?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await config.update('spaces', previous?.globalValue, vscode.ConfigurationTarget.Global);
    }
  });
});
