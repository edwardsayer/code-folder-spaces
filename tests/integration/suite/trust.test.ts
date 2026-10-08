import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import type { SpaceConfigEntry } from '../../../src/types';
import { clearGlobalSettings } from './helpers';

suite('Workspace Trust 與 SpaceStore 設定範圍', () => {
  let settingsPath: string;
  let originalSettings: Buffer | undefined;

  suiteSetup(() => {
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    assert.ok(workspacePath, '整合測試需開啟 workspace fixture');
    settingsPath = path.join(workspacePath, '.vscode', 'settings.json');
    originalSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : undefined;
    if (originalSettings?.toString('utf8').replace(/\r\n/g, '\n') !== '{}\n') {
      throw new Error(
        'Fixture 已被污染，請執行 git checkout -- tests/integration/fixtures/workspace/.vscode/settings.json 還原後重跑。'
      );
    }
  });

  suiteTeardown(async () => {
    await clearGlobalSettings();
    // 等待 VS Code 設定寫入佇列完成，再以原始位元組做最後還原。
    await new Promise((resolve) => setTimeout(resolve, 100));
    restoreFixtureSettings();
  });

  function restoreFixtureSettings(): void {
    if (originalSettings === undefined) {
      fs.rmSync(settingsPath, { force: true });
    } else {
      // VS Code 會正規化 settings.json 格式；必須以原始位元組還原，才能保持 fixture 乾淨。
      fs.writeFileSync(settingsPath, originalSettings);
    }
  }

  test('測試 harness 為 trusted；restricted 必須以 EDH probe 取證', () => {
    // @vscode/test-electron 的 node_modules/@vscode/test-electron/out/runTest.js 固定傳入
    // --disable-workspace-trust，因此本套件無法覆蓋受限模式；請以 EDH probe 手動取證，見
    // dev/tests/s1-3-s1-4-runtime-evidence.md。此斷言將限制轉成可執行文件化，避免誤以為涵蓋 restricted。
    assert.equal(vscode.workspace.isTrusted, true);
  });

  test('有工作區時 addSpace 與 removeSpace 僅更新 workspaceValue，finally 還原原設定', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const original = config.inspect<SpaceConfigEntry[]>('spaces');
    const originalWorkspace = original?.workspaceValue;
    const originalGlobal = original?.globalValue;
    const tempPath = path.join(os.tmpdir(), `code-folder-spaces-store-${process.pid}-${Date.now()}`);
    const store = new SpaceStore();

    try {
      const added = await store.addSpace(tempPath);
      assert.equal(added, true);
      let current = vscode.workspace.getConfiguration('codeFolderSpaces').inspect<SpaceConfigEntry[]>('spaces');
      assert.deepEqual(current?.workspaceValue, [tempPath]);
      assert.deepEqual(current?.globalValue, originalGlobal);

      const afterAdd = current?.workspaceValue;
      assert.equal(await store.addSpace(tempPath), false);
      current = vscode.workspace.getConfiguration('codeFolderSpaces').inspect<SpaceConfigEntry[]>('spaces');
      assert.deepEqual(current?.workspaceValue, afterAdd, '重複路徑不得改變 workspaceValue');

      assert.equal(await store.removeSpace(tempPath), true);
      current = vscode.workspace.getConfiguration('codeFolderSpaces').inspect<SpaceConfigEntry[]>('spaces');
      assert.deepEqual(current?.workspaceValue, []);
      assert.deepEqual(current?.globalValue, originalGlobal);
    } finally {
      store.dispose();
      try {
        await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces', originalWorkspace, vscode.ConfigurationTarget.Workspace);
        await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces', originalGlobal, vscode.ConfigurationTarget.Global);
      } finally {
        restoreFixtureSettings();
      }
    }
  });
});
