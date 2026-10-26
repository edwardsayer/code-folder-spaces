# Folder Spaces for VS Code

**專注於資料夾範圍的 VS Code 檔案導覽。**

Folder Spaces 在專屬的 Activity Bar 容器中加入一個或兩個原生樹狀檢視，讓你只在自己關心的資料夾內工作，不受整個工作區的雜訊干擾。它使用標準的 `TreeView`：原生檔案圖示、Git 裝飾、問題徽章、檔案操作與 `workspace.fs` 支援全部保留。

[English](README.md) · [简体中文](README.zh-CN.md) · [更新記錄](CHANGELOG.md)

![Tree 模式：單一窗格顯示兩個資料夾 root](assets/screenshots/tree-mode.png)

> **版本 0.1.0。** 支援兩種版面：**Tree**（單一窗格）與 **Dual**（上下兩個窗格）。從 v1.x 升級前請先閱讀[與 v1.x 的重大變更](#與-v1x-的重大變更)。

## 為什麼使用 Folder Spaces

VS Code 內建的 Explorer 一律呈現整個工作區。Folder Spaces 讓你專注於選定的資料夾——必要時還可同時專注**第二個**資料夾——而且一切維持原生行為。

## Tree 模式

Tree 模式只有一個窗格。每個設定的 root 都是一列最上層項目，可以同時顯示多個 root。

- 面板標題為容器標題 **Folder Spaces**，不設定 description。
- 每個資料夾列右側固定有兩個 inline 按鈕：**就地下鑽**與**啟用子空間**。
- 標題列提供**全部收合／展開層級**、**依路徑過濾／清除過濾**，以及 `…` 選單（**雙窗格**、**排序**、**新增資料夾到空間…**、**重新整理**、**工作區資料夾…**）。

## Dual 模式

![Dual 模式：上方 Spaces、下方 Files](assets/screenshots/dual-mode.png)

Dual 模式上下堆疊兩個窗格：

| | **Spaces**（pane1） | **Files**（pane2） |
|---|---|---|
| 角色 | 控制中心 | 次要清單 |
| 標題列 | 全部收合／展開層級、過濾、`…` 選單 | 檢視模式、過濾、`…` 選單 |
| Root | 所有已設定的 root | 只顯示由 pane1 連動而來的資料夾 |
| 可否關閉 | 不可 | 可；關閉後回到 Tree 模式 |

- 標題隨內容變化：pane1 有多個 root 且未下鑽時顯示 **Spaces**，否則顯示路徑最後一段；pane2 顯示目前資料夾。
- 在 pane1 選取**資料夾**會讓 pane2 進入該資料夾（選取檔案不會）。
- 資料夾列的**啟用子空間**會把該資料夾設為 pane2 的 root，必要時自動開啟 Dual 模式。
- pane1 與 pane2 各自記住自己的檢視與排序設定。

### Files 窗格的三種檢視模式

Files 窗格的**檢視模式**按鈕會依序循環：

| 模式 | 按鈕 | 顯示內容 |
|---|---|---|
| Explorer（預設） | `$(list-tree)` | 局部原生樹，支援就地下鑽與資料夾端點圖示 |
| File List | `$(list-flat)` | 只列第一層檔案 |
| Nested File List | `$(layers)` | 所有層級的檔案，攤平呈現 |

![Explorer 模式](assets/screenshots/pane2-explorer.png)
![File List 模式](assets/screenshots/pane2-filelist.png)
![Nested File List 模式](assets/screenshots/pane2-nested-list.png)

### 雙窗格具備可見性感知

`Dual Pane`／`Dual Pane ✓` 在**兩個**窗格都有，且反映畫面上實際可見的狀態：

- 兩窗格皆可見且模式為 Dual → 選單顯示 **Dual Pane ✓**；點擊會關閉 Files 並回到 Tree。
- 任一個窗格在容器選單中被隱藏 → 剩下的窗格顯示未勾選的 **Dual Pane**；點擊會解除隱藏並召回缺少的窗格。
- 點擊標題列折疊窗格**不等於**關閉：窗格仍然存在，再點一次就會展開。

## 選單與勾號

![窗格標題選單](assets/screenshots/pane-menu.png)

有狀態的項目以成對命令＋**尾綴 ✓** 呈現（例如 `Dual Pane ✓`），因為 VS Code 不為擴充套件選單渲染原生勾號。

![排序子選單](assets/screenshots/sort-submenu.png)

**排序**子選單提供名稱／修改時間／建立時間的遞增與遞減，兩個窗格各自記住選擇。容器的 `…` 選單列出檢視（**Spaces**、**Files**），可分別隱藏。

![容器選單列出兩個檢視](assets/screenshots/title-menu.png)

## 過濾

![套用過濾後的樹與符合數](assets/screenshots/filter-mode.png)

**依路徑過濾…** 對窗格套用路徑子字串過濾，並顯示 `n / m matches` 計數與 inline 的**清除過濾**按鈕。`include`／`exclude` 支援的 glob 子集包含 `*`、`**`、`**/`、`?` 與字元跳脫；不支援 brace `{a,b}` 與 character class `[abc]`。

## 空間 root 的來源

root 刻意分成三個來源：

1. **工作區根** — 自動來自目前的 VS Code 工作區，可用**工作區資料夾…**隱藏或還原。
2. **`codeFolderSpaces.spaces.workspace`** — 專案層清單，寫入 `.vscode/settings.json` 或 `.code-workspace` 檔案。
3. **`codeFolderSpaces.spaces.global`** — profile 層清單，存於使用者 `settings.json`，在該 profile 的每個視窗都顯示，並標記 **🌐**。

在 root 上使用**標記為全域**／**取消全域**即可在專案清單與全域清單之間移動。設定是 per-profile 的，其他 profile 需要各自設定（或使用 Settings Sync）。

## 檔案操作

![Root 右鍵選單：標記為全域與檔案操作](assets/screenshots/context-menu.png)

- 新增、改名、刪除、移動、拖放，以及本次工作階段內的移動／改名 undo。
- 修改磁碟的命令受 Workspace Trust 管制：工作區尚未受信任時一律停用。
- 啟用 `files.enableTrash` 時，`file:` URI 的刪除會走垃圾桶；其他 scheme 一律拒絕而非永久刪除。
- 檔案監看器會即時更新窗格，包含工作區外的資料夾。

## 設定

| 設定 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `codeFolderSpaces.spaces.workspace` | array | `[]` | 專案／工作區層 root；項目可為路徑字串或物件。 |
| `codeFolderSpaces.spaces.global` | array | `[]` | Profile 層 root（**標記為全域**的目標）；只寫使用者設定。 |
| `codeFolderSpaces.followActiveFile` | boolean | `true` | 跟隨目前編輯器中的檔案。 |
| `codeFolderSpaces.maxDepth` | integer (1–100) | `10` | 扁平清單列舉的最大資料夾深度。 |
| `codeFolderSpaces.followWorkspaceDirectory` | boolean | `true` | 讓 pane1 的工作區 root 與工作區資料夾同步；已設定與全域 root 會保留並附加在後。 |
| `codeFolderSpaces.defaultPreset.singlePane` | string | `Explorer` | 切換到 Tree 模式時使用的檢視。 |
| `codeFolderSpaces.defaultPreset.dualPane.pane1` | string | `Navigate` | 進入 Dual 模式時 Spaces 使用的檢視。 |
| `codeFolderSpaces.defaultPreset.dualPane.pane2` | string | `Explorer` | 進入 Dual 模式時 Files 使用的檢視。 |

root 項目可為路徑字串，或含 `path`、`name`、`icon`、`showFiles`、`include`、`exclude` 的物件。路徑支援 `${workspaceFolder}`、`${workspaceFolders[N]}`、`${userHome}`。

```jsonc
{
  "codeFolderSpaces.spaces.workspace": [
    "${workspaceFolder}/src",
    {
      "path": "${workspaceFolder}/docs",
      "name": "Documentation",
      "icon": "book",
      "showFiles": true,
      "exclude": ["archive/**"]
    }
  ],
  "codeFolderSpaces.spaces.global": ["${userHome}/notes"]
}
```

## 常用命令

多數窗格操作位於標題列、`…` 選單、**排序**子選單或右鍵選單，並刻意從命令面板隱藏。

- **就地下鑽**、**啟用子空間** — pane1 每個資料夾列的 inline 按鈕。
- **新增資料夾到空間…** — 單一可搜尋選單，含最近資料夾與**瀏覽資料夾…**；也可直接輸入路徑。
- **移除 Root**、**工作區資料夾…**、**重新整理**。
- **雙窗格**／**雙窗格 ✓**、**關閉窗格**。
- **全部收合**、**展開層級**、**依路徑過濾…**、**清除過濾**、**返回上層**。
- **檢視模式** — Files 窗格：Explorer／File List／Nested File List。
- **標記為全域**、**取消全域**。
- **開啟工作區**、**在新視窗開啟工作區** — `.code-workspace` 列的 inline 按鈕。

目前 manifest 貢獻 **86** 個命令，全部由命令 parity 檢查覆蓋。

## 檔案嵌套

檔案嵌套依 VS Code 自身的 `explorer.fileNesting.enabled`、`patterns`、`expand` 設定運作。僅套用於同目錄的兄弟檔，每個檔案最多一個父項，且路徑過濾啟用時停用嵌套。請注意 Global 與 Workspace 範圍的 `explorer.fileNesting.patterns` 會與內建預設值**合併**。

## 已知限制

- pane1 不可關閉；關閉 pane2 會回到 Tree 模式。
- glob 為子集（`*`、`**`、`**/`、`?`、跳脫）；`src/**` 不匹配 `src` 目錄本身。
- 移動防護採詞法路徑比較，不解析 symlink。
- 不支援虛擬工作區；遠端環境尚未完整驗證。
- 窗格標題受 VS Code 原生 `text-transform: capitalize` 影響，擴充套件無法覆寫。

## 與 v1.x 的重大變更

0.1.0 版以固定的 **Tree** 與 **Dual** 版面取代舊的多窗格／preset 模型，移除舊 `codeFolderSpaces.spaces` 設定且**不遷移**其值，同時移除 preset 控制項與多項設定。完整清單見 [CHANGELOG.md](CHANGELOG.md)。

## 開發

```bash
npm install
npm run check          # typecheck、單元測試、build、專案檢查與命令 parity
npm run watch          # esbuild watch
npm run package:vsix   # production bundle + vsce package
```

按 F5（**Run Extension**）或載入到隔離視窗：

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
```

## 授權

MIT — 見 [LICENSE](LICENSE)。
