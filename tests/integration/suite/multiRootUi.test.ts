import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activeRoot,
  PANE_STATE_KEY,
  PaneStateStore,
  type MementoLike,
} from '../../../src/spaces/viewState';

/**
 * S4.1R11b 專屬整合測試：UI 入口與 root 列語意的**可驗證核心**。
 *
 * 說明：`view/title` 與 `view/item/context` 的選單呈現需 EDH 真實點擊（主控取證）；
 * 此處以 Extension Host 可驗證的層級鎖定三個關鍵不變式：
 *  1. `root.remove` 只移除資料夾，**不得**關閉窗格（P1-5 的核心落差）。
 *  2. `canRemoveRoot` 的判定條件（`roots.length > 1`）與選單 gate 一致。
 *  3. P1-4：`followWorkspaceDirectory` 設定變更時每個啟用 pane 都被寫入。
 */

class MemoryMemento implements MementoLike {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key); else this.values.set(key, value);
  }
}

const norm = (value: string): string => path.normalize(value);

/**
 * v2-R1：`PANE_STATE_KEY` 已等於 `layout.v1` key，舊的 `{ version: 3, panes }` 文檔會被
 * `normalizeLayout` 判為無效而重建預設（roots 為空）。因此種子資料必須以 `layout.v1` 形狀寫入：
 * `panes.pane1` → `primary`、`panes.pane2` → `secondary`，其餘 pane 在 v2 不存在。
 */
function storeWith(panes: Record<string, unknown>): PaneStateStore {
  const memento = new MemoryMemento();
  const pane = (id: string): Record<string, unknown> => (panes[id] as Record<string, unknown> | undefined) ?? {};
  const primary = pane('pane1');
  const secondary = pane('pane2');
  memento.values.set(PANE_STATE_KEY, {
    version: 1,
    mode: 'tree',
    primary: { roots: [], drillRoot: null, drillStack: [], filter: '', sort: { key: 'name', direction: 'asc' }, view: { mode: 'tree', level: 'all', content: 'all' }, icon: null, include: [], exclude: [], ...primary },
    secondary: { roots: [], drillRoot: null, drillStack: [], filter: '', sort: { key: 'name', direction: 'asc' }, view: { mode: 'flat', level: 'all', content: 'all' }, icon: null, include: [], exclude: [], ...secondary },
  });
  return new PaneStateStore(memento);
}

suite('S4.1R11b root 入口與術語（多資料夾空間）', () => {
  let tempRoot = '';

  suiteSetup(() => {
    tempRoot = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'cfs-r11b-'));
    fs.mkdirSync(path.join(tempRoot, 'a'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'b'), { recursive: true });
  });

  suiteTeardown(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('root.remove 移除資料夾後窗格仍存在，且只影響 roots（P1-5：不得關閉窗格）', async () => {
    const a = norm(path.join(tempRoot, 'a'));
    const b = norm(path.join(tempRoot, 'b'));
    const store = storeWith({
      pane1: { roots: [a, b], drillRoot: null, parentPaneId: null, follow: false, followWorkspaceDirectory: true },
    });

    assert.equal(store.get('pane1').roots.length, 2);
    const removed = await store.removePaneRoot('pane1', b);
    assert.equal(removed, true, 'root 應可被移除');
    // 窗格仍在（未被關閉）：這是與舊行為（pane.close）最關鍵的差異。
    assert.ok(store.getEnabledPaneIds().includes('pane1'), '移除 root 不得關閉窗格');
    assert.deepEqual(store.get('pane1').roots, [a]);
    assert.equal(activeRoot(store.get('pane1')), a);
  });

  test('live 命令 paneN.root.remove 以被點擊節點的 rootPath 為標的（多 root 不可誤刪 activeRoot）', async () => {
    // 這是 handler 接線層的驗證：root 列的 inline X 會傳入被點擊的節點，
    // 若 handler 忽略節點而只移除 activeRoot（＝roots[0]），就會刪錯資料夾。
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    await extension.activate();

    const b = path.join(tempRoot, 'b');
    const normalize = (value: string | null): string => (value ?? '').split(String.fromCharCode(92)).join('/').toLowerCase();

    // 以命令加入一個 root（pane1 於 resetLayout 後已含工作區根，故 activeRoot ≠ 新加入者，
    // 這樣才能區分「移除被點擊者」與「移除 activeRoot」）。
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    await vscode.commands.executeCommand('codeFolderSpaces.pane1.root.add', b);

    const api = await extension.activate() as { getPanes(): Array<{ id: string; root: string | null; roots: string[]; mode: 'tree' | 'dual'; slot: 'primary' | 'secondary' }> };
    const paneBefore = api.getPanes().find(pane => pane.id === 'pane1');
    assert.equal(paneBefore?.roots.length, 2, `加入後應有 2 個 root，實際=${JSON.stringify(paneBefore?.roots)}`);
    assert.equal(normalize(paneBefore?.root ?? null), normalize(paneBefore?.roots[0] ?? null),
      'activeRoot 應為 roots[0]（未被下鑽）');
    assert.notEqual(normalize(paneBefore?.roots[0] ?? null), normalize(b), 'roots[0] 不應是新加入的 b（否則測不到誤刪）');

    // 節點物件模擬 root 列（SpaceRootNode 的結構形狀：uri + paneId + definition + rootPath）。
    const clickNode = {
      uri: vscode.Uri.file(b),
      paneId: 'pane1',
      isDirectory: true,
      rootPath: b,
      definition: { basePath: b, name: 'b', showFiles: true, include: [], exclude: [], sourceIndex: -1 },
    };

    await vscode.commands.executeCommand('codeFolderSpaces.pane1.root.remove', clickNode);
    const after = api.getPanes().find(pane => pane.id === 'pane1');
    assert.ok(after, '窗格必須仍存在（移除 root 不可關閉窗格）');
    // 被移除的是 b（roots[1]），而非 roots[0]；若 handler 忽略節點就會誤刪 activeRoot。
    assert.deepEqual(after.roots.map(normalize), [normalize(paneBefore!.roots[0])],
      '應移除被點擊的 b 並留下 roots[0]');

    // 清理：還原預設佈局。
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
  });

  test('OP-20 manifest：root inline remove gate 與 command id 符合契約', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const manifest = extension.packageJSON as { contributes?: { menus?: { 'view/item/context'?: Array<{ command?: string; when?: string; group?: string }> } } };
    const entries = manifest.contributes?.menus?.['view/item/context'] ?? [];
    const rootRemove = entries.filter(item => /codeFolderSpaces\.pane[12]\.root\.remove/.test(item.command ?? ''));
    assert.equal(rootRemove.length, 2, 'pane1／pane2 應各有 pane-scoped root.remove inline action');
    assert.ok(rootRemove.every(item => /viewItem == codeFolderSpaces\.spaceRoot/.test(item.when ?? '')),
      `inline when 必須限制在 root context：${JSON.stringify(rootRemove)}`);

    // P2-3：鎖住本輪 OP-20 真正的 manifest 改動（原本只驗 root.remove，未驗下鑽／加子）。
    const drillInline = entries.filter(item => item.command === 'codeFolderSpaces.drillDown' && item.group === 'inline@2');
    assert.equal(drillInline.length, 1, '下鑽應恰好一個 inline@2 項目');
    assert.match(drillInline[0].when ?? '', /viewItem == codeFolderSpaces\.spaceRoot/,
      '下鑽 inline when 必須涵蓋根目錄列（OP-20）');
    assert.match(drillInline[0].when ?? '', /viewItem == codeFolderSpaces\.folder/, '下鑽 inline when 仍須涵蓋資料夾列');
    assert.ok(!/codeFolderSpaces\.file/.test(drillInline[0].when ?? ''), '下鑽不得出現在檔案列');

    assert.equal(entries.filter(item => item.command === 'codeFolderSpaces.pane.addChild').length, 0,
      'v2 不再貢獻 Add Child Space inline action');
  });

  test('canRemoveRoot 條件＝roots.length > 1，與選單 gate 一致', async () => {
    const a = norm(path.join(tempRoot, 'a'));
    const b = norm(path.join(tempRoot, 'b'));
    const store = storeWith({
      pane1: { roots: [a], drillRoot: null, parentPaneId: null, follow: false, followWorkspaceDirectory: true },
      pane2: { roots: [a, b], drillRoot: null, parentPaneId: null, follow: false, followWorkspaceDirectory: false },
    });

    // 單 root：X 不應顯示（移除後會清空 pane，語意為「關閉」而非「移除資料夾」）。
    assert.equal(store.get('pane1').roots.length > 1, false);
    // 多 root：X 顯示。
    assert.equal(store.get('pane2').roots.length > 1, true);
    // 移除至單一 root 後條件應變回 false（UI 隨之隱藏）。
    await store.removePaneRoot('pane2', b);
    assert.equal(store.get('pane2').roots.length > 1, false);
  });

  test('加入資料夾：重複者不重複加入（addPaneRoot 回傳 false 供 UI 提示）', async () => {
    const a = norm(path.join(tempRoot, 'a'));
    const b = norm(path.join(tempRoot, 'b'));
    const store = storeWith({
      pane1: { roots: [a], drillRoot: null, parentPaneId: null, follow: false, followWorkspaceDirectory: true },
    });

    assert.equal(await store.addPaneRoot('pane1', b), true, '新資料夾應加入成功');
    assert.equal(await store.addPaneRoot('pane1', b), false, '重複加入應回報 false');
    assert.deepEqual(store.get('pane1').roots, [a, b], 'roots 必須保序且無重複');
  });

  test('P1-4：followWorkspaceDirectory 設定變更不改 layout/API pane shape', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    await extension.activate();
    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    const api = await extension.activate() as { getPanes(): Array<{ id: string; root: string | null; roots: string[]; mode: 'tree' | 'dual'; slot: 'primary' | 'secondary' }> };
    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const before = config.inspect<boolean>('followWorkspaceDirectory')?.globalValue;
    try {
      const beforePanes = api.getPanes();
      assert.ok(beforePanes.length > 0, '前置：至少有一個啟用 pane');
      await config.update('followWorkspaceDirectory', false, vscode.ConfigurationTarget.Global);
      // P2-9：以輪詢取代固定 100ms 等待（CI 冷啟動下事件可能更慢）。
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (api.getPanes().length === beforePanes.length) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.deepEqual(api.getPanes().map(({ id, mode, slot }) => [id, mode, slot]), beforePanes.map(({ id, mode, slot }) => [id, mode, slot]),
        '設定變更不得寫入或改變 layout pane 結構');
      // P2-9：原第三個斷言只是重述 paneLinks 已覆蓋的純函式，對本 seam 無鑑別力，已移除。
    } finally {
      await config.update('followWorkspaceDirectory', before, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    }
  });

  test('術語與命令契約：pane 專屬 view/title 項目使用 per-pane id（D47）', async () => {
    const pkg = vscode.extensions.getExtension('edwardsayer.code-folder-spaces')?.packageJSON as
      { contributes?: { menus?: { 'view/title'?: Array<{ command?: string; submenu?: string; when?: string }> } } } | undefined;
    const titleItems = pkg?.contributes?.menus?.['view/title'] ?? [];
    assert.ok(titleItems.length > 0, 'manifest 應有 view/title 項目');

    const globallyScoped = new Set([
      'codeFolderSpaces.pane.add',
      'codeFolderSpaces.pane.resetLayout',
      'codeFolderSpaces.pane.close',
    ]);
    const offenders = titleItems.filter(item => {
      const when = String(item.when ?? '');
      const match = /view == codeFolderSpaces\.(pane[1-8])/.exec(when);
      if (!match) return false;
      if (item.submenu) return false;
      const command = String(item.command ?? '');
      if (globallyScoped.has(command)) return false;
      return !command.includes(`.${match[1]}.`);
    }).map(item => `${item.command} @ ${item.when}`);
    assert.deepEqual(offenders, [], `view/title 的 pane 專屬項目必須使用 per-pane id（D47）：${offenders.join('; ')}`);

    // v2-R6：pane1 的檢視與排序由原生 submenu 提供；「更多」
    // **不再有一層 more submenu**（使用者 2026-10-20：把 more 的項目直接放進「...」下拉），
    // 因此改驗證那三個動作直接掛在 view/title。pane2 沒有任何 submenu。
    const commands = new Set(titleItems.map(item => String(item.command)));
    const submenus = new Set(titleItems.map(item => String(item.submenu)));
    assert.ok(commands.has('codeFolderSpaces.pane1.addRoot'), 'pane1 應有 per-pane 的 addRoot 入口');
    assert.ok(submenus.has('codeFolderSpaces.pane1.view'), 'pane1 應有原生 view submenu');
    assert.ok(submenus.has('codeFolderSpaces.pane1.sort'), 'pane1 應有原生 sort submenu');
    assert.ok(!submenus.has('codeFolderSpaces.pane1.more'), 'pane1 不應再有 more submenu（項目已直接進入「...」）');
    for (const action of ['workspaceFolders', 'switchRoot', 'resetLayout']) {
      assert.ok(commands.has(`codeFolderSpaces.pane1.${action}`), `pane1 的 ${action} 應直接掛在 view/title`);
    }
    assert.ok(!submenus.has('codeFolderSpaces.pane2.more'), 'pane2 不應有 more submenu');
  });

  test('live 命令 pane2.root.remove 只操作 pane2（P1-1：不得錯路由到 pane1）', async () => {
    // view/item/context 的 root 列 X 使用 pane 專屬命令，避免 pane2 操作錯路由到 pane1。
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    await extension.activate();

    const normalize = (value: string | null): string => (value ?? '').split(String.fromCharCode(92)).join('/').toLowerCase();
    const api = await extension.activate() as { getPanes(): Array<{ id: string; root: string | null; roots: string[]; mode: 'tree' | 'dual'; slot: 'primary' | 'secondary' }> };

    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    const pane1Before = api.getPanes().find(pane => pane.id === 'pane1');
    assert.ok(pane1Before, '前置：pane1 應存在');

    // 以 pane2 的節點呼叫 pane 專屬命令——模擬使用者點 pane2 的 root 列 X。
    const clickNode = {
      uri: vscode.Uri.file(path.join(tempRoot, 'b')),
      paneId: 'pane2',
      isDirectory: true,
      rootPath: path.join(tempRoot, 'b'),
      definition: { basePath: path.join(tempRoot, 'b'), name: 'b', showFiles: true, include: [], exclude: [], sourceIndex: -1 },
    };
    await vscode.commands.executeCommand('codeFolderSpaces.pane2.root.remove', clickNode);

    const pane1After = api.getPanes().find(pane => pane.id === 'pane1');
    assert.ok(pane1After, 'pane1 必須仍存在');
    // 關鍵：pane1 的 roots 必須完全不變（不得因 pane2 的點擊而被動到）。
    assert.deepEqual(pane1After.roots.map(normalize), pane1Before.roots.map(normalize),
      '點 pane2 的 X 不得改變 pane1 的 roots（P1-1 错路由回歸）');

    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
  });

  test('單 root 守門：不得移除唯一 root（P1-3：Palette 等路徑可繞過 canRemoveRoot）', async () => {
    const extension = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(extension);
    const api = await extension.activate() as { getPanes(): Array<{ id: string; root: string | null; roots: string[]; mode: 'tree' | 'dual'; slot: 'primary' | 'secondary' }> };

    await vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout');
    const before = api.getPanes().find(pane => pane.id === 'pane1');
    assert.ok(before, '前置：pane1 應存在');
    assert.equal(before.roots.length, 1, '前置：pane1 應只有一個 root');

    // 無節點呼叫 live 命令（模擬命令面板）——應被守門擋下。
    await vscode.commands.executeCommand('codeFolderSpaces.pane1.root.remove');
    const after = api.getPanes().find(pane => pane.id === 'pane1');
    assert.ok(after, '窗格必須仍存在');
    assert.equal(after.roots.length, 1, '唯一 root 不得被移除（否則資料夾空間會變空）');
  });
});
