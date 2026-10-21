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

  test('v2.1 成對勾號命令、pane2 巢狀切換與標題貢獻符合契約', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const manifest = extension.packageJSON.contributes;
    const commands = new Set((manifest.commands ?? []).map((item: { command: string }) => item.command));
    assert.ok(commands.has('codeFolderSpaces.pane1.activateChild'));
    assert.ok(!commands.has('codeFolderSpaces.pane1.adoptChild'));
    assert.ok(!commands.has('codeFolderSpaces.pane1.toggleNested'));
    assert.ok(commands.has('codeFolderSpaces.pane2.toggleNested'));
    const menus = manifest.menus as Record<string, Array<{ command?: string; toggled?: string; when?: string }>>;
    // v2.1：子選單以「✓ 前綴 + 成對命令 + when」呈現勾選狀態；VS Code 不渲染 extension 子選單的 toggled。
    assert.equal(menus['codeFolderSpaces.pane1.view'].length, 4);
    assert.equal(menus['codeFolderSpaces.pane1.sort'].length, 12);
    assert.equal(menus['codeFolderSpaces.pane2.view'], undefined, 'pane2 View 子選單應已移除');
    for (const id of ['codeFolderSpaces.pane1.view', 'codeFolderSpaces.pane1.sort']) {
      const items = menus[id];
      assert.ok(items.every(item => !item.toggled), `${id} 不應再使用 toggled`);
      assert.ok(items.every(item => Boolean(item.when)), `${id} 每個項目均需 when`);
      const ids = new Set(items.map(item => item.command));
      for (const command of ids) {
        const base = String(command).replace(/\.checked$/, '');
        assert.ok(ids.has(base) && ids.has(`${base}.checked`), `${id} 狀態項目需成對：${command}`);
      }
    }
    const title = manifest.menus['view/title'] as Array<{ command?: string; submenu?: string; when?: string; group?: string }>;
    // v21-R2（使用者）：Activate Child Space 不再出現在 pane1 的 view/title（文字按鈕會擠壓標題列）。
    assert.ok(!title.some(item => item.command === 'codeFolderSpaces.pane1.activateChild'));
    assert.ok(commands.has('codeFolderSpaces.pane1.activateChild'), '命令本身仍需保留');
    assert.ok(title.some(item => item.command === 'codeFolderSpaces.pane1.drillUp' && item.when?.includes('mode == tree')));
    assert.ok(title.some(item => item.command === 'codeFolderSpaces.pane2.drillUp' && item.group === 'navigation@0'));
    // v2.1：Toggle Nested Files 直接掛在 pane2 的 view/title（成對），不再走子選單。
    assert.ok(title.some(item => item.command === 'codeFolderSpaces.pane2.toggleNested' && item.group === '3_view@1'));
    assert.ok(title.some(item => item.command === 'codeFolderSpaces.pane2.toggleNested.checked' && item.group === '3_view@1'));
    // v21-R5：pane1 每個資料夾列 always 顯示「Drill Into Folder」與「Activate Child Space」。
    assert.ok(commands.has('codeFolderSpaces.activateChildNode'), 'activateChildNode 必須註冊');
    const itemContext = (manifest.menus['view/item/context'] ?? []) as Array<{ command?: string; when?: string; group?: string }>;
    const inlineActivate = itemContext.find(item => item.command === 'codeFolderSpaces.activateChildNode');
    assert.ok(inlineActivate, 'view/item/context 需有 activateChildNode');
    assert.ok(String(inlineActivate!.group).startsWith('inline@'), 'activateChildNode 必須是 inline 動作');
    assert.match(String(inlineActivate!.when), /view == codeFolderSpaces\.pane1/);
    assert.match(String(inlineActivate!.when), /viewItem == codeFolderSpaces\.folder/);
    assert.match(String(inlineActivate!.when), /spaceRoot/);
    // v21-R5：Mark／Unmark 由節點 contextValue 決定（不再依賴選取驅動的 context key）。
    assert.equal(itemContext.find(item => item.command === 'codeFolderSpaces.root.markAsGlobal')?.when, 'viewItem == codeFolderSpaces.spaceRoot');
    assert.equal(itemContext.find(item => item.command === 'codeFolderSpaces.root.unmarkGlobal')?.when, 'viewItem == codeFolderSpaces.spaceRoot.global');

    // 死條目清理：pane3–pane8 的 title 與 viewsWelcome 均已移除。
    const welcome = (manifest.viewsWelcome ?? []) as Array<{ view: string }>;
    assert.ok(welcome.every(item => !/^codeFolderSpaces\.pane[3-8]$/.test(item.view)), 'viewsWelcome 不應再有 pane3–pane8');
    assert.ok(title.every(item => !/view == codeFolderSpaces\.pane[3-8]/.test(String(item.when ?? ''))), 'view/title 不應再有 pane3–pane8');
  });

  test('manifest 包含 view 且已註冊 focus 命令', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const views = Object.values(extension.packageJSON.contributes.views as Record<string, Array<{ id: string; when?: string }>> ?? {}).flat();
    // v2-redesign（v2-R4）：固定 2 pane，不再有 pane3..8。
    assert.equal(views.length, 2, 'manifest 應貢獻 2 個固定 pane 插槽（v2 固定雙 pane）');
    assert.deepEqual(views.map(view => view.id), ['codeFolderSpaces.pane1', 'codeFolderSpaces.pane2']);
    // S4R6（審查 F-01）：pane1 必須在啟動前**恆可見**（S4.1R3：以 `!layoutReady` 達成），否則新 profile／reload 時
    // view 全被隱藏，Activity Bar 容器不出現、`onView` 無從觸發 → 冷啟動不可達。
    // S4.1R3（pane1 可關閉）：when 為 `!layoutReady || pane1.enabled`——未啟動前（key 未設）恆可見，維持冷啟動可達性（D77）。
    assert.equal(views[0].when, '!codeFolderSpaces.layoutReady || codeFolderSpaces.pane1.enabled', 'pane1 的 when 須保證冷啟動可見');
    // v2：pane2 只在 dual 模式顯示（取代舊的 paneN.enabled）。
    assert.equal(views[1].when, 'codeFolderSpaces.mode == dual', 'pane2 僅在 dual 模式顯示');
    const commands = await vscode.commands.getCommands(true);
    for (const view of views) {
      const focusCommand = `${view.id}.focus`;
      // focus 命令是 workbench 已註冊該 view 的必要條件，但不是實際渲染證明。
      assert.ok(commands.includes(focusCommand), `view focus 命令未列入命令清單：${focusCommand}`);
    }
  });

  test('workbench 點擊行為設定可依目標寫入並還原', async () => {
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const configuration = vscode.workspace.getConfiguration('workbench');
    const inspected = configuration.inspect<unknown>('tree.expandMode');
    const previous = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    const targetName = target === vscode.ConfigurationTarget.Workspace ? 'workspaceValue' : 'globalValue';
    try {
      await configuration.update('tree.expandMode', 'doubleClick', target);
      assert.equal(configuration.inspect('tree.expandMode')?.[targetName], 'doubleClick');
      await configuration.update('tree.expandMode', previous, target);
      assert.deepEqual(configuration.inspect('tree.expandMode')?.[targetName], previous);
    } finally {
      await configuration.update('tree.expandMode', previous, target);
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
