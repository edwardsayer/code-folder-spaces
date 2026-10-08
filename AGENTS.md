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
npm run check:project   # 專案健康度與 manifest 契約
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
- **工作區外的資料夾**：space 根可位於工作區外，`workspace.fs` 讀取及瀏覽／開檔已由 QA 實測可用。排除 glob 有已知缺陷 F-R3-1：目前 `**/*.log` 不匹配頂層相對路徑 `skip.log`，須同時用 `*.log` 覆蓋頂層檔案；待 S1-9 修正。工作區外 watcher：實機 EDH（restricted）3/3 收到 `onDidCreate`（約 0.5–1.1 秒，工作區內對照組亦全收），故「受限模式會阻斷工作區外 watcher」不成立；惟先前 4.5 秒逾時**未能重現、成因未定**（不可逕認為單純時序問題）。整合 harness（test-cli，trusted）兩次各 15 秒仍未收到事件、原因未盤清（F-R3-2／S1-10），該案例以 skipped 保留，不宣稱 harness 能驗證此行為。監看器與檔案操作仍須注意權限，且不應假設 `workspaceFolders` 涵蓋外部根。
