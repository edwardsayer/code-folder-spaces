import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('擴充套件啟用', () => {
  test('公開 API 與版本可用', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension, '找不到 edwardsayer.code-folder-spaces 擴充套件');
    const exports = await extension.activate() as { version: unknown; getSpaces: () => unknown };
    assert.equal(typeof exports.version, 'string');
    assert.equal(exports.version, extension.packageJSON.version);
    assert.ok(Array.isArray(exports.getSpaces()));
  });

  test('貢獻的指令均已註冊', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const commands = await vscode.commands.getCommands(true);
    for (const contribution of extension.packageJSON.contributes.commands ?? []) {
      assert.ok(commands.includes(contribution.command), `指令未註冊：${contribution.command}`);
    }
  });

  test('manifest 包含 view 且已註冊 focus 命令', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const views = Object.values(extension.packageJSON.contributes.views as Record<string, Array<{ id: string; when?: string }>> ?? {}).flat();
    assert.equal(views.length, 8, 'manifest 應貢獻 8 個固定 pane 插槽');
    assert.deepEqual(views.map(view => view.id), Array.from({ length: 8 }, (_, index) => `codeFolderSpaces.pane${index + 1}`));
    // S4R6（審查 F-01）：pane1 必須在啟動前**恆可見**（S4.1R3：以 `!layoutReady` 達成），否則新 profile／reload 時 8 個 view 全被隱藏，
    // Activity Bar 容器不出現、`onView` 無從觸發 → 冷啟動不可達。pane2..8 仍以 context key 控制。
    // S4.1R3（pane1 可關閉）：when 為 `!layoutReady || pane1.enabled`——未啟動前（key 未設）恆可見，維持冷啟動可達性（D77）。
    assert.equal(views[0].when, '!codeFolderSpaces.layoutReady || codeFolderSpaces.pane1.enabled', 'pane1 的 when 須保證冷啟動可見');
    for (const [index, view] of views.slice(1).entries()) assert.equal(view.when, `codeFolderSpaces.pane${index + 2}.enabled`);
    const commands = await vscode.commands.getCommands(true);
    for (const view of views) {
      const focusCommand = `${view.id}.focus`;
      // focus 命令是 workbench 已註冊該 view 的必要條件，但不是實際渲染證明。
      assert.ok(commands.includes(focusCommand), `view focus 命令未列入命令清單：${focusCommand}`);
    }
  });

  test('contributes 文字 placeholder 均存在於兩份語系檔', () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const collect = (value: unknown): string[] => {
      if (typeof value === 'string') return [...value.matchAll(/%([^%]+)%/g)].map((match) => match[1]);
      if (Array.isArray(value)) return value.flatMap(collect);
      if (value && typeof value === 'object') return Object.values(value).flatMap(collect);
      return [];
    };
    const placeholders = new Set(collect(extension.packageJSON.contributes));
    const english = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.nls.json'), 'utf8')) as Record<string, unknown>;
    const chinese = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.nls.zh-tw.json'), 'utf8')) as Record<string, unknown>;
    for (const key of placeholders) {
      assert.ok(key in english, `package.nls.json 缺少 ${key}`);
      assert.ok(key in chinese, `package.nls.zh-tw.json 缺少 ${key}`);
    }
  });
});
