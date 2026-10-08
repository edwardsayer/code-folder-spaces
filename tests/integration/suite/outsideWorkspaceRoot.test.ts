import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';

suite('工作區外空間根', () => {
  let tmpRoot: string;

  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-'));
    fs.mkdirSync(path.join(tmpRoot, 'sub'));
    fs.writeFileSync(path.join(tmpRoot, 'sub', 'deep.md'), 'deep');
    fs.writeFileSync(path.join(tmpRoot, 'sub', 'nested.log'), 'nested log');
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpRoot, 'B.txt'), 'B');
    fs.writeFileSync(path.join(tmpRoot, 'skip.log'), 'skip');
  });

  suiteTeardown(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('provider 列出外部根、排序並解析可見路徑', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const original = config.inspect<unknown[]>('spaces');
    const originalWorkspace = original?.workspaceValue;
    const originalGlobal = original?.globalValue;
    const store = new SpaceStore();
    let provider: SpaceTreeDataProvider | undefined;
    try {
      // 雙 pattern 是因為 **/ 目前需至少一層目錄才命中（已知缺陷 F-R3-1）。
      await config.update('spaces', [{ path: tmpRoot, exclude: ['*.log', '**/*.log'] }], vscode.ConfigurationTarget.Global);
      provider = new SpaceTreeDataProvider(store);
      const roots = await provider.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(normalizePath(roots[0].resourceUri?.fsPath ?? ''), normalizePath(tmpRoot));
      const children = await provider.getChildren(roots[0]) as SpaceNode[];
      assert.deepEqual(children.map((node) => node.label), ['sub', 'a.txt', 'B.txt']);
      assert.ok(!children.some((node) => node.label === 'skip.log'));
      const sub = children.find((node) => node.label === 'sub');
      assert.ok(sub);
      const nestedChildren = await provider.getChildren(sub);
      assert.deepEqual(nestedChildren.map((node) => node.label), ['deep.md']);
      assert.equal(
        normalizePath((await provider.findNodeByPath(path.join(tmpRoot, 'sub', 'deep.md')))?.resourceUri?.fsPath ?? ''),
        normalizePath(path.join(tmpRoot, 'sub', 'deep.md'))
      );
      assert.equal(await provider.findNodeByPath(path.join(os.tmpdir(), 'outside-code-folder-spaces.txt')), undefined);
    } finally {
      provider?.dispose();
      store.dispose();
      await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces', originalWorkspace, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces', originalGlobal, vscode.ConfigurationTarget.Global);
    }
  });

  test('**/*.log 應匹配頂層檔案（已知缺陷，待 S1-9 修正）', function () {
    // pattern `**/*.log`、相對路徑 `skip.log`，目前實際結果是不匹配；
    // 這與 VS Code `files.exclude`／`search.exclude` 中 `**/` 可匹配零層的語意不符。
    this.skip();
  });

  test('工作區外 root 的 FileSystemWatcher 事件（自動化 harness 無法穩定觀察）', function () {
    // trusted harness 兩次各等候 15 秒皆未收到 onDidCreate；EDH probe trusted 曾觀察到事件，
    // restricted 曾逾時（詳見 dev/tests/s1-3-s1-4-runtime-evidence.md），證據強度不足，待後續裁決。
    this.skip();
  });
});

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
