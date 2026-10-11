# Folder Spaces for VS Code

**資料夾範圍的檔案總管空間。** 將任意資料夾釘選為獨立的專注空間，只瀏覽你在乎的內容，不再被整個工作區的雜訊淹沒。

> **狀態：早期開發版（v0.0.1）。** Folder Spaces 提供專屬 Activity Bar 檢視，內含最多八個**獨立窗格**（每個窗格本身就是一個資料夾空間：自己的根、預設集、過濾、排序與下鑽堆疊），可父子串接連動；另含檢視預設集、就地下鑽、檔案嵌套、拖放與檔案操作。已知限制見下方。

## 為什麼需要

VS Code 內建 Explorer 永遠顯示整個工作區。當 repo 包含多個專案、套件或封存資料夾時，找到真正在意的那個資料夾會變得緩慢且吵雜。Folder Spaces 讓每個資料夾擁有自己的專注樹狀檢視——同一個工作區，更小的上下文。

本專案是 Obsidian 外掛 [Folder Spaces](https://github.com/edwardsayer/obsidian-folder-spaces) 的 VS Code 對應版本，依 VS Code Extension API 與 Marketplace 規範重新設計。

## 目前功能

- **資料夾空間**：可設定任意數量的資料夾，各自成為專屬 Activity Bar 檢視中的根節點。
- **獨立窗格（pane）**：最多八個窗格堆疊在 Folder Spaces 檢視中。**每個窗格本身就是完整的資料夾空間**——自己的根（可為**任何資料夾**，不限已設定的空間）、檢視預設集、路徑過濾、排序、下鑽堆疊、名稱／圖示與 include/exclude。`Folder Spaces：在此開啟子窗格` 會以選取的資料夾為根建立子窗格並鏈結到父窗格。
- **連動窗格（接龍鏈）**：開啟 follow 的子窗格會跟隨父窗格選取的資料夾；關閉 follow 即完全獨立；在子窗格手動切換根目錄是允許的，該值會持續到父窗格下次選取不同資料夾。
- **檢視預設集**：七種具名預設集（Explorer、Navigate、Columns、Context、Contents、Files、List），涵蓋樹狀／扁平模式、展開層級與資料夾／檔案內容過濾。
- **導覽**：就地下鑽與返回堆疊、根目錄切換、窗格標題列操作（顯示目前檔案、收合全部、展開一層、切換模式）。
- **路徑變數**：`${workspaceFolder}`、`${workspaceFolders[N]}`、`${userHome}`。
- **每個空間的選項**：自訂名稱、圖示、是否顯示檔案、include/exclude glob（作為由該空間建立之窗格的預設值）。
- **原生樹狀體驗**：檔案圖示、Git 裝飾與問題徽章透過 `resourceUri` 原生呈現。
- **檔案嵌套**：在空間樹中把子檔掛到父檔之下，語意跟隨內建 `explorer.fileNesting.enabled`／`patterns`／`expand` 設定（本擴充直接讀取，無需額外設定）。
- **即時更新**：每個窗格根目錄各自的遞迴檔案監看器。
- **指令**：新增／移除空間、新增／移除窗格、在此開啟子窗格、設定窗格根目錄、重新整理、顯示目前檔案、重設窗格配置。
- **檔案操作**：新增檔案／資料夾、重新命名、刪除、移動、右鍵操作（委派內建命令）、窗格間拖放、工作階段限定的剪下／複製／貼上，剪下與移動可復原。開啟檔案預設使用目前編輯器群組，也可設定在旁邊開啟。

## 規劃中

- multi-root／remote 情境的資料夾空間，以及快速開啟入口（`explorer/context`「Add to Folder Spaces」）。
- 可選的空間分組／tags。
- CI（含 Linux xvfb 整合測試）與 Marketplace 發布素材（PNG icon、截圖、repository 欄位）。

## 已知限制

- **Glob 子集**：支援 `*`、`**`、`**/`（可匹配零層目錄）、`?` 與字元跳脫；不支援 brace pattern（`{a,b}`）與字元類別（`[abc]`）；`src/**` 不匹配 `src` 目錄本身。
- **剪貼簿與拖放復原**：空間內部拖放＝移動（可復原）；外部拖入＝複製（不可復原）。剪下／移動操作共用工作階段 undo 堆疊；複製出的檔案／資料夾不支援復原。Ctrl+C/X/V、Ctrl+N、F2、Delete 與 Ctrl+Z 僅在 Folder Spaces 樹狀檢視取得焦點時生效。
- **窗格數量與位置**：最多 **八個**窗格（VS Code 要求 view 必須靜態宣告，沒有執行期新增 view 的 API）。窗格在 Folder Spaces 檢視內**垂直堆疊**且順序由 manifest 決定；你可以自行用內建 `View: Move View`／拖曳把任一窗格移到次要側邊欄、面板或浮動視窗，`View: Reset View Locations` 可還原。
- **窗格模型**：每個窗格保有自己的檢視狀態；`codeFolderSpaces.spaces` 只是「可選根目錄清單」（以及新窗格的預設值來源），不再是窗格顯示內容的定義。
- **工作區支援**：不支援虛擬工作區；remote 情境尚未驗證。
- **大型目錄**：可見子項探測併發上限為 16；尚未加入快取。
- **工作區外資料夾**：可作為空間或窗格根目錄；讀取與監看已實測。
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
