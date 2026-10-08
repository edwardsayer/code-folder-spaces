# 整合測試

整合測試使用 `@vscode/test-cli` 在 VS Code Extension Development Host 中執行，驗證啟用／view 註冊與空間樹 provider 的真實 `vscode` 設定及 `workspace.fs` 行為。

## 執行

```bash
npm run test:integration
```

命令先建置擴充套件與測試 bundle，再啟動 desktop 測試。測試產物及 test-electron profile 位於專案內 `.vscode-test/`，不會修改或刪除 `~/.vscode`、`~/.vscode-debug` 等使用者 profile。測試設定只透過 `ConfigurationTarget.Global` 設定測試值，並在每例結束後還原；fixture 的 `.vscode/settings.json` 固定為 `{}`。

## VS Code 選擇與 fixture

`.vscode-test.mjs` 優先採用 `VSCODE_EXE` 或平台預設本機安裝路徑；找到即使用本機 VS Code。未找到時，test-electron 會依 `VSCODE_TEST_VERSION` 下載指定版本，預設為 `stable`。本機 `fromPath` 模式不校驗擴充套件宣告的最低 VS Code 版本，正式版本矩陣留待 S5 CI。

`fixtures/workspace/` 是測試 Extension Host 開啟的固定工作區，含 alpha、beta 與 logs 範例樹；logs 只放會被 exclude 的 `.log` 檔案，用於測試無可見子項目的目錄狀態。

## 測試界線

- `activation.test.ts` 驗證擴充套件 API、命令與 view 的 Extension API 註冊證據，不代表視覺 UI 驗收。
- `spaceTree.test.ts` 自行建構 `SpaceStore` 與 `SpaceTreeDataProvider`，驗證樹根、展開排序、include／exclude、檔案顯示、名稱與路徑 reveal 語意。這個 provider 與 activation 建立的實例互不干擾。
- 本輪不測 workspace 範圍設定寫入、watcher、Workspace Trust、工作區外根；這些屬於 S1-3／S1-4 範圍。測試絕不寫入 workspace 設定。

## 已知平台行為／限制

實測 VS Code 1.140 對已註冊 view id 再呼叫 `createTreeView` 不會拋錯，因此不可用重複建立是否拋錯作為 view 註冊證據。本輪以 manifest 契約及可查得的 view focus 命令作 API 級檢查；這不是實際渲染證明。view 的 DOM 渲染證據屬 S1-7 實機驗收（probe CLI），本輪不涵蓋。

## 失敗排查

1. 確認已安裝專案既有 devDependencies，並從專案根目錄執行命令。
2. 本機 VS Code 無法啟動時，檢查 `VSCODE_EXE` 指向可執行檔；也可清除該變數讓 test-electron 下載穩定版，或設定 `VSCODE_TEST_VERSION`。
3. 若測試找不到 fixture，確認 `tests/integration/fixtures/workspace/` 存在且未移動測試輸出目錄；錯誤會列出實際解析路徑。
4. 啟動或下載失敗時查看終端完整輸出；不要清除或修改使用者 VS Code profile。
