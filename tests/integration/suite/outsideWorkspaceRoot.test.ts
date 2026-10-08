import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { clearGlobalSettings } from './helpers';

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

  test('provider 列出外部根、排序並解析可見路徑', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const original = config.inspect<unknown[]>('spaces');
    const originalWorkspace = original?.workspaceValue;
    const originalGlobal = original?.globalValue;
    const store = new SpaceStore();
    let provider: SpaceTreeDataProvider | undefined;
    try {
      await config.update('spaces', [{ path: tmpRoot, exclude: ['**/*.log'] }], vscode.ConfigurationTarget.Global);
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
      const child = childProcess.spawn(process.execPath, [
        '-e', script, path.join(tmpRoot, outsideName), path.join(workspaceRoot, insideName),
      ], { stdio: 'ignore' });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
      assert.equal(exitCode, 0, 'external writer process must succeed');
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
