# AGENTS.md — code-folder-spaces

## Overview

`code-folder-spaces`（extension id `edwardsayer.code-folder-spaces`）：VS Code 版的 Folder Spaces。在專屬 Activity Bar 容器中提供**資料夾範圍的檔案總管空間**——每個空間以指定資料夾為根，只呈現該資料夾的樹狀內容。設計來源為 Obsidian 外掛 Folder Spaces；排除 Obsidian 專屬機制（leaf/view monkey-patch、popout window scoped 操作、folder-notes 生態），改以 VS Code Extension API 實作。

產品願景、功能優先序與 Stage 計畫見私有規劃：

- `dev/planning/TODO.md`（唯一 canonical Stage 主控）
- `dev/planning/feature-list-and-priorities.md`
- `dev/planning/implementation-plan.md`
- `dev/specs/obsidian-folder-spaces-feature-review.md`（來源功能盤點與排除項）
- `dev/specs/architecture-review-explorer-extensions.md`（兩個參考專案的架構分析與決策）

> `dev/` 實體位於工作區私有 repo `dev/code-folder-spaces/`，本專案內為 NTFS junction；管理用 `node ../tools/dev-link.mjs`。**禁用 `rm -rf <project>/dev`**。

## Architecture (`src/`)

- `extension.ts`：`activate()` 進入點。建立 `SpaceStore`、`SpaceTreeDataProvider`、`TreeView`，註冊指令與檔案監看器，回傳公開 API（`version`、`getSpaces()`、**`getPanes()`**〔供自動化驗證：id／root／roots／`mode`（`tree`／`dual`）／`slot`（`primary`／`secondary`）〕）。
- `spaces/spaceConfig.ts`：**純邏輯**（無 `vscode` 相依）——設定正規化、變數插值、glob 比對。所有可單元測試的邏輯放這裡。
- `spaces/spaceStore.ts`：`spaces.workspace`／`spaces.global` 雙來源設定的讀寫封裝、變更事件及空間來源操作；`spaces.workspace` 為工作區層，`spaces.global` 為使用者 profile 層。
- `spaces/layout.ts`：**v2 唯一的持久化狀態層**——`codeFolderSpaces.layout.v1`（`{version:1, mode:'tree'|'dual', primary, secondary}`）；`LayoutStore` 提供 mode／roots／filter／sort／view／drill／`rewriteRoots`／`reset`。舊 `panes.v3`／`v2`／`v1` **只忽略、不讀寫、不刪除**（v2 不寫遷移程式）。
- `spaces/viewState.ts`：`LayoutStore` 的**相容層**（約 90 行）——維持 `PaneStateStore` 介面與 provider 依賴的 `PaneState` 形狀（`roots`／`drillRoot`／`drillStack`／`filter`／`sort`／`view`／`icon`／`include`／`exclude`），提供 `activeRoot(pane) = drillRoot ?? roots[0] ?? null`、`rootForUri`、`effectiveView`、`resolvePaneDefinitions`、`classifySpaceRename`。**`getEnabledPaneIds()` 由 mode 決定**（tree→`['pane1']`、dual→`['pane1','pane2']`）。
- `spaces/paneRules.ts`：pane 純邏輯——`isPaneRootDirectory`、`paneSlotOf`、`childSlotOf`。
- `spaces/paneMenu.ts`：pane 選單純邏輯——`pane1MenuItems`、`pane2MenuItems`、`applyPane2MenuChoice`；選項使用穩定 id，UI 文字由 l10n 層提供。
- `spaces/workspaceRoots.ts`：`visibleWorkspaceRoots`，按隱藏清單過濾工作區根目錄。
- `spaces/legacySpaces.ts`：`clearLegacySpacesSetting`，啟動時清除舊 `codeFolderSpaces.spaces` 設定，避免其父 key 遮蔽新設定；不遷移舊值。
- `spaces/paneCascade.ts`：固定 pane1→pane2 連動（約 76 行）——僅 pane1 選取資料夾且在 `dual` 模式時切換 pane2 root；選檔不動；保留 debounce／generation 防競態／root 守門。
- `spaces/spaceTreeDataProvider.ts`：`TreeDataProvider<SpaceNode>`；以 `vscode.workspace.fs` 讀取目錄，`resourceUri` 驅動原生圖示／Git／問題裝飾；`findNodeByPath()` 供 `TreeView.reveal` 使用。F-42 的嵌套列舉與 `reveal` 父鏈解析也在此。
- `spaces/fileNesting.ts`：F-42 檔案嵌套的**純邏輯**（無 `vscode` 相依）——解析 `explorer.fileNesting.patterns`、展開 `$(capture)`／`${capture}`／`basename`／`extname`／`dirname`、指派同層子檔（單一父項、循環截斷）。設計見 `dev/specs/file-nesting-design.md`。
- `util/log.ts`：`LogOutputChannel` 封裝。
- `util/concurrency.ts`：保序併發 map helper，供目錄可見子項探測使用（S1-5）。
- `types.ts`：設定與節點型別。

## 關鍵技術決策（不可逕行推翻，需先更新 spec）

1. **使用原生 `TreeView` + `TreeDataProvider`，不嘗試 patch 內建 Explorer**。VS Code 沒有支援的 API 可注入節點到內建 Explorer 樹；參考專案（Explorer Enhanced、Secondary Explorer）皆採專屬 view。
2. **讀取用 `workspace.fs`，不用 `node:fs`**，以保留 remote／虛擬 FS 與 URI 語意；需要 `fsPath` 時明確轉換。
3. **檔案操作優先委派內建命令**（`revealInExplorer`、`revealFileInOS`、`copyFilePath`、`openInIntegratedTerminal`、`filesExplorer.*`、`git.*`），不重造輪子。
4. **`resourceUri` 必填**：原生檔案圖示、Git 裝飾、問題徽章都依賴它。
5. **無遠端程式碼**：所有相依在打包期 bundle 進 `.vsix`；`eval`／遠端載入一律禁止。
6. **`engines.vscode` 與 `@types/vscode` 對齊**，調整最低版本需同步 `CHANGELOG.md`。
7. **不使用 webview**：兩個原生 TreeView 的檢視組合由 `viewPresets.ts` 的底層維度（`mode`×`level`×`content`）支援。v2-R4 已完全移除 preset UI、Preset／Level／Content／Mode／Sort 命令與相關四項設定；`VIEW_PRESETS`／`matchPresetName` 僅保留為底層檢視組合來源，不是使用者可選的 preset 功能。pane1 與 pane2 可特化且不對稱。設計見 `dev/specs/folder-spaces-v2-redesign.md`（v2 §2.2、§10）與 `dev/specs/pane-cascade-and-presets-design.md`（歷史）。
8. **固定 2 pane（v2-redesign，2026-10-19 起；推翻原 S4R6-D60「8 pane／任意鏈結」）**：容器內只有 `pane1`（永遠存在）＋ `pane2`（僅 `dual` 模式顯示）。Tree 模式為單一 pane；Dual 模式為上下雙 pane，pane1 控制中心，pane2 僅提供基本操作且可與 pane1 使用不同檢視設定。移除 `parentPaneId`／pane link 模型／任意鏈結／插槽分配／成環防護。`getEnabledPaneIds()` 由 mode 決定；pane1 保留冷啟動可達條件，pane2 由 mode 控制。唯一持久化狀態為 `codeFolderSpaces.layout.v1`（`workspaceState`，無工作區退 `globalState`）；舊 `panes.v3`／`v2`／`v1` 靜默忽略且不刪除。舊設定 `codeFolderSpaces.spaces` 已從 manifest 移除，啟動時清除且不遷移；新來源為 `spaces.workspace`／`spaces.global`。Preset UI 與相關設定已於 v2-R4 移除，底層檢視組合仍保留。設計見 `dev/specs/folder-spaces-v2-redesign.md`（與 `pane-cascade-and-presets-design.md` 衝突時以 v2 spec 為準）。

## 指令與驗證

```bash
npm run typecheck       # tsc --noEmit
npm run test:unit       # vitest run
npm run build           # esbuild → dist/extension.js
npm run check:project   # 專案健康度、manifest 契約與 l10n bundle key 覆蓋
node scripts/check-command-parity.mjs # manifest command 與 handler 雙向一致性
npm run check           # 以上全部（含 check-command-parity）
npm run test:integration # 隔離 profile 啟動 VS Code 執行整合測試；優先使用本機安裝
npm run package:vsix    # production bundle + vsce package
```

Extension Development Host 實機驗證（由工作區根目錄）：

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
node .agents/skills/vscode-runtime-inspection/scripts/probe.mjs list
node .agents/skills/vscode-runtime-inspection/scripts/probe.mjs ext-eval "vscode.extensions.all.filter(e => e.id.includes('code-folder-spaces')).map(e => e.isActive)"
node tools/vscode-debug.mjs close
```

## 作業規範：每輪 handoff 前打包試用 VSIX（使用者 2026-10-14 指示）

- **每一輪完成 `/todo-handoff` 之前，必須執行一次 `npm run package:vsix`**，產出 `code-folder-spaces-<version>.vsix` 供使用者以「Install from VSIX」實機試用；Handoff 須記錄 VSIX 的檔名、時間、SHA256 與對應的 `dist/extension.js`（production）／產品 HEAD 與 working tree 狀態。
- 打包前先把根目錄既有 `.vsix` 移至 `out/vsix-archive/`，以 `code-folder-spaces-<version>-<yyyymmdd-hhmm>.vsix` 命名備份，**不覆蓋、不刪除**舊檔；根目錄永遠只保留最新一份。`*.vsix` 已被 `.gitignore` 排除，不入版控。
- 此打包**僅為試用**：不 bump 版本、不打 tag、不上傳，**不取代** pre-release gate；任何發布仍須依 `.agents/skills/pre-release-check/SKILL.md`。打包失敗須於 Handoff 揭露並不得宣稱已提供試用版。
- 純規劃／文件輪（無產品 runtime 或 manifest 變更）可在 Handoff 明載「無新產物、沿用前一份 VSIX」並附其 SHA256，不重打包。

## Definition of Done

- 每個 Stage：`npm run check` 全綠（typecheck + unit + build + check:project）。
- 使用者可見行為變更：必須在 Extension Development Host 實機驗證（載入空間、展開、指令、過濾），並留存證據（probe 輸出或截圖）。
- 涉及 `package.json` 貢獻點變更：核對 `contributes` 與實作一一對應、`package.nls.*` 對稱。
- 發布（tag／`vsce package`／上架）前：必須完成 `.agents/skills/pre-release-check/SKILL.md` 的 release gate。

## Known pitfalls

- **整合測試 profile 污染（2026-10-16 實例，S4.1R12a）**：同一台機器若 `.vscode-test/user-data` 殘留舊狀態、或有另一個 test／EDH instance 併行寫入，`npm run test:integration` 會出現大量（本次 57 筆）`Unable to write into user settings because the file has unsaved changes`／`because the content of the file is newer` 失敗並連鎖污染後續斷言。**處理**：先 `rm -rf .vscode-test/user-data .vscode-test/workspace-copy`（該目錄為測試專用且已 gitignore，與 `~/.vscode-debug` 的 EDH profile 無關、不含 SecretStorage），確認無殘留 test instance 後重跑；**不可據污染結果判定回歸**（該 failing 已確認並修正：測試自身未考慮 `drillDown` 會更新檢視狀態；清乾淨後最終為 97 passing／1 pending／0 failing，Worker B 加入 expandMode 測試後為 98 passing／1 pending／0 failing）。
- **TreeView 沒有分區點擊**：VS Code 不提供 chevron／名稱／背景的分區事件；`TreeItem.command` 是整列點擊。Obsidian 版的三段分流需改為 VS Code 語意（整列選取 + 右鍵／命令），詳見 `dev/specs/obsidian-folder-spaces-feature-review.md`。
- **`workbench.tree.expandMode` 是全域設定**：不要為了單一擴充套件行為擅自修改使用者設定；該類全域點擊行為設定不由擴充套件自動修改。
- **Pane view/title 命令不帶 view id**：pane-specific title action 必須使用 pane 專屬 command id（D47），不可猜測目前焦點 pane 並錯路由到 pane1。
- **Spaces 數量與窗格無關（v2 起）**：容器固定 `pane1`＋`pane2`（pane2 僅 Dual 模式），Spaces 清單數量不限且不影響窗格數。來源分別為工作區層 `spaces.workspace` 與 profile 層 `spaces.global`；舊 `codeFolderSpaces.spaces` 已移除並會於啟動時清除，絕不遷移。
- **檔案嵌套（file nesting）不會自動套用，已由 F-42 自行實作**：TreeView 不是內建 Explorer，故自行讀取 `explorer.fileNesting.enabled`／`patterns`／`expand`（無自有設定，S4R5-D53；`enabled` 預設 `false`）。實作在 `src/spaces/fileNesting.ts`（純邏輯）＋ `spaceTreeDataProvider`（接線），語意與已知限制見 `dev/specs/file-nesting-design.md`：僅同目錄兄弟檔、每個檔案最多一個父項（宣告順序首個匹配者勝出，S4R5-D54）、父模式可為**精確檔名**（0 個 `*`，內建預設 `package.json`／`tsconfig.json` 即此類，S4R5-D57；此類父項略過含 `${capture}` 的子模式）、`${extname}` **不含**前導點（對齊上游）、可遞迴且以 `parentOf` 祖先鏈防循環、路徑過濾啟用時停用嵌套（S4R5-D55）、巢狀父列以 `ThemeIcon('file')` 作 fallback（實測仍保留檔案圖示主題的專屬圖示，S4R5-D56 訂正）、平鋪預設集（Contents／Files／List）不套用、大小寫不敏感與否採**平台啟發式**（非上游 per-provider capability，逐目錄大小寫敏感或非 `file:` scheme 時可能不同）。`explorer.fileNesting.patterns` 的 Global／Workspace 值會與內建預設 patterns **合併**（未覆寫的預設 key 仍生效），寫測試時必須明確覆寫相關 key。**D 編號為輪次內註冊序號，跳輪引用須併記輪次（如 `S4R5-D53`）；編號基準見 `dev/specs/file-nesting-design.md` §3。**
- **Workspace Trust 與磁碟修改**：目前尚無修改磁碟的操作，因此尚無需 gating；S3 的 CRUD／拖放實作必須以 `vscode.workspace.isTrusted` 或 `when: isWorkspaceTrusted` 停用，`capabilities.untrustedWorkspaces` 描述已承諾此行為。`@vscode/test-electron` 固定以 `--disable-workspace-trust` 執行，使其整合測試為 trusted；restricted 行為須以 EDH probe 驗證，證據見 `dev/tests/s1-3-s1-4-runtime-evidence.md`。
- **工作區外的資料夾**：space 根可位於工作區外，`workspace.fs` 讀取及瀏覽／開檔已由 QA 實測可用。排除 glob 的 `**/` 已修正為可匹配零或多層目錄；`**/*.log` 可排除頂層及巢狀 `.log` 檔案。工作區外 watcher：實機 EDH（restricted）3/3 收到 `onDidCreate`（約 0.5–1.1 秒，工作區內對照組亦全收），故「受限模式會阻斷工作區外 watcher」不成立；惟先前 4.5 秒逾時**未能重現、成因未定**（不可逕認為單純時序問題）。整合 harness（test-cli，trusted）使用外部行程寫入檔案後，工作區外 watcher 與工作區內對照組均收到事件（S1-10）；restricted 模式仍以 EDH probe 取證。監看器與檔案操作仍須注意權限，且不應假設 `workspaceFolders` 涵蓋外部根。
- **glob 子集邊界**：支援 `*`、`**`、`**/`（可匹配零層）、`?` 與字元跳脫；未支援 brace `{a,b}` 與 character class `[abc]`。`src/**` 不匹配目錄本身（僅其下內容）。
- **大型目錄**：展開時各可見子目錄的可見子項探測採保序併發上限 16；S1-5 實測（Windows 本機 FS、1,500 子目錄各 1 檔與 3,000 頂層檔）單層展開中位數由 979 ms 降至 312 ms（約 68%）；逐次數據見 `dev/tests/s1-5-large-directory-measurement.md`。本輪不加快照／快取：尚無產品延遲目標可判定 312 ms 是否超標，且快取會增加失效一致性負擔；若後續目標或量測顯示有需要，再於 S4 F-44 評估。
- **大型樹時間排序成本**：S2R1 實測 4,501 節點的 `mtime` 排序中位數約 1.37 秒（三次 1,370.4／2,144.3／1,123.6 ms）；依 `stat` 併發上限 16，並以每次 refresh 的 URI 備忘錄去重，沒有持久快取。無排序的展開本身約 330 ms；此量測不代表其他檔案系統或硬體的效能。
- **檔案操作 undo 範圍**：undo 僅支援此工作階段內成功的 move／rename；記錄只存在記憶體，擴充套件重載即清空，不屬於 VS Code 編輯器 undo。create／delete 不支援 undo，move／rename 的 undo 遇到來源或目標衝突會拒絕而不覆寫。命令式 Move To 與 F-31 TreeView 拖放共用同一 undo stack。
- **move 防護限制**：`isSafeMove` 僅做詞法路徑比較，不解析 realpath；symlink／junction 若指向來源祖先，理論上可能繞過目錄移入自身／子目錄的防護。
- **垃圾桶能力**：VS Code `FileSystemProvider` 沒有通用 trash capability API。當啟用 `files.enableTrash` 時，本擴充僅對 `file:` URI 呼叫 `workspace.fs.delete({ useTrash: true })`；其他 scheme 一律拒絕刪除以避免 provider 忽略選項後靜默永久刪除。file provider 的實際垃圾桶行為仍由平台／VS Code 決定，刪除確認依 `explorer.confirmDelete` 設定保留。
- **檔案系統更名 vs 空間設定**：監聽更名事件時自動遷移每空間檢視狀態；空間根更名會標記定義 stale。設定僅在使用者明確點擊更新動作後才寫回，避免靜默修改版控中的工作區設定；空間根內子路徑更名只改寫狀態中對應路徑。`workspace.fs.rename` 的 provider／OS 實作可能限制跨磁碟區搬移；移動失敗會保留 undo 記錄與來源狀態，不提供跨磁碟複製刪除 fallback。

- **窗格（pane）模型（v2-redesign 起）**：容器內固定 **`pane1`＋`pane2`** 兩個原生 TreeView，**不再支援 8 pane、任意 root 鏈結、一父多子、插槽重用**。pane2 僅在 `mode: dual` 顯示，其父永遠是 pane1。**`View: Move View`** 仍可讓使用者把 pane 移到次要側邊欄／面板（位置跨 session 記憶，擴充套件不代勞）。關閉 pane2 ＝回到 `tree` 模式（`pane.remove`／`pane.close`）；**pane1 不可關閉**（`Folder Space 1 cannot be closed.`）——這是 v2 的刻意限制，取代舊「任一窗格皆可關閉」。
- **狀態與持久化**：唯一狀態為 `codeFolderSpaces.layout.v1`（`{version:1, mode, primary, secondary}`），存 `workspaceState`、無工作區時退 `globalState`。舊 `panes.v3`／`v2`／`v1` 靜默忽略且不刪除。對當前 mode 不存在的 pane，store 呼叫靜默 no-op；測試操作 pane2 前先 `setMode('dual')`。
- **任意根與守門**：窗格 root 可為**任意資料夾**（不限 `spaces`）。檔案操作、`switchRoot` 與 cascade 的允許根守門以**該窗格自身 root** 為界（S4R6-D67）；檔案監看器以**窗格 root** 為單位建立（同 root 跨窗格去重）。`resolvePaneDefinition()` 僅在 root 命中某 space 時沿用其 **`icon`**；label 一律為「命中 space 的 `name` ?? root basename」，pane 不再有 `name` 欄位。`showFiles`／`include`／`exclude` **一律取窗格自身值**（space 值只在**建立窗格時複製**一次），否則使用預設（D70）；設定編輯**不回寫**既有窗格。
- **Pane cascade 與 `activateChild`（v2-R6／R7）**：Dual 模式下 pane1 選取**資料夾**才會把 pane2 root 切到該資料夾，選取檔案不動（`paneCascade.ts` 固定 pane1→pane2，100ms debounce＋generation 防競態）。**pane2 沒有自己的 root 切換命令**（`pane2.switchRoot` 已於 v2-R6 移除），其 root 只由 cascade 或 `pane1.activateChild` 決定。**`activateChild` 語意（v2-R7 使用者界定的權威定義）**：把 pane1 選取的資料夾設為 pane2 root——選資料夾→用自身、選檔案→用父目錄、無選取→退回 pane1 的 `activeRoot`；只出現在 `mode == dual` 的 pane1 標題列（`navigation@1`），取代已刪除的 `pane1.adoptChild`。Follow Workspace Directory 只同步 pane1 roots。
- **Dual 模式的 drill 不對稱（v2-R7）**：`pane1.drillUp` 的 `when` 含 `codeFolderSpaces.mode == tree`——Dual 下 pane1 不顯示 Return to Parent；`pane1.mode.dual` 在 `setMode('dual')` **之前**先 `resetRoot('pane1')`，故切入 Dual 時 pane1 退回原 roots，pane2 的 drill 狀態保留。`pane2.drillUp` 恆存在（`navigation@0`），**不要**再加 `mode == tree` 條件（v2-R6 S5a 曾因此誤刪造成回歸）。
- **pane2 的檢視切換（v2-R7）**：`pane2.toggleNested`（巢狀↔扁平）是 pane2 唯一的檢視命令，位於子選單 `codeFolderSpaces.pane2.view`；pane1 **不再有** `toggleNested`。進入 Dual 時 `pane1.mode.dual` 會把 pane2 view 設回 `VIEW_PRESETS.Contents`，使用者的扁平／巢狀選擇只在該次 Dual session 內有效（cascade 只換 root、不改 view）。
- **子選單勾號必須寫在 `menus`（v2-R7 真 bug）**：`contributes.commands[].toggled` **只影響 Command Palette**；子選單／右鍵選單的勾號要寫在 `contributes.menus[<submenuId>][].toggled`，同一命令兩處都要寫。`check-project.mjs` 已強制「submenu 項目必須有 `toggled`」。目前 submenus 3 個（`pane1.view`／`pane1.sort`／`pane2.view`）。
- **i18n 與檢查邊界（S5R1～S5R2／F-51）**：目前 pane 選單與主要操作以 `vscode.l10n.t()` 顯示，英／繁中 catalog key、placeholder 與 manifest 引用由 `check:project` 檢查；仍不會自動發現所有未包 l10n 的 UI 字面值，需人工盤點。S5R1 英文與 S5R2 真實 zh-tw（隔離繁中語言套件）實機證據見 `dev/tests/s5r1-acceptance-evidence.md`、`s5r2-acceptance-evidence.md`。

- **VS Code 設定 key 父子遮蔽**：設定 key `a.b` 可能影響 `a.b.c` 的讀取。舊 `codeFolderSpaces.spaces` 曾遮蔽 `codeFolderSpaces.spaces.workspace`／`.global`；舊 key 必須在 activate 時主動清除，不能只從 manifest 移除。
- **TreeItem.description 不解析 codicon**：例如 `$(globe)` 會以原字串呈現；需要標記時使用 Unicode 字元。
- **QuickPickItem 沒有 `disabled` 屬性**：不可選項應從 QuickPick items 直接排除。
- **EDH 驗證前先建置**：`dist/extension.js` 不會自動重建；執行 EDH 前必須 `npm run build`，否則可能驗到舊 bundle。
- **整合測試前清理 `out/integration/`**：`esbuild.tests.mjs` 不會刪除舊 bundle；先移除該測試輸出再執行，避免載入舊測試程式。
- **大量刪除命令須跑 parity 檢查**：孤兒 handler 與沒有 handler 的 manifest command 不一定產生錯誤訊息；執行 `node scripts/check-command-parity.mjs` 驗證雙向一致性。
