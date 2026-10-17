# Folder Spaces for VS Code

**資料夾範圍的檔案總管空間。** 將任意資料夾釘選為獨立的專注空間，只瀏覽你在乎的內容，不再被整個工作區的雜訊淹沒。

> **狀態：早期開發版（v0.0.1）。** Folder Spaces 提供專屬 Activity Bar 檢視，內含最多八個**獨立資料夾空間**（每個資料夾空間都有自己的根：自己的根、預設集、過濾、排序與下鑽堆疊），可父子串接連動；另含檢視預設集、就地下鑽、檔案嵌套、拖放與檔案操作。已知限制見下方。

## 為什麼需要

VS Code 內建 Explorer 永遠顯示整個工作區。當 repo 包含多個專案、套件或封存資料夾時，找到真正在意的那個資料夾會變得緩慢且吵雜。Folder Spaces 讓每個資料夾擁有自己的專注樹狀檢視——同一個工作區，更小的上下文。

本專案是 Obsidian 外掛 [Folder Spaces](https://github.com/edwardsayer/obsidian-folder-spaces) 的 VS Code 對應版本，依 VS Code Extension API 與 Marketplace 規範重新設計。

## 目前功能

- **資料夾空間**：可設定任意數量的資料夾，各自成為專屬 Activity Bar 檢視中的根節點。
- **獨立資料夾空間**：最多八個資料夾空間堆疊在 Folder Spaces 檢視中。**每個資料夾空間都有自己的狀態**——自己的根目錄（可為**任何資料夾**，不限已設定的空間）、檢視預設集、路徑過濾、排序、下鑽堆疊、名稱／圖示與 include/exclude。`Folder Spaces：啟用子資料夾空間` 會以選取的資料夾為根建立子資料夾空間並鏈結到父資料夾空間。
- **完整資料夾空間**：一個資料夾空間可持有**多個根目錄**（如同多根工作區）。「新增資料夾到資料夾空間...」會把資料夾附加到目前資料夾空間；每個根目錄列都有行內 ✕ 可「從資料夾空間移除資料夾」（**只移除該資料夾，絕不會關閉資料夾空間**）。根目錄共用該資料夾空間的預設集、過濾與排序；下鑽一次只作用於一個根目錄。
- **對齊內建 Explorer**：只有**單一**根目錄時不顯示根目錄列，直接列出該資料夾的第一層——與 VS Code 內建 Explorer 相同。有多個根目錄時，每個根各顯示為可展開的一列。
- **點擊行為對齊（選擇加入）**：確認後，`對齊點擊行為` 會將視窗級樹狀檢視設定改為雙擊展開。此設定影響本視窗所有樹（包含內建檔案總管）；可用 `重設點擊行為` 還原先前值。
- **跟隨工作區資料夾**：第一個資料夾空間預設跟隨目前的工作區／專案資料夾（`codeFolderSpaces.followWorkspaceDirectory`）。開啟多根工作區時，該資料夾空間會把每個工作區資料夾顯示為一個根目錄；關閉後由您自行管理根目錄（可在資料夾空間的「…」選單新增／移除）。
- **連動資料夾空間（接龍鏈）**：開啟 follow 的子資料夾空間會跟隨父資料夾空間選取的資料夾；關閉 follow 即完全獨立；在子資料夾空間手動切換根目錄是允許的，該值會持續到父資料夾空間下次選取不同資料夾。
- **檢視預設集**：七種具名預設集（Explorer、Navigate、Columns、Context、Contents、Files、List），涵蓋樹狀／扁平模式、展開層級與資料夾／檔案內容過濾。
  - 扁平預設集：**Files**／**List** 為第一級清單，項目名稱是自資料夾空間根目錄起的完整相對路徑；**Contents** 第一層為資料夾（以相對路徑命名，根目錄直屬檔案歸入 `.`），第二層為該資料夾的檔案（僅顯示檔名）。
- **導覽**：就地下鑽與返回堆疊、根目錄切換、資料夾空間標題列操作（收合全部／展開一層切換、過濾、返回上層，以及含預設集、排序與資料夾空間管理的 ⋯ 選單）。
- **路徑變數**：`${workspaceFolder}`、`${workspaceFolders[N]}`、`${userHome}`。
- **每個空間的選項**：自訂名稱、圖示、是否顯示檔案、include/exclude glob（作為由該空間建立之資料夾空間的預設值）。
- **原生樹狀體驗**：檔案圖示、Git 裝飾與問題徽章透過 `resourceUri` 原生呈現。
- **檔案嵌套**：在空間樹中把子檔掛到父檔之下，語意跟隨內建 `explorer.fileNesting.enabled`／`patterns`／`expand` 設定（本擴充直接讀取，無需額外設定）。
- **即時更新**：每個資料夾空間根目錄各自的遞迴檔案監看器。
- **指令**：新增資料夾空間、新增／移除資料夾空間的資料夾、啟用子資料夾空間、設定資料夾空間根目錄、重新整理、顯示目前檔案、重設檢視插槽配置。
- **檔案操作**：新增檔案／資料夾、重新命名、刪除、移動、右鍵操作（委派內建命令）、資料夾空間間拖放、工作階段限定的剪下／複製／貼上，剪下與移動可復原。開啟檔案預設使用目前編輯器群組，也可設定在旁邊開啟。

## 規劃中

- 快速開啟入口：Explorer 右鍵選單（`explorer/context`「Add to Folder Spaces」）。
- 可選的空間分組／tags。
- CI（含 Linux xvfb 整合測試）與 Marketplace 發布素材（PNG icon、截圖、repository 欄位）。

## 已知限制

- **Glob 子集**：支援 `*`、`**`、`**/`（可匹配零層目錄）、`?` 與字元跳脫；不支援 brace pattern（`{a,b}`）與字元類別（`[abc]`）；`src/**` 不匹配 `src` 目錄本身。
- **剪貼簿與拖放復原**：空間內部拖放＝移動（可復原）；外部拖入＝複製（不可復原）。剪下／移動操作共用工作階段 undo 堆疊；複製出的檔案／資料夾不支援復原。Ctrl+C/X/V、Ctrl+N、F2、Delete 與 Ctrl+Z 僅在 Folder Spaces 樹狀檢視取得焦點時生效。
- **檢視插槽數量與位置**：最多 **八個**檢視插槽（VS Code 要求 view 必須靜態宣告，沒有執行期新增 view 的 API）。檢視在 Folder Spaces 檢視內**垂直堆疊**且順序由 manifest 決定；你可以自行用內建 `View: Move View`／拖曳把任一檢視移到次要側邊欄、面板或浮動視窗，`View: Reset View Locations` 可還原。
- **資料夾空間模型**：每個資料夾空間保有自己的檢視狀態；`codeFolderSpaces.spaces` 只是「可選根目錄清單」（以及新資料夾空間的預設值來源），不再是資料夾空間顯示內容的定義。
- **工作區支援**：不支援虛擬工作區；remote 情境尚未驗證。
- **大型目錄**：可見子項探測併發上限為 16；尚未加入快取。
- **工作區外資料夾**：可作為空間根目錄；讀取與監看已實測。
- **檔案嵌套**：跟隨 `explorer.fileNesting.enabled`／`patterns`／`expand`，因此內建 Explorer 未啟用嵌套時也不會生效。只比對同一目錄的兄弟檔，每個檔案最多嵌套在一個父項之下（依 pattern 宣告順序首個匹配者勝出）；支援無 `*` 的精確檔名父模式（如內建預設的 `package.json`／`tsconfig.json`，這類父項會略過含 `${capture}` 的子模式）；路徑過濾啟用時會停用嵌套。大小寫是否不敏感依平台判定（Windows／macOS），非逐目錄大小寫設定。扁平預設集（Contents／Files／List）不受影響。

實作層細節請見 `AGENTS.md` 的 Known pitfalls 段落。

## 開發

```bash
npm install
npm run check          # typecheck + unit tests + build + 專案健康度檢查
npm run watch          # esbuild watch
npm run package:vsix   # production bundle + vsce package
```

以 `Run Extension`（F5）或工作區偵錯啟動器在本機執行：

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
```

## 設定

```jsonc
{
  "codeFolderSpaces.spaces": [
    "${workspaceFolder}/src",
    {
      "path": "${workspaceFolder}/docs",
      "name": "Documentation",
      "icon": "book",
      "showFiles": true,
      "exclude": ["archive/**"]
    }
  ],
  "codeFolderSpaces.view.showFiles": true
}
```

## 授權

MIT — 見 [LICENSE](LICENSE)。
