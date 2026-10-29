import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * tooling/R2 TH-03：F-59 `Open in Folder Spaces` 的聚焦行為自動化。
 *
 * S6R4/S6R5 只有 2026-10-27 的 EDH 實機證據（`dev/tests/pre-release/0.2.2/`），沒有自動化覆蓋。
 * 本檔以 `activate()` 匯出的 `getPanes()`（既有公開 API，供自動化驗證）斷言：
 * 命令執行後目標資料夾成為 pane1 的 root，且 pane1 的 view 可見。
 *
 * 已知限制：實作在 reveal 時使用 `{ select: false, focus: false, expand: false }`，
 * 因此**不會改變選取**；本檔不斷言 selection（改動它屬使用者可見行為變更，不在本 stage 範圍）。
 */
interface PaneSnapshot {
  id: string;
  root: string | null;
  roots: string[];
  mode: string;
  visible: boolean;
}

const normalize = (value: string): string => path.normalize(value).toLowerCase();

/** 等待條件成立；回傳 true／undefined（逾時）。VS Code 的 view 可見性是 async 更新，不能立即斷言。 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return check();
}

suite('F-59 Open in Folder Spaces 聚焦行為', () => {
  test('命令執行後目標資料夾成為 pane1 的 root，且 pane1 可見', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.folder-spaces');
    assert.ok(extension, '擴充套件必須可取得');
    const api = await extension.activate() as { getPanes(): PaneSnapshot[] };
    const pane1 = (): PaneSnapshot | undefined => api.getPanes().find(pane => pane.id === 'pane1');

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-f59-'));
    const target = path.join(tempRoot, 'target-folder');
    await fs.mkdir(target);
    try {
      await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
      assert.ok(
        !(pane1()?.roots ?? []).some(root => normalize(root) === normalize(target)),
        '前提：目標資料夾尚未出現在 pane1，否則斷言無法區分命令效果',
      );
      // 容器一旦展開就維持可見，故 visible 只能與「執行前」比較；若先前已可見，
      // 本斷言對 visible 而言是弱證據（root 斷言才是主要證據），誠實記在 assert 訊息裡。
      const visibleBefore = Boolean(pane1()?.visible);

      await vscode.commands.executeCommand('codeFolderSpaces.openInFolderSpaces', vscode.Uri.file(target));

      const added = await waitFor(() => (pane1()?.roots ?? []).some(root => normalize(root) === normalize(target)));
      assert.equal(added, true, `命令執行後 pane1 應包含目標資料夾；實際 roots=${JSON.stringify(pane1()?.roots)}`);

      // showPane('pane1') 會執行 codeFolderSpaces.pane1.focus，容器隨之展開。
      const visible = await waitFor(() => Boolean(pane1()?.visible));
      assert.equal(visible, true, `命令執行後 pane1（Folder Spaces 容器）應可見（執行前 visible=${visibleBefore}）`);
    } finally {
      await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('目標是檔案時不新增 pane root（負向）', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.folder-spaces');
    assert.ok(extension);
    const api = await extension.activate() as { getPanes(): PaneSnapshot[] };
    const roots = (): string[] => api.getPanes().find(pane => pane.id === 'pane1')?.roots ?? [];

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-f59-negative-'));
    const filePath = path.join(tempRoot, 'not-a-folder.txt');
    await fs.writeFile(filePath, 'x');
    try {
      await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
      const before = roots().map(normalize);
      await vscode.commands.executeCommand('codeFolderSpaces.openInFolderSpaces', vscode.Uri.file(filePath));
      // 命令對非資料夾直接 return；等待一個 tick 讓可能的非同步寫入有機會發生。
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(roots().map(normalize), before, '檔案目標不得成為 pane1 的 root');
    } finally {
      await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
