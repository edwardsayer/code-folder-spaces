# Folder Spaces for VS Code

**資料夾範圍的檔案總管空間。** 將任意資料夾釘選為獨立的專注空間，只瀏覽你在乎的內容，不再被整個工作區的雜訊淹沒。

> **狀態：早期骨架（v0.0.1）。** 目前提供設定模型、專屬 Activity Bar 檢視、資料夾範圍樹狀檢視（可選顯示檔案）、include/exclude 過濾、重新整理與顯示目前檔案指令。檢視模式、就地下鑽、拖放與檔案操作將在後續 Stage 實作。

## 為什麼需要

VS Code 內建 Explorer 永遠顯示整個工作區。當 repo 包含多個專案、套件或封存資料夾時，找到真正在意的那個資料夾會變得緩慢且吵雜。Folder Spaces 讓每個資料夾擁有自己的專注樹狀檢視——同一個工作區，更小的上下文。

本專案是 Obsidian 外掛 [Folder Spaces](https://github.com/edwardsayer/obsidian-folder-spaces) 的 VS Code 對應版本，依 VS Code Extension API 與 Marketplace 規範重新設計。

## 目前功能

- **資料夾空間**：可設定任意數量的資料夾，各自成為專屬 Activity Bar 檢視中的根節點。
- **路徑變數**：`${workspaceFolder}`、`${workspaceFolders[N]}`、`${userHome}`。
- **每個空間的選項**：自訂名稱、圖示、是否顯示檔案、include/exclude glob。
- **原生樹狀體驗**：檔案圖示、Git 裝飾與問題徽章透過 `resourceUri` 原生呈現。
- **即時更新**：每個空間各自的遞迴檔案監看器。
- **指令**：新增空間、移除空間、重新整理、顯示目前檔案。

## 規劃中

- 樹狀／扁平檢視模式、展開層級與內容過濾（純資料夾／純檔案）。
- 具名檢視預設集（Explorer、Navigate、Columns、Context、Contents、Files、List）。
- 就地下鑽與返回堆疊；根目錄切換與行內重新命名。
- 完整右鍵操作（新增檔案／資料夾、重新命名、刪除、在 OS 顯示、在終端機開啟、複製路徑）。
- 空間之間拖放，支援操作復原（undo）。
- 連動空間（linked spaces）：預設上下兩個相同的 pane（上為父、下為子）互相連動，形成串接鏈——本產品的招牌互動。清單效果由檢視預設集（Files／Contents／List 扁平清單）達成，不使用 webview。
- 完整中英文在地化。

## 已知限制

- **Glob 子集**：支援 `*`、`**`、`**/`（可匹配零層目錄）、`?` 與字元跳脫；不支援 brace pattern（`{a,b}`）與字元類別（`[abc]`）；`src/**` 不匹配 `src` 目錄本身。
- **受限模式（Restricted Mode）**：瀏覽、展開與開啟檔案可用；尚未實作會修改磁碟的操作，未來 CRUD 與拖放將於未受信任工作區停用（Stage 3）。
- **單一 pane**：目前僅有一個 pane；多 pane（上限 8）與 linked spaces 規劃於 Stage 4（F-47／F-40）。
- **工作區支援**：不支援虛擬工作區；remote 情境尚未驗證。
- **大型目錄**：可見子項探測併發上限為 16；尚未加入快取，將於 Stage 4（F-44）評估。
- **工作區外資料夾**：可作為空間根目錄；讀取與監看已實測。

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
