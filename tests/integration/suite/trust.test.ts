import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { parseUserGlobalRoots, serializeUserGlobalRoots } from '../../../src/spaces/userGlobalRoots';
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
      // v21-R3：global 以標準 user settings 為正本（scope: application），並鏡像到使用者層級檔案。
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue ?? [], [tempPath]);
      const userGlobalRoots = parseUserGlobalRoots(readFileSync(store.userGlobalRootsPath, 'utf8'));
      assert.deepEqual(userGlobalRoots, [tempPath]);
      assert.equal(store.getDefinitions().find((definition) => definition.basePath === tempPath)?.origin, 'global');
      assert.equal(await store.removeSpace(tempPath), true);
      current = vscode.workspace.getConfiguration('codeFolderSpaces');
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.workspace')?.workspaceValue, []);
      assert.deepEqual(current.inspect<SpaceConfigEntry[]>('spaces.global')?.globalValue ?? [], []);
      assert.deepEqual(parseUserGlobalRoots(readFileSync(store.userGlobalRootsPath, 'utf8')), []);
    } finally {
      store.dispose();
      try {
        // v21-R2：global 存使用者層級檔案；測試結束一律清空，避免殘留污染後續案例。
        try { fs.writeFileSync(store.userGlobalRootsPath, serializeUserGlobalRoots([])); } catch { /* 檔案可能尚未建立 */ }
        await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.workspace', originalWorkspace, vscode.ConfigurationTarget.Workspace);
        await vscode.workspace.getConfiguration('codeFolderSpaces').update('spaces.global', originalGlobal, vscode.ConfigurationTarget.Global);
      } finally { restoreFixtureSettings(); }
    }
  });
});
