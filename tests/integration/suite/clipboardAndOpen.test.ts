import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('剪貼簿與檔案開啟位置', () => {
  test('cut→paste 與 undo、copy→paste 可操作暫存檔案', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-clipboard-'));
    const sourceDir = path.join(root, 'source');
    const destinationDir = path.join(root, 'destination');
    await fs.mkdir(sourceDir); await fs.mkdir(destinationDir);
    const sourcePath = path.join(sourceDir, 'item.txt');
    await fs.writeFile(sourcePath, 'clipboard test');
    const space = { basePath: root };
    const source = { uri: vscode.Uri.file(sourcePath), space, isDirectory: false };
    const destination = { uri: vscode.Uri.file(destinationDir), space, isDirectory: true };
    try {
      await vscode.commands.executeCommand('codeFolderSpaces.cutEntry', source);
      await vscode.commands.executeCommand('codeFolderSpaces.pasteEntries', destination);
      const movedPath = path.join(destinationDir, 'item.txt');
      assert.equal(await fs.readFile(movedPath, 'utf8'), 'clipboard test');
      await vscode.commands.executeCommand('codeFolderSpaces.undoFileOperation');
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'clipboard test');
      await vscode.commands.executeCommand('codeFolderSpaces.copyEntry', source);
      await vscode.commands.executeCommand('codeFolderSpaces.pasteEntries', destination);
      assert.equal(await fs.readFile(movedPath, 'utf8'), 'clipboard test');
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'clipboard test');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test('openFilesIn current/beside selects the corresponding editor group', async () => {
    const setting = vscode.workspace.getConfiguration('codeFolderSpaces');
    const previous = setting.inspect<string>('openFilesIn');
    const target = vscode.ConfigurationTarget.Workspace;
    const tempPath = path.join(os.tmpdir(), `folder-spaces-open-${Date.now()}.txt`);
    await fs.writeFile(tempPath, 'open location');
    try {
      await setting.update('openFilesIn', 'current', target);
      const currentColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
      await vscode.commands.executeCommand('codeFolderSpaces.openEntry', vscode.Uri.file(tempPath));
      assert.ok(vscode.window.activeTextEditor, 'current editor should be active after opening');
      assert.equal(vscode.window.activeTextEditor.viewColumn, currentColumn);
      await setting.update('openFilesIn', 'beside', target);
      await vscode.commands.executeCommand('codeFolderSpaces.openEntry', vscode.Uri.file(tempPath));
      assert.ok(vscode.window.activeTextEditor, 'beside editor should be active after opening');
      assert.ok(vscode.window.activeTextEditor.viewColumn !== currentColumn);
    } finally {
      await setting.update('openFilesIn', previous?.workspaceValue ?? previous?.globalValue ?? 'current', target);
      await fs.rm(tempPath, { force: true });
    }
  });
});
