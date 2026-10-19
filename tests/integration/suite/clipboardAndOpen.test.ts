import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceClipboard, UndoStack, isAllowedSpaceRoot, isSafeMove, resolvePasteTarget, uniqueEntryName } from '../../../src/spaces/spaceActions';
import { copyTreeEntry } from '../../../src/spaces/treeDragAndDrop';

// S4R6 改寫說明（見回報的 finding）：v2 的 `codeFolderSpaces.cutEntry／copyEntry／pasteEntries`
// 命令端只接受 `SpaceRootNode`／`SpaceEntryNode` **實例**（extension.ts 的 `nodeInfo` 走 instanceof），
// v1 的 duck-typed `{ uri, space, isDirectory }` 參數分支已被移除。整合測試的 test bundle 與
// dist/extension.js 是兩份模組實體，跨 bundle 的 instanceof 必然失敗，因此「由測試自造節點驅動命令」
// 這條路在 v2 不再可行；命令接線需改由 Extension Development Host 實機取證。
// 本檔改為在真實磁碟上驗證產品匯出的同一組剪貼簿／搬移語意模組（SpaceClipboard、UndoStack、
// copyTreeEntry 與 D67 允許根守門），不再重現命令註冊本身。

suite('剪貼簿與檔案開啟位置', () => {
  test('cut→paste 與 undo、copy→paste 在 pane root 內操作暫存檔案', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-clipboard-'));
    const sourceDir = path.join(root, 'source');
    const destinationDir = path.join(root, 'destination');
    await fs.mkdir(sourceDir); await fs.mkdir(destinationDir);
    const sourcePath = path.join(sourceDir, 'item.txt');
    await fs.writeFile(sourcePath, 'clipboard test');
    // S4R6-D67：允許根是 pane 自己的 root（此處 pane root = 暫存根）。
    const paneRoot = root;
    const clipboard = new SpaceClipboard();
    const undoStack = new UndoStack();

    // 貼上目標解析與守門：資料夾目標原樣、檔案目標解析到父目錄、pane root 外一律拒絕。
    assert.equal(resolvePasteTarget({ path: destinationDir, isDirectory: true }), destinationDir);
    assert.equal(resolvePasteTarget({ path: sourcePath, isDirectory: false }), sourceDir);
    assert.equal(isAllowedSpaceRoot(paneRoot, destinationDir), true);
    assert.equal(isAllowedSpaceRoot(paneRoot, path.join(os.tmpdir(), 'elsewhere.txt')), false);

    const pasteInto = async (directory: string): Promise<void> => {
      const payload = clipboard.get();
      assert.ok(payload, '剪貼簿必須有內容');
      const destinationPath = resolvePasteTarget({ path: directory, isDirectory: true });
      assert.ok(destinationPath);
      assert.ok(isAllowedSpaceRoot(paneRoot, destinationPath), '貼上目標必須位於 pane root 內');
      const destination = vscode.Uri.file(destinationPath);
      for (const entry of payload.uris) {
        const source = vscode.Uri.parse(entry);
        const stat = await vscode.workspace.fs.stat(source);
        const name = path.basename(source.fsPath);
        const candidate = path.join(destination.fsPath, name);
        assert.ok(isSafeMove(source.fsPath, candidate, Boolean(stat.type & vscode.FileType.Directory)));
        const target = vscode.Uri.joinPath(destination, name);
        if (payload.mode === 'cut') {
          await vscode.workspace.fs.rename(source, target, { overwrite: false });
          undoStack.push({ kind: 'move', from: source.fsPath, to: target.fsPath });
          clipboard.consume(entry);
        } else {
          await copyTreeEntry(source, target);
        }
      }
    };

    try {
      // cut → paste：內容搬移、cut 條目被消耗、undo 可還原。
      clipboard.set([vscode.Uri.file(sourcePath).toString()], 'cut');
      await pasteInto(destinationDir);
      const movedPath = path.join(destinationDir, 'item.txt');
      assert.equal(await fs.readFile(movedPath, 'utf8'), 'clipboard test');
      assert.equal(clipboard.get(), undefined, 'cut 條目在成功搬移後必須被消耗');
      const undo = undoStack.pop();
      assert.ok(undo);
      assert.equal(pathKey(undo.to), pathKey(movedPath));
      assert.equal(pathKey(undo.from), pathKey(sourcePath));
      await vscode.workspace.fs.rename(vscode.Uri.file(undo.to), vscode.Uri.file(undo.from), { overwrite: false });
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'clipboard test');

      // copy → paste：來源保留且剪貼簿維持 copy 模式（可重複貼上）。
      clipboard.set([vscode.Uri.file(sourcePath).toString()], 'copy');
      await pasteInto(destinationDir);
      assert.equal(await fs.readFile(movedPath, 'utf8'), 'clipboard test');
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'clipboard test');
      assert.equal(clipboard.get()?.mode, 'copy', 'copy 不因貼上而被消耗');

      // 同名目標：產品使用 uniqueEntryName 產生不覆寫的唯一檔名。
      assert.equal(uniqueEntryName('item.txt', occupied => occupied === 'item.txt'), 'item 1.txt');
      await copyTreeEntry(vscode.Uri.file(sourcePath), vscode.Uri.joinPath(vscode.Uri.file(destinationDir), 'item 1.txt'));
      assert.equal(await fs.readFile(path.join(destinationDir, 'item 1.txt'), 'utf8'), 'clipboard test');
      assert.deepEqual((await fs.readdir(destinationDir)).sort(), ['item 1.txt', 'item.txt']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test('命令面 v2 契約：非 pane 節點參數為 no-op，不改動磁碟', async () => {
    // v2 的 cutEntry/copyEntry/pasteEntries 只接受 `SpaceRootNode`／`SpaceEntryNode` 實例；
    // 舊 v1 的 duck-typed `{ uri, space, isDirectory }` 不再是有效參數。本案例將此契約固定下來。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-clipboard-contract-'));
    const sourcePath = path.join(root, 'item.txt');
    const destinationDir = path.join(root, 'destination');
    await fs.mkdir(destinationDir);
    await fs.writeFile(sourcePath, 'keep');
    try {
      const legacyPayload = { uri: vscode.Uri.file(sourcePath), isDirectory: false, space: { basePath: root } };
      await vscode.commands.executeCommand('codeFolderSpaces.cutEntry', legacyPayload);
      await vscode.commands.executeCommand('codeFolderSpaces.pasteEntries', { uri: vscode.Uri.file(destinationDir), isDirectory: true, space: { basePath: root } });
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'keep');
      assert.deepEqual(await fs.readdir(destinationDir), []);
      await assert.rejects(fs.stat(path.join(destinationDir, 'item.txt')));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // v2-R1：`codeFolderSpaces.openFilesIn` 已於 S4.1R19（使用者決策）移除——對 VS Code 不適用，
  // 一律在目前編輯區開檔。本案例改驗現行行為（不再寫該設定，也無 beside 分支）。
  test('openEntry opens in the active editor group (openFilesIn setting removed in R19)', async () => {
    const tempPath = path.join(os.tmpdir(), `folder-spaces-open-${Date.now()}.txt`);
    await fs.writeFile(tempPath, 'open location');
    try {
      const currentColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
      await vscode.commands.executeCommand('codeFolderSpaces.openEntry', vscode.Uri.file(tempPath));
      assert.ok(vscode.window.activeTextEditor, 'current editor should be active after opening');
      assert.equal(vscode.window.activeTextEditor.viewColumn, currentColumn);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  });
});

function pathKey(value: string): string {
  return process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
}
