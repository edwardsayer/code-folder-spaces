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
- `spaces/viewState.ts`：**每窗格檢視狀態**（`codeFolderSpaces.panes.v2`：`root`／`preset`／`filter`／`sort`／`drillStack`／`parentPaneId`／`follow`／`name`／`icon`／`showFiles`／`include`／`exclude`）與 v1→v2 遷移；插槽分配（`allocatePaneId`）、啟用／關閉（`enablePane`／`disablePane`）與 `resolvePaneDefinition`（per-pane 定義）。
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
7. **不使用 webview**：Files pane 的清單效果由檢視預設集（Files／Contents／List 扁平清單）達成，以維持單一 pane cascading chaining 的產品特色。設計見 `dev/specs/pane-cascade-and-presets-design.md`。
8. **Pane = 獨立的 Folder Space（S4R6-D60；原「Linked spaces = 上下堆疊」已修訂）**：最多 8 個原生 TreeView 窗格堆疊於同一容器；**每個窗格擁有自己的 root（可為任意資料夾）、檢視狀態與顯示設定**，`codeFolderSpaces.spaces` 僅為「可選根清單＋新窗格預設值來源」。父子鏈以 `parentPaneId`＋`follow` 連動（子窗格跟隨父窗格選取的資料夾；手動換根為暫時覆寫，父下次選不同資料夾即恢復跟隨）。採固定 view 插槽 `codeFolderSpaces.pane1..8` + `when` context key（VS Code 無法執行期新增 view）；窗格狀態存 `codeFolderSpaces.panes.v2`。設計見 `dev/specs/pane-cascade-and-presets-design.md` §2.4（S4R6-D60–D74）。

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
- **Pane view/title 命令不帶 view id**：pane-specific title action 必須使用 pane 專屬 command id（D47），不可猜測目前焦點 pane 並錯路由到 pane1。
- **超過八個 spaces**：依 S4R1 暫定政策，僅前八個 space 有專屬 pane；其餘保留於設定但無專屬 pane，後續可評估空間切換器／分頁。
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

- **窗格（pane）模型與限制（S4R6）**：最多 **8 個窗格**——VS Code 無執行期新增 view 的 API，同 id 僅一個實例；要提高上限只能改 manifest 發新版。容器內窗格**垂直堆疊且順序由 manifest 宣告序決定**（擴充套件無法程式化重排；**重用中間空出的插槽時，新窗格會出現在該編號的位置**）；使用者可用內建 `View: Move View`／拖曳把窗格移到次要側邊欄、面板或浮動視窗（位置跨 session 記憶，`View: Reset View Locations` 還原），擴充套件**不代勞**（未公開的 `vscode.moveViews` 不採用）。`pane1` **不可關閉**（至少保留一個窗格）；關閉窗格 N 時其子窗格重掛到 N 的父，維持 `parentIndex < childIndex` 不變式。
- **窗格狀態與遷移**：檢視狀態歸宿為**每窗格一份**（`codeFolderSpaces.panes.v2`，key 為 `pane1..8`），不再有 `bySpace`。所有以 paneId 為 key 的 store 呼叫對「不存在的窗格」是**靜默 no-op**（寫測試時必須先 `enablePane` 再操作，勿以路徑當 key）。v1→v2 遷移保留既有已啟用窗格數（不自動補齊）；`codeFolderSpaces.panes.count` 僅決定**新工作區初始值**。
- **任意根與守門**：窗格 root 可為**任意資料夾**（不限 `spaces`）。檔案操作、`switchRoot` 與 cascade 的允許根守門以**該窗格自身 root** 為界（S4R6-D67）；檔案監看器以**窗格 root** 為單位建立（同 root 跨窗格去重）。`resolvePaneDefinition()` 在 root 命中某 space 時沿用其 `name`／`icon`／`showFiles`／`include`／`exclude`，否則用窗格自身值／root basename／預設（D70）；設定編輯**不回寫**既有窗格。
- **跟隨（follow）語意**：`follow === true` 時子窗格 root 隨父窗格焦點改變；**手動在子窗格換根是允許的暫時覆寫**（不自動關閉 follow），父窗格下次選取不同資料夾時子窗格再次跟隨（父焦點為最終權威，D61/D74）。`expectedRoot` 抑制只吸收自身寫入的回聲。
- **已知 i18n 缺口（非 S4R6 引入）**：`paneN.menu` 的 QuickPick 選項標籤（`Refresh`／`Toggle follow`／`Set root`／`Add child pane`／`Close pane` 等）為**未包 `vscode.l10n.t()` 的英文字面值**；`check:project` 只掃描字面 `vscode.l10n.t(...)`，故不會攔截。待 i18n 輪（F-51）統一處理。
