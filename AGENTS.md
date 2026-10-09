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

- `extension.ts`：`activate()` 進入點。建立 `SpaceStore`、`SpaceTreeDataProvider`、`TreeView`，註冊指令與檔案監看器，回傳公開 API（`version`、`getSpaces()`）。
- `spaces/spaceConfig.ts`：**純邏輯**（無 `vscode` 相依）——設定正規化、變數插值、glob 比對。所有可單元測試的邏輯放這裡。
- `spaces/spaceStore.ts`：`codeFolderSpaces.spaces` 設定的讀寫封裝與變更事件；寫入目標為 Workspace（有工作區時）或 Global。
- `spaces/spaceTreeDataProvider.ts`：`TreeDataProvider<SpaceNode>`；以 `vscode.workspace.fs` 讀取目錄，`resourceUri` 驅動原生圖示／Git／問題裝飾；`findNodeByPath()` 供 `TreeView.reveal` 使用。
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
7. **不使用 webview**：Files pane 的清單效果由檢視預設集（Files／Contents／List 扁平清單）達成，以維持單一 pane cascading chaining 的產品特色。設計見 `dev/specs/pane-cascade-and-presets-design.md`。
8. **Linked spaces = 多個原生 TreeView pane 上下堆疊**：預設上下兩個相同 pane（上父下子）互相連動；採固定 view 插槽 `codeFolderSpaces.pane1..8` + `when` context key（VS Code 無法執行期新增 view）。

## 指令與驗證

```bash
npm run typecheck       # tsc --noEmit
npm run test:unit       # vitest run
npm run build           # esbuild → dist/extension.js
npm run check:project   # 專案健康度、manifest 契約與 l10n bundle key 覆蓋
npm run check           # 以上全部
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

## Definition of Done

- 每個 Stage：`npm run check` 全綠（typecheck + unit + build + check:project）。
- 使用者可見行為變更：必須在 Extension Development Host 實機驗證（載入空間、展開、指令、過濾），並留存證據（probe 輸出或截圖）。
- 涉及 `package.json` 貢獻點變更：核對 `contributes` 與實作一一對應、`package.nls.*` 對稱。
- 發布（tag／`vsce package`／上架）前：必須完成 `.agents/skills/pre-release-check/SKILL.md` 的 release gate。

## Known pitfalls

- **TreeView 沒有分區點擊**：VS Code 不提供 chevron／名稱／背景的分區事件；`TreeItem.command` 是整列點擊。Obsidian 版的三段分流需改為 VS Code 語意（整列選取 + 右鍵／命令），詳見 `dev/specs/obsidian-folder-spaces-feature-review.md`。
- **`workbench.tree.expandMode` 是全域設定**：不要為了單一擴充套件行為擅自修改使用者設定；若要做，必須是明確 opt-in。
- **檔案嵌套（file nesting）不會自動套用**：TreeView 不是內建 Explorer，`explorer.fileNesting.*` 需自行實作（參考 Secondary Explorer 的做法）。
- **Workspace Trust 與磁碟修改**：目前尚無修改磁碟的操作，因此尚無需 gating；S3 的 CRUD／拖放實作必須以 `vscode.workspace.isTrusted` 或 `when: isWorkspaceTrusted` 停用，`capabilities.untrustedWorkspaces` 描述已承諾此行為。`@vscode/test-electron` 固定以 `--disable-workspace-trust` 執行，使其整合測試為 trusted；restricted 行為須以 EDH probe 驗證，證據見 `dev/tests/s1-3-s1-4-runtime-evidence.md`。
- **工作區外的資料夾**：space 根可位於工作區外，`workspace.fs` 讀取及瀏覽／開檔已由 QA 實測可用。排除 glob 的 `**/` 已修正為可匹配零或多層目錄；`**/*.log` 可排除頂層及巢狀 `.log` 檔案。工作區外 watcher：實機 EDH（restricted）3/3 收到 `onDidCreate`（約 0.5–1.1 秒，工作區內對照組亦全收），故「受限模式會阻斷工作區外 watcher」不成立；惟先前 4.5 秒逾時**未能重現、成因未定**（不可逕認為單純時序問題）。整合 harness（test-cli，trusted）使用外部行程寫入檔案後，工作區外 watcher 與工作區內對照組均收到事件（S1-10）；restricted 模式仍以 EDH probe 取證。監看器與檔案操作仍須注意權限，且不應假設 `workspaceFolders` 涵蓋外部根。
- **glob 子集邊界**：支援 `*`、`**`、`**/`（可匹配零層）、`?` 與字元跳脫；未支援 brace `{a,b}` 與 character class `[abc]`。`src/**` 不匹配目錄本身（僅其下內容）。
- **大型目錄**：展開時各可見子目錄的可見子項探測採保序併發上限 16；S1-5 實測（Windows 本機 FS、1,500 子目錄各 1 檔與 3,000 頂層檔）單層展開中位數由 979 ms 降至 312 ms（約 68%）；逐次數據見 `dev/tests/s1-5-large-directory-measurement.md`。本輪不加快照／快取：尚無產品延遲目標可判定 312 ms 是否超標，且快取會增加失效一致性負擔；若後續目標或量測顯示有需要，再於 S4 F-44 評估。
- **大型樹時間排序成本**：S2R1 實測 4,501 節點的 `mtime` 排序中位數約 1.37 秒（三次 1,370.4／2,144.3／1,123.6 ms）；依 `stat` 併發上限 16，並以每次 refresh 的 URI 備忘錄去重，沒有持久快取。無排序的展開本身約 330 ms；此量測不代表其他檔案系統或硬體的效能。
- **檔案操作 undo 範圍**：undo 僅支援此工作階段內成功的 move／rename；記錄只存在記憶體，擴充套件重載即清空，不屬於 VS Code 編輯器 undo。create／delete 不支援 undo，move／rename 的 undo 遇到來源或目標衝突會拒絕而不覆寫。命令式 Move To 是 F-32 的 undo 覆蓋；F-31 TreeView 拖放仍屬 S3R2。
- **檔案系統更名 vs 空間設定**：監聽更名事件時自動遷移每空間檢視狀態；空間根更名會標記定義 stale。設定僅在使用者明確點擊更新動作後才寫回，避免靜默修改版控中的工作區設定；空間根內子路徑更名只改寫狀態中對應路徑。`workspace.fs.rename` 的 provider／OS 實作可能限制跨磁碟區搬移；移動失敗會保留 undo 記錄與來源狀態，不提供跨磁碟複製刪除 fallback。

