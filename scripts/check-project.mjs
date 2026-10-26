#!/usr/bin/env node
/**
 * Folder Spaces 專案健康度檢查（zero-dependency，Node 20+）。
 *
 * 檢查必要檔案、manifest 契約（engines.vscode／main／publisher／capabilities／
 * @types/vscode 對齊）、i18n bundle 對稱及 src 中 l10n 訊息 key 覆蓋與打包進入點。
 * 用法：npm run check:project
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch {
    return null;
  }
};

const listTypeScriptFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name);
  return entry.isDirectory() ? listTypeScriptFiles(fullPath) : entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
});

const decodeStringLiteral = (literal) => {
  if (literal.startsWith('`')) return literal.slice(1, -1);
  if (literal.startsWith('"')) return JSON.parse(literal);
  const body = literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '\\"');
  return JSON.parse(`"${body.replace(/\\/g, '\\\\').replace(/\\\\'/g, "'").replace(/"/g, '\\"')}"`);
};

// 解析靜態字串或相鄰字面值串接；刻意不支援動態運算式。
const parseLiteralConcatenation = (expression) => {
  const tokenPattern = /\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[()+]))/gy;
  const meaningful = [];
  let cursor = 0;
  while (cursor < expression.length) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(expression);
    if (!match) return null;
    cursor = tokenPattern.lastIndex;
    const token = match[0].trim();
    if (token && !token.startsWith('//') && !token.startsWith('/*')) meaningful.push(token);
  }
  let index = 0;
  const primary = () => {
    if (meaningful[index] === '(') {
      index += 1;
      const value = sum();
      if (meaningful[index++] !== ')') throw new Error('unclosed parenthesis');
      return value;
    }
    const token = meaningful[index++];
    if (!token || !/^['"`]/.test(token) || (token.startsWith('`') && token.includes('${'))) throw new Error('not a static string');
    return decodeStringLiteral(token);
  };
  const sum = () => {
    let value = primary();
    while (meaningful[index] === '+') { index += 1; value += primary(); }
    return value;
  };
  try {
    const value = sum();
    return index === meaningful.length ? value : null;
  } catch { return null; }
};

const scanL10nMessages = (file, source) => {
  const messages = [];
  const call = /vscode\.l10n\.t\s*\(/g;
  let match;
  while ((match = call.exec(source))) {
    const start = call.lastIndex;
    let quote = '';
    let escaped = false;
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i += 1) {
      const character = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) { end = i; break; }
        depth -= 1;
      } else if (character === ',' && depth === 0) { end = i; break; }
    }
    const line = source.slice(0, match.index).split('\n').length;
    const message = end < 0 ? null : parseLiteralConcatenation(source.slice(start, end));
    if (message === null) warnings.push(`無法解析 l10n 訊息：${path.relative(root, file)}:${line}`);
    else messages.push({ file: path.relative(root, file), line, message });
  }
  return messages;
};

const requiredPaths = [
  'src/extension.ts',
  'package.json',
  'package.nls.json',
  'package.nls.zh-tw.json',
  'l10n/bundle.l10n.json',
  'l10n/bundle.l10n.zh-tw.json',
  'README.md',
  'README.zh-TW.md',
  'CHANGELOG.md',
  'LICENSE',
  '.vscodeignore',
  'assets/icon.svg',
  'tsconfig.json',
  'esbuild.mjs',
  '.vscode-test.mjs',
  'esbuild.tests.mjs',
  '.vscode/launch.json',
];

for (const relative of requiredPaths) {
  if (!fs.existsSync(path.join(root, relative))) {
    errors.push(`缺少必要檔案：${relative}`);
  }
}

const pkg = readJson('package.json');
if (!pkg) {
  errors.push('package.json 無法解析');
} else {
  if (!pkg.scripts?.['test:integration']) {
    errors.push('package.json scripts 缺少 test:integration');
  }
  if (!pkg.scripts?.['build:tests']) {
    errors.push('package.json scripts 缺少 build:tests');
  }
  if (!pkg.engines?.vscode) {
    errors.push('package.json 缺少 engines.vscode');
  }
  if (!pkg.main) {
    errors.push('package.json 缺少 main 進入點');
  }
  if (!pkg.publisher) {
    errors.push('package.json 缺少 publisher（Marketplace 發布必要）');
  }
  if (!pkg.capabilities?.untrustedWorkspaces) {
    errors.push('package.json 缺少 capabilities.untrustedWorkspaces 宣告');
  }
  if (!pkg.l10n) {
    errors.push('package.json 缺少 l10n 設定');
  }
  if (!Array.isArray(pkg.contributes?.commands) || pkg.contributes.commands.length === 0) {
    errors.push('package.json contributes.commands 為空');
  }

  const contributedCommands = new Set((pkg.contributes?.commands ?? []).map(({ command }) => command));
  // S4.1R4：pane 命令必須齊備且在 Command Palette 隱藏；view/title 依 v2 固定雙 pane 契約檢查。
  // 僅在 manifest 採用 per-pane 命令時啟用（避免誤判其他專案／測試 fixture）。
  if ([...contributedCommands].some((id) => id.startsWith('codeFolderSpaces.pane1.'))) {
    const paneCommandContract = {
      1: ['filter', 'clearFilter', 'drillUp', 'collapseAll', 'expandAll', 'refresh', 'root.add', 'root.remove', 'addRoot', 'mode.tree', 'mode.dual', 'sort.name.asc', 'sort.name.desc', 'sort.mtime.asc', 'sort.mtime.desc', 'sort.ctime.asc', 'sort.ctime.desc', 'workspaceFolders'],
      2: ['filter', 'clearFilter', 'drillUp', 'refresh', 'root.add', 'root.remove', 'toggleNested', 'toggleViewMode', 'viewMode.explorer', 'viewMode.fileList', 'viewMode.nestedFileList', 'mode.dual', 'close', 'sort.name.asc', 'sort.name.desc', 'sort.mtime.asc', 'sort.mtime.desc', 'sort.ctime.asc', 'sort.ctime.desc'],
    };
    const palette = new Set((pkg.contributes?.menus?.commandPalette ?? []).filter((item) => item.when === 'false').map((item) => item.command));
    const titleItems = pkg.contributes?.menus?.['view/title'] ?? [];
    // 契約隨產品演進維護：v2 固定雙 pane 的 title 清單取代舊多窗格清單，並非放寬檢查。
    const paneTitleContract = {
      // v22-R2（C3）：pane1.activateChild（無節點版）已移除，pane2 root 只由 cascade 或 activateChildNode 設定。
      1: ['filter', 'clearFilter', 'drillUp', 'collapseAll', 'expandAll', 'addRoot', 'refresh', 'workspaceFolders'],
      2: ['filter', 'clearFilter', 'drillUp', 'viewMode.explorer', 'viewMode.fileList', 'viewMode.nestedFileList', 'refresh', 'close'],
    };
    // v2-R6（使用者）：移除 pane1.more 這一層 submenu，其項目直接掛進「...」下拉。
    // v2.1（使用者）：pane2 不再有 View 子選單，Toggle Nested Files 直接放進 view/title；
    // 子選單勾號改用「✓ 前綴 + 成對命令 + when」workaround（extension menus 無勾號屬性）。
    const expectedSubmenus = ['codeFolderSpaces.pane1.sort', 'codeFolderSpaces.pane2.sort'];
    // 使用者：View 子選單取消，Dual Pane／Dual Pane ✓ 成對命令直接放進 view/title。
    const statefulTitlePairs = { 1: ['mode.dual'], 2: ['mode.dual'] };
    const directTitleActions = ['workspaceFolders'];
    const submenus = new Set((pkg.contributes?.submenus ?? []).map(({ id }) => id));
    const referencedSubmenus = new Set(Object.values(pkg.contributes?.menus ?? {}).flatMap((items) =>
      (items ?? []).map((item) => item.submenu).filter((id) => typeof id === 'string')));
    for (const id of expectedSubmenus) {
      if (!submenus.has(id)) errors.push(`缺少 submenu：${id}`);
      if (!referencedSubmenus.has(id)) errors.push(`submenu 未被任何 menus 項目引用：${id}`);
    }
    for (const id of submenus) {
      if (!referencedSubmenus.has(id)) errors.push(`submenu 未被任何 menus 項目引用：${id}`);
      const items = pkg.contributes?.menus?.[id] ?? [];
      const commands = new Set(items.map((item) => item.command).filter((value) => typeof value === 'string'));
      for (const item of items) {
        if (typeof item.command !== 'string') continue;
        if (typeof item.when !== 'string' || item.when.length === 0) {
          errors.push(`submenu 項目缺少 when（✓／非✓ 成對切換所需）：${id} → ${item.command}`);
        }
        if (item.toggled) {
          errors.push(`submenu 不應再使用 toggled（VS Code 不渲染子選單勾號）：${id} → ${item.command}`);
        }
        const base = item.command.endsWith('.checked') ? item.command.slice(0, -'.checked'.length) : item.command;
        if (!commands.has(base) || !commands.has(`${base}.checked`)) {
          errors.push(`submenu 狀態項目缺少成對命令：${id} → ${item.command}`);
        }
      }
    }
    for (const [menuId, items] of Object.entries(pkg.contributes?.menus ?? {})) {
      if (!submenus.has(menuId)) continue;
      for (const item of items ?? []) {
        if (item.command && !contributedCommands.has(item.command)) errors.push(`submenu ${menuId} 指向未貢獻的 command：${item.command}`);
      }
    }
    for (const [pane, expected] of Object.entries(paneTitleContract)) {
      for (const action of paneCommandContract[pane]) {
        const id = `codeFolderSpaces.pane${pane}.${action}`;
        if (!contributedCommands.has(id)) errors.push(`缺少 pane 命令：${id}`);
        if (!palette.has(id)) errors.push(`pane 命令未在 Command Palette 隱藏：${id}`);
      }
      const view = `view == codeFolderSpaces.pane${pane}`;
      const paneTitle = titleItems.filter((item) => typeof item.when === 'string' && item.when.startsWith(view));
      const inTitle = paneTitle.filter((item) => typeof item.command === 'string').map((item) => item.command.replace(`pane${pane}.`, 'paneN.'));
      for (const action of expected) {
        const command = `codeFolderSpaces.paneN.${action}`;
        if (!inTitle.includes(command)) errors.push(`pane${pane} 的 view/title 缺少 ${command}`);
      }
      const paneSubmenus = pane === '1'
        ? ['codeFolderSpaces.pane1.sort']
        : ['codeFolderSpaces.pane2.sort'];
      for (const submenu of paneSubmenus) {
        if (!paneTitle.some((item) => item.submenu === submenu)) errors.push(`pane${pane} 的 view/title 缺少 submenu ${submenu}`);
      }
      for (const action of statefulTitlePairs[pane] ?? []) {
        const whens = [];
        for (const suffix of ['', '.checked']) {
          const id = `codeFolderSpaces.paneN.${action}${suffix}`;
          if (!inTitle.includes(id)) errors.push(`pane${pane} 的 view/title 缺少 ${id}`);
          if (!palette.has(`codeFolderSpaces.pane${pane}.${action}${suffix}`)) errors.push(`pane 命令未在 Command Palette 隱藏：codeFolderSpaces.pane${pane}.${action}${suffix}`);
          const entry = paneTitle.find((item) => item.command === `codeFolderSpaces.pane${pane}.${action}${suffix}`);
          if (!entry) continue;
          if (typeof entry.when !== 'string' || entry.when.length === 0) {
            errors.push(`pane${pane} 的 view/title 成對項目缺少 when：${entry.command}`);
          } else {
            whens.push(entry.when);
          }
          if (entry.toggled) errors.push(`view/title 成對項目不應使用 toggled：${entry.command}`);
        }
        if (whens.length === 2 && whens[0] === whens[1]) {
          errors.push(`pane${pane} 的 view/title 成對項目 when 未互斥：${action}`);
        }
      }
      // v22-R6+（使用者）：兩個 pane 的 filter／clearFilter 都必須在 navigation@3，
      // 才會緊鄰「…」更多動作下拉選單（Spaces 與 Files 位置一致）。
      for (const action of ['filter', 'clearFilter']) {
        const entry = paneTitle.find((item) => item.command === `codeFolderSpaces.pane${pane}.${action}`);
        if (!entry) {
          errors.push(`pane${pane} 的 view/title 缺少 codeFolderSpaces.pane${pane}.${action}`);
        } else if (entry.group !== 'navigation@3') {
          errors.push(`pane${pane} 的 ${action} 必須在 navigation@3（與 … 下拉選單相鄰），實際為 ${entry.group ?? '(未設定)'}`);
        }
      }
    }

    // v21-R5：pane1 資料夾列 always 顯示「下鑽 + 啟用子空間」；Mark/Unmark 由節點 contextValue 決定。
    const itemContext = pkg.contributes?.menus?.['view/item/context'] ?? [];
    const inlineActivate = itemContext.find((item) => item.command === 'codeFolderSpaces.activateChildNode');
    if (!inlineActivate) {
      errors.push('view/item/context 缺少 codeFolderSpaces.activateChildNode（pane1 資料夾列的 Activate Child Space）');
    } else {
      if (!String(inlineActivate.group ?? '').startsWith('inline@')) errors.push('activateChildNode 必須是 inline 動作');
      const when = String(inlineActivate.when ?? '');
      if (!/view == codeFolderSpaces\.pane1/.test(when)) errors.push('activateChildNode 只應出現在 pane1');
      if (!/viewItem == codeFolderSpaces\.folder/.test(when) || !/spaceRoot/.test(when)) {
        errors.push('activateChildNode 的 when 必須涵蓋資料夾列與 root 列');
      }
    }
    const markItem = itemContext.find((item) => item.command === 'codeFolderSpaces.root.markAsGlobal');
    const unmarkItem = itemContext.find((item) => item.command === 'codeFolderSpaces.root.unmarkGlobal');
    if (!markItem || markItem.when !== 'viewItem == codeFolderSpaces.spaceRoot') {
      errors.push('root.markAsGlobal 的 when 必須是 viewItem == codeFolderSpaces.spaceRoot（僅非 global root）');
    }
    if (!unmarkItem || unmarkItem.when !== 'viewItem == codeFolderSpaces.spaceRoot.global') {
      errors.push('root.unmarkGlobal 的 when 必須是 viewItem == codeFolderSpaces.spaceRoot.global');
    }
    for (const item of itemContext) {
      if (['codeFolderSpaces.root.markAsGlobal', 'codeFolderSpaces.root.unmarkGlobal'].includes(item.command)) continue;
      const when = String(item.when ?? '');
      if (!when.includes('codeFolderSpaces.spaceRoot')) continue;
      // 任何以 root 為條件的選單都必須用 regex 形式（同時涵蓋 `.spaceRoot` 與 `.spaceRoot.global`）；
      // 只寫 `== codeFolderSpaces.spaceRoot` 或 `=~ /^codeFolderSpaces\.spaceRoot$/` 都會漏掉 global root。
      if (!when.includes('=~ /^codeFolderSpaces\.spaceRoot/')) {
        errors.push(`root 條件請改用 viewItem =~ /^codeFolderSpaces\.spaceRoot/（不可加 $）以涵蓋 global root：${item.command}`);
      }
    }

    // D47（S4.1R11b 回歸防線）：選單項目（view/title 與 view/item/context）不提供可靠的 view id。
    // 真正的風險有兩種：
    //  (1) 命令 id **內嵌特定 paneN** 但 when 涵蓋多個 pane → handler 閉包綁定該 pane，
    //      使其他 pane 的操作错路由（審查 P1-1）。此類項目應改用 pane 無關的全域命令（由節點解析）。
    //  (2) view/title（**不傳節點**）的 pane-scoped 操作必須用**該 pane**的專屬命令 id。
    // `pane.add`／`pane.resetLayout` 為整體操作，不依賴發起窗格，列為例外。
    const globallyScoped = new Set([
      'codeFolderSpaces.pane.add',
      'codeFolderSpaces.pane.resetLayout',
    ]);
    const explicitPanesOf = (when) => [...new Set([...when.matchAll(/view == codeFolderSpaces\.(pane[1-2])/g)].map((match) => match[1]))];
    const coversAllPanes = (when) => /view =~ \/\^codeFolderSpaces\.pane\[1-8\]\$\//.test(when);
    const embeddedPaneOf = (command) => (/codeFolderSpaces\.(pane[1-2])\./.exec(command) ?? [])[1];
    const checkPaneScoped = (items, where, hasNode) => {
      for (const item of items ?? []) {
        const when = typeof item.when === 'string' ? item.when : '';
        const command = String(item.command ?? '');
        if (globallyScoped.has(command)) continue;
        const embedded = embeddedPaneOf(command);
        if (!embedded) continue; // 全域 id：由節點解析 paneId，正確。
        const panes = explicitPanesOf(when);
        if (coversAllPanes(when) || panes.length > 1) {
          errors.push(`${where} 的項目涵蓋多個 pane，不得使用內嵌特定 pane 的命令 id（D47）：${command}`);
          continue;
        }
        if (!hasNode && panes.length === 1 && panes[0] !== embedded) {
          errors.push(`${where} 的 pane 專屬項目必須使用該 pane 的命令 id（D47）：${panes[0]} → ${command}`);
        }
      }
    };
    checkPaneScoped(titleItems, 'view/title', false);
    checkPaneScoped(pkg.contributes?.menus?.['view/item/context'], 'view/item/context', true);
  }

  for (const binding of pkg.contributes?.keybindings ?? []) {
    if (!contributedCommands.has(binding.command)) errors.push(`keybinding 指向未貢獻的 command：${binding.command}`);
  }

  const engines = String(pkg.engines?.vscode ?? '').replace(/^[\^~]/, '');
  const types = String(pkg.devDependencies?.['@types/vscode'] ?? '').replace(/^[\^~]/, '');
  const enginesMinor = engines.split('.').slice(0, 2).join('.');
  const typesMinor = types.split('.').slice(0, 2).join('.');
  if (engines && types && enginesMinor !== typesMinor) {
    errors.push(`engines.vscode (${pkg.engines.vscode}) 與 @types/vscode (${pkg.devDependencies['@types/vscode']}) 不一致`);
  }

  const vscodeignore = fs.existsSync(path.join(root, '.vscodeignore'))
    ? fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/).map((line) => line.trim())
    : [];
  if (!['out', 'out/', '/out/'].some((entry) => vscodeignore.includes(entry))) {
    errors.push('.vscodeignore 缺少 out 忽略規則，避免 VSIX 打包測試 bundle');
  }

  const nls = readJson('package.nls.json') ?? {};
  const nlsZh = readJson('package.nls.zh-tw.json') ?? {};
  for (const match of JSON.stringify(pkg).matchAll(/%([\w.-]+)%/g)) {
    if (!(match[1] in nls)) errors.push(`package.nls.json 缺少 manifest 引用 key：${match[1]}`);
  }
  const missing = Object.keys(nls).filter((key) => !(key in nlsZh));
  const extra = Object.keys(nlsZh).filter((key) => !(key in nls));
  if (missing.length) {
    errors.push(`package.nls.zh-tw.json 缺少 ${missing.length} 個 key：${missing.slice(0, 5).join(', ')}`);
  }
  if (extra.length) {
    errors.push(`package.nls.zh-tw.json 有 ${extra.length} 個多餘 key：${extra.slice(0, 5).join(', ')}`);
  }

  const bundle = readJson('l10n/bundle.l10n.json') ?? {};
  const bundleZh = readJson('l10n/bundle.l10n.zh-tw.json') ?? {};
  const bundleMissing = Object.keys(bundle).filter((key) => !(key in bundleZh));
  const bundleExtra = Object.keys(bundleZh).filter((key) => !(key in bundle));
  if (bundleMissing.length) {
    errors.push(`l10n/bundle.l10n.zh-tw.json 缺少 ${bundleMissing.length} 個訊息`);
  }
  if (bundleExtra.length) {
    errors.push(`l10n/bundle.l10n.zh-tw.json 有 ${bundleExtra.length} 個多餘訊息`);
  }

  // 只比較 placeholder 集合，允許翻譯調整參數順序或重複引用。
  const placeholders = value => [...new Set(value.match(/\{\d+\}/g) ?? [])].sort().join(',');
  for (const [file, source, translated] of [
    ['package.nls.zh-tw.json', nls, nlsZh],
    ['l10n/bundle.l10n.zh-tw.json', bundle, bundleZh],
  ]) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string' || typeof translated[key] !== 'string' || !translated[key].trim()) {
        errors.push(`${file} 訊息必須是非空字串：${key}`);
      } else if (placeholders(value) !== placeholders(translated[key])) {
        errors.push(`${file} placeholder 不一致：${key}`);
      }
    }
  }

  for (const file of listTypeScriptFiles(path.join(root, 'src'))) {
    for (const { file: relative, line, message } of scanL10nMessages(file, fs.readFileSync(file, 'utf8'))) {
      if (!(message in bundle)) errors.push(`l10n/bundle.l10n.json 缺少 key：${relative}:${line} — ${message.slice(0, 100)}`);
    }
  }

  if (!fs.existsSync(path.join(root, 'dist', 'extension.js'))) {
    warnings.push('尚未建置：dist/extension.js 不存在（執行 npm run build）');
  }
  if (!pkg.icon) {
    warnings.push('package.json 尚未設定 icon（Marketplace 需要 ≥128×128 PNG）');
  }
  if (!pkg.repository) {
    warnings.push('package.json 尚未設定 repository');
  }
}

const mode = errors.length ? 'FAIL' : warnings.length ? 'PASS (warnings)' : 'PASS';
console.log(`[check-project] ${mode} — ${root}`);
console.log('  ℹ️  l10n 掃描僅辨識字面形式 vscode.l10n.t(...)；destructured l10n.t(...)、條件運算式及註解中的假字串不保證正確識別。');
for (const error of errors) console.log(`  ❌ ${error}`);
for (const warning of warnings) console.log(`  ⚠️  ${warning}`);
if (!errors.length && !warnings.length) console.log('  ✅ 所有檢查通過');
process.exitCode = errors.length ? 1 : 0;
