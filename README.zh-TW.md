# Folder Spaces for VS Code

![Icon](assets/icon.png)

**專注於資料夾範圍的 VS Code 檔案導覽。** Folder Spaces 提供一個或兩個原生樹狀檢視，專注瀏覽你要處理的資料夾，不受整個工作區的雜訊干擾。

> **版本 0.1.0。** Folder Spaces 提供兩種版面：**Tree**（單一窗格）與 **Dual**（上下兩個窗格）。兩個窗格刻意採不對稱設計，且可各自特化。從 v1.x 升級前請先閱讀[重大變更](#與-v1x-的重大變更)。

## 為什麼使用 Folder Spaces

VS Code 內建 Explorer 一律呈現整個工作區。Folder Spaces 讓你專注瀏覽選定資料夾，同時保留原生檔案圖示、Git 裝飾、問題徽章、檔案操作及工作區檔案系統支援。

## Tree 與 Dual 模式

- **Tree** 僅顯示 pane1 的單一資料夾樹。
- Tree 模式的面板標題會顯示 workspace／專案資料夾名稱（多個 root 時加上 `+ n`），沒有開啟資料夾時顯示 **Global**。
- **Dual** 顯示上下排列的 pane1 與 pane2。pane1 是控制中心：可透過標題列操作與**Dual Pane** 切換項與原生 **Sort:** 子選單管理版面、根目錄、工作區資料夾、排序及其他導覽。pane2 的選單較精簡，只提供基本操作（巢狀檔案清單切換、過濾、收合／展開、重新整理及關閉）。
- 代表目前狀態的選單項目會加上**尾綴 ✓**：pane1 的 **Dual Pane** 與 **Sort:** 子選單，以及 pane2 的 **Toggle Nested Files**（VS Code 未提供擴充套件原生勾號 API，故標記是標題的一部分；放在文字之後，標題起點不會被推擠）。
- pane2 預設是扁平的**第一層檔案清單**；按標題列的 **Toggle Nested Files** 會展開為所有層級的檔案（仍是扁平清單）。
- 兩個窗格刻意設計為**可特化且不對稱**；pane2 並非完整複製 pane1 的控制項。pane1 不可關閉；關閉 pane2 會回到 Tree 模式。
- 在 Dual 模式中，pane1 選取資料夾會讓 pane2 導覽至該資料夾。pane2 沒有自己的根目錄切換器，其根目錄來自上述連動（`Activate Child Space` 命令仍保留，但不再顯示於標題列）。
- 由於 Dual 讓 pane1 成為導覽來源，pane1 在 Dual 模式不顯示**返回上層**，且從 Tree 切到 Dual 時會退回原設定的根目錄；pane2 則保留自己的下鑽狀態與**返回上層**。

## 空間根目錄來源

資料夾根目錄有三種來源：

1. **工作區根目錄**會自動取自目前 VS Code 工作區。可從空間清單隱藏，並透過 pane1 選單還原。
2. **`codeFolderSpaces.spaces.workspace`** 是專案／工作區層級清單，適合與專案共用的根目錄。
3. **全域根目錄**存於標準 user settings（`codeFolderSpaces.spaces.global`，即該 profile 的 `settings.json`），在**同一 profile 的任何工作區／視窗**都看得到，並以 **🌐** 標記。注意 VS Code 各 profile 的設定互相隔離，其他 profile 需要各自設定（或使用 Settings Sync）。

在空間根目錄的右鍵選單使用 **Mark as Global**，可將該根目錄從工作區清單移至全域清單；使用 **Unmark Global** 可移回。此操作會變更根目錄的來源；🌐 標記代表它屬於 profile 層級清單。

每個項目可使用路徑字串，或包含 `path`、`name`、`icon`、`showFiles`、`include` 與 `exclude` 的物件。路徑支援 `${workspaceFolder}`、`${workspaceFolders[N]}` 與 `${userHome}`。

## 功能

- 在 Folder Spaces 活動列容器中使用一或兩個原生 TreeView。
- 根目錄切換、多根目錄、過濾、就地下鑽與重新整理。
- 可自動跟隨工作區資料夾，或隱藏工作區根目錄。
- 檔案嵌套依循 VS Code 的 `explorer.fileNesting.enabled`、`patterns` 與 `expand` 設定。
- 透過資源 URI 顯示原生檔案圖示、Git 裝飾及問題徽章。
- 新增檔案、重新命名、刪除、移動、拖放，以及工作階段限定的移動復原。
- 即時檔案系統更新，並支援工作區外資料夾。

## 設定

| 設定 | 型別 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `codeFolderSpaces.spaces.workspace` | array | `[]` | 專案／工作區層級的空間根目錄清單；項目可為路徑或物件。 |
| `codeFolderSpaces.spaces.global` | array | `[]` | 全域根目錄（由 **Mark as Global** 寫入；user 設定層級、各 profile 獨立）。 |
| `codeFolderSpaces.spaces.workspace` | array | `[]` | 專案根目錄：一般資料夾寫入該專案的 `.vscode/settings.json`；以 `.code-workspace` 開啟時寫入 workspace 檔案（**Unmark Global** 的目標）。 |
| `codeFolderSpaces.followActiveFile` | boolean | `true` | 在空間樹中跟隨目前作用中的編輯器檔案。 |
| `codeFolderSpaces.maxDepth` | integer（1–100） | `10` | 扁平清單列舉資料夾時使用的最大深度。 |
| `codeFolderSpaces.followWorkspaceDirectory` | boolean | `true` | 讓 pane1 根目錄與工作區資料夾保持同步；設定值中的根目錄（含全域）會保留並接在工作區根目錄之後。 |

範例：

```jsonc
{
  "codeFolderSpaces.spaces.workspace": [
    "${workspaceFolder}/src",
    {
      "path": "${workspaceFolder}/docs",
      "name": "文件",
      "icon": "book",
      "showFiles": true,
      "exclude": ["archive/**"]
    }
  ],
  "codeFolderSpaces.spaces.global": ["${userHome}/notes"]
}
```

## 常用命令

窗格專屬操作位於各窗格的標題列、子選單與右鍵選單；大部分刻意不在命令選擇區顯示。常用操作包括：

- **Drill Into Folder**／**Activate Child Space**（pane1 每個資料夾列右側的 inline 按鈕；Activate Child Space 會在需要時開啟 Dual，並把該資料夾設為 pane2 root）
- **Add Folder to Space…**／**Remove Root**（新增資料夾到空間／移除根目錄）
- **Dual Pane**／**Dual Pane ✓**（pane1 選單；依狀態擇一顯示，點擊在 Tree 與 Dual 間切換）
- **Collapse All**／**Expand Level**（pane1 標題列；未選取時展開每個 root 的下一層，選取 root 時只展開該 root 的下一層）
- **Filter by Path…**／**Clear Filter**／**Return to Parent**（過濾／清除／返回上層）
- **Refresh**（重新整理）
- **Open Workspace**／**Open Workspace in New Window**（任何 pane 的 `.code-workspace` 檔案列 inline 按鈕）
- **Toggle View Mode**（pane2 標題列：Explorer／File List／Nested File List 檢視模式循環）
- **Mark as Global**／**Unmark Global**（空間根目錄右鍵選單）

目前 manifest 共提供 85 個命令。

## 與 v1.x 的重大變更

0.1.0 以固定 Tree／Dual 版面取代舊有多窗格／預設集模型；移除舊 `codeFolderSpaces.spaces` 設定且不遷移舊值，並移除預設集控制項及數項設定。升級前請先閱讀 [CHANGELOG.md](CHANGELOG.md) 的完整清單。

## 已知限制

- pane1 不可關閉；關閉 pane2 會回到 Tree 模式。
- Dual 模式中，pane2 預設為局部 **Explorer** 樹狀模式（支援就地下鑽與按需延遲載入），並可透過標題列 **Toggle View Mode** 按鈕循環切換為 **File List**（第一層檔案）或 **Nested File List**（所有層級檔案）。
- 工作區根目錄可隱藏，但來源仍是目前 VS Code 工作區。
- Glob 支援 `*`、`**`、`**/`、`?` 與跳脫字元；不支援 brace pattern 與字元類別。`src/**` 不匹配 `src` 目錄本身。
- 檔案嵌套只比對同目錄兄弟檔，每個檔案最多指派給一個父項；啟用路徑過濾時會停用嵌套。
- 可見子項探測併發上限為 16；尚未實作持久快取。
- 不支援虛擬工作區；遠端環境尚未完整驗證。

## 開發

```bash
npm install
npm run check          # 型別檢查、單元測試、建置、專案檢查及命令一致性檢查
npm run watch          # esbuild watch
npm run package:vsix   # production bundle + vsce package
```

使用 F5（`Run Extension`）或以下指令在本機執行：

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
```

## 授權

MIT — 見 [LICENSE](LICENSE)。
