import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { UndoStack } from '../../../src/spaces/spaceActions';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import type { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { clearGlobalSettings, createPaneProvider, createPaneStateHarness, seedPaneFromRoot, syncPaneScope } from './helpers';

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

  suiteTeardown(async () => {
    await clearGlobalSettings();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('暫存空間根 CRUD 冒煙與衝突／缺失錯誤不破壞原狀態', async () => {
    const root = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-crud-')));
    const folder = vscode.Uri.joinPath(root, 'created');
    const file = vscode.Uri.joinPath(folder, 'note.txt');
    try {
      await vscode.workspace.fs.createDirectory(folder);
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('original'));
      assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), 'original');
      const occupied = vscode.Uri.joinPath(root, 'occupied');
      await vscode.workspace.fs.createDirectory(occupied);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(occupied, 'note.txt'), new TextEncoder().encode('occupied'));
      await assert.rejects(() => Promise.resolve(vscode.workspace.fs.rename(file, vscode.Uri.joinPath(occupied, 'note.txt'), { overwrite: false })));
      assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), 'original');
      await assert.rejects(() => Promise.resolve(vscode.workspace.fs.rename(vscode.Uri.joinPath(root, 'missing'), file, { overwrite: false })));
      await assert.rejects(() => Promise.resolve(vscode.workspace.fs.rename(folder, vscode.Uri.joinPath(folder, 'child'), { overwrite: false })));
      const undo = new UndoStack();
      const moved = vscode.Uri.joinPath(occupied, 'created');
      await vscode.workspace.fs.rename(folder, moved, { overwrite: false });
      undo.push({ kind: 'move', from: folder.fsPath, to: moved.fsPath });
      const operation = undo.peek();
      assert.ok(operation);
      await vscode.workspace.fs.rename(vscode.Uri.file(operation.to), vscode.Uri.file(operation.from), { overwrite: false });
      undo.pop();
      assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), 'original');
      const renamed = vscode.Uri.joinPath(folder, 'renamed.txt');
      await vscode.workspace.fs.rename(file, renamed, { overwrite: false });
      assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(renamed)), 'original');
      await vscode.workspace.fs.delete(renamed, { useTrash: false });
      await vscode.workspace.fs.delete(occupied, { recursive: true, useTrash: false });
      await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
      await assert.rejects(() => Promise.resolve(vscode.workspace.fs.stat(renamed)));
    } finally {
      await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }).then(() => undefined, () => undefined);
    }
  });

  test('provider 列出外部根、排序並解析可見路徑', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const originalWorkspace = config.inspect<unknown[]>('spaces.workspace')?.workspaceValue;
    const originalGlobal = config.inspect<unknown[]>('spaces.global')?.globalValue;
    const store = new SpaceStore();
    let provider: SpaceTreeDataProvider | undefined;
    try {
      await config.update('spaces.global', [{ path: tmpRoot, exclude: ['**/*.log'] }], vscode.ConfigurationTarget.Global);
      // S4R6：工作區外的任意資料夾可直接作為 pane root（D69：不要求命中 spaces）；
      // 本例以 space 設定提供顯示預設值，pane 建立時複製之（D70）。
      const { state } = createPaneStateHarness();
      await seedPaneFromRoot(store, state, 'pane1', tmpRoot);
      provider = createPaneProvider(store, state, 'pane1');
      const children = await provider.getChildren() as SpaceNode[];
      assert.ok(children.every(node => node.contextValue !== 'codeFolderSpaces.spaceRoot'));
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
      // pane 自行換根（仍是工作區外的任意資料夾）：不依賴 spaces 設定。
      await state.switchRoot('pane1', path.join(tmpRoot, 'sub'));
      syncPaneScope(store, state, provider, 'pane1');
      assert.deepEqual((await provider.getChildren() as SpaceNode[]).map(node => node.label), ['deep.md']);
    } finally {
      provider?.dispose();
      store.dispose();
      // v21-R4：spaces.global 宣告 scope: application，只能寫 User settings；此處原本誤用 Workspace
      // target（restore 也抄錯 key），會直接拋錯並讓案例失敗。
      await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.workspace', originalWorkspace, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.global', originalGlobal, vscode.ConfigurationTarget.Global);
    }
  });

  test('工作區外 root 的 FileSystemWatcher 事件', async () => {
    // FileSystemWatcher 的通知時序受 OS／檔案系統影響；測試同時使用工作區內對照組，最多等待 20 秒。
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'integration harness workspace is required');
    const outsideName = `watcher-outside-${Date.now()}.txt`;
    const insideName = `watcher-inside-${Date.now()}.txt`;
    const outsideWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(tmpRoot, outsideName));
    const insideWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, insideName));
    const observed = new Set<string>();
    const subscriptions = [
      outsideWatcher.onDidCreate(() => observed.add('outside')),
      insideWatcher.onDidCreate(() => observed.add('inside')),
    ];
    const startedAt = Date.now();
    try {
      const script = 'const fs = require("node:fs"); for (const p of process.argv.slice(1)) fs.writeFileSync(p, "watcher diagnostic");';
      // 在 Extension Host 裡 `process.execPath` 指向 Electron 執行檔，不是 node。
      // 舊版 VS Code（實測 1.85.1）下直接 spawn 它會被 signal 終止（exit code -1），
      // 導致本測試以「外部寫入者」失敗而非真正的 watcher 問題；新版本則恰好能跑。
      // 用 ELECTRON_RUN_AS_NODE=1 讓同一個執行檔以 Node 模式執行，跨版本一致。
      const child = childProcess.spawn(process.execPath, [
        '-e', script, path.join(tmpRoot, outsideName), path.join(workspaceRoot, insideName),
      ], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (signal) console.error(`[watcher diagnostic] child terminated by signal ${signal}`);
          resolve(code ?? -1);
        });
      });
      assert.equal(exitCode, 0, `external writer process must succeed (exit=${exitCode})`);
      while (Date.now() - startedAt < 20_000 && observed.size < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const diagnostic = {
        label: 'S1-10 watcher diagnostic',
        platform: process.platform,
        node: process.version,
        vscode: vscode.version,
        externalProcessExitCode: exitCode,
        waitMilliseconds: Date.now() - startedAt,
        observed: [...observed].sort(),
        outsidePath: path.join(tmpRoot, outsideName),
        insidePath: path.join(workspaceRoot, insideName),
      };
      console.log(`S1-10-DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
      assert.deepEqual([...observed].sort(), ['inside', 'outside']);
    } finally {
      subscriptions.forEach((subscription) => subscription.dispose());
      outsideWatcher.dispose();
      insideWatcher.dispose();
      fs.rmSync(path.join(tmpRoot, outsideName), { force: true });
      fs.rmSync(path.join(workspaceRoot, insideName), { force: true });
    }
  });
});

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
