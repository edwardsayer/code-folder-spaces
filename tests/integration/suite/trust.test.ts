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
    const initialContent = originalSettings?.toString('utf8').replace(/\r\n/g, '\n');
    const isPristine = initialContent === undefined || /^\{\s*\}\s*$/.test(initialContent);
    if (!isPristine) throw new Error('Fixture 已被污染，請先還原 tests/integration/fixtures/workspace/.vscode/settings.json。');
  });

  suiteTeardown(async () => {
    await clearGlobalSettings();
    await new Promise(resolve => setTimeout(resolve, 100));
    restoreFixtureSettings();
  });

  function restoreFixtureSettings(): void {
    if (originalSettings === undefined) fs.rmSync(settingsPath, { force: true });
    else fs.writeFileSync(settingsPath, originalSettings);
  }

  test('測試 harness 為 trusted；restricted 必須以 EDH probe 取證', () => {
    assert.equal(vscode.workspace.isTrusted, true);
  });

  test('有工作區時 addSpace 寫入 workspace 層，markAsGlobal 搬移至 global 層', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const originalWorkspace = config.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue;
    const originalGlobal = config.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue;
    const tempPath = path.join(os.tmpdir(), `code-folder-spaces-store-${process.pid}-${Date.now()}`);
    const store = new SpaceStore();

    try {
      assert.equal(await store.addSpace(tempPath), true);
      let current = vscode.workspace.getConfiguration('codeFolderSpaces');
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue, [tempPath]);
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue, originalGlobal);
      assert.equal(await store.addSpace(tempPath), false);
      current = vscode.workspace.getConfiguration('codeFolderSpaces');
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue, [tempPath], '重複路徑不得改變 workspaceValue');

      assert.equal(await store.markAsGlobal(tempPath), true);
      current = vscode.workspace.getConfiguration('codeFolderSpaces');
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue, []);
      // v21-R4：global 只存標準 user settings（scope: application），沒有自訂鏡像檔。
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue ?? [], [tempPath]);
      assert.equal(store.getDefinitions().find((definition) => definition.basePath === tempPath)?.origin, 'global');
      assert.equal(await store.removeSpace(tempPath), true);
      current = vscode.workspace.getConfiguration('codeFolderSpaces');
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue, []);
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue ?? [], []);
    } finally {
      store.dispose();
      try {
        await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.workspace', originalWorkspace, vscode.ConfigurationTarget.Workspace);
        await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.global', originalGlobal, vscode.ConfigurationTarget.Global);
      } finally { restoreFixtureSettings(); }
    }
  });

  test('unmarkGlobal 寫回「非 global」位置：單一資料夾 → 專案 .vscode/settings.json', async () => {
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const originalWorkspace = config.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue;
    const originalGlobal = config.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue;
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-unmark-'));
    const store = new SpaceStore();
    try {
      assert.equal(await store.addSpace(tempPath), true);
      assert.equal(await store.markAsGlobal(tempPath), true);
      assert.deepEqual(vscode.workspace.getConfiguration('codeFolderSpaces').inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue ?? [], [tempPath]);
      // v21-R6：Unmark 應寫回 workspace 層（單一資料夾＝專案 .vscode/settings.json；
      // .code-workspace 環境則寫入 workspace 設定檔，同一個 ConfigurationTarget.Workspace）。
      assert.equal(await store.unmarkGlobal(tempPath), true);
      const workspaceValue = vscode.workspace.getConfiguration('codeFolderSpaces').inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue;
      assert.deepEqual(workspaceValue ?? [], [tempPath]);
      assert.deepEqual(vscode.workspace.getConfiguration('codeFolderSpaces').inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue ?? [], []);
      // 檔案層證據：單一資料夾專案的 settings.json 真的被寫入。
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(folder, '整合 harness 應開啟單一資料夾');
      const settingsFile = path.join(folder!, '.vscode', 'settings.json');
      assert.ok(fs.existsSync(settingsFile), '專案 .vscode/settings.json 應存在');
      assert.ok(fs.readFileSync(settingsFile, 'utf8').includes('spaces.workspace'), '專案 settings 應含 spaces.workspace');
    } finally {
      store.dispose();
      fs.rmSync(tempPath, { recursive: true, force: true });
      await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.workspace', originalWorkspace, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.global', originalGlobal, vscode.ConfigurationTarget.Global);
    }
  });
});
