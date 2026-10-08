# 整合測試

整合測試使用 `@vscode/test-cli` 在 VS Code Extension Development Host 中執行，驗證啟用／view 註冊與空間樹 provider 的真實 `vscode` 設定及 `workspace.fs` 行為。

## 執行

```bash
npm run test:integration
```

命令先建置擴充套件與測試 bundle，再啟動 desktop 測試。測試產物及 test-electron profile 位於專案內 `.vscode-test/`，不會修改或刪除 `~/.vscode`、`~/.vscode-debug` 等使用者 profile。其餘測試僅透過 `ConfigurationTarget.Global` 設定測試值，並在每例結束後還原；`trust.test.ts` 另會寫入 Workspace 範圍，並以原始位元組還原，使 fixture 內容恆回 `{}`。

## VS Code 選擇與 fixture

`.vscode-test.mjs` 優先採用 `VSCODE_EXE` 或平台預設本機安裝路徑；找到即使用本機 VS Code。未找到時，test-electron 會依 `VSCODE_TEST_VERSION` 下載指定版本，預設為 `stable`。本機 `fromPath` 模式不校驗擴充套件宣告的最低 VS Code 版本，正式版本矩陣留待 S5 CI。

`fixtures/workspace/` 是測試 Extension Host 開啟的固定工作區，含 alpha、beta 與 logs 範例樹；logs 只放會被 exclude 的 `.log` 檔案，用於測試無可見子項目的目錄狀態。

## 測試界線

- `activation.test.ts` 驗證擴充套件 API、命令與 view 的 Extension API 註冊證據，不代表視覺 UI 驗收。
- `spaceTree.test.ts` 自行建構 `SpaceStore` 與 `SpaceTreeDataProvider`，驗證樹根、展開排序、include／exclude、檔案顯示、名稱與路徑 reveal 語意。這個 provider 與 activation 建立的實例互不干擾。
- `trust.test.ts` 驗證 SpaceStore 在有工作區時寫入 Workspace 範圍，測試以暫存路徑操作，並在 `finally` 還原原有 workspace/global 設定；同時確認重複新增為 no-op。
- `outsideWorkspaceRoot.test.ts` 以系統暫存目錄驗證工作區外根的 provider 樹節點、排序、exclude 與路徑解析；測試結束會清理暫存根。

## trust 與工作區外根

`@vscode/test-electron` 的 `node_modules/@vscode/test-electron/out/runTest.js` 固定傳入 `--disable-workspace-trust`，因此整合測試 Extension Host 是 trusted，`trust.test.ts` 以 `vscode.workspace.isTrusted === true` 明確記錄此限制。受限模式無法由本自動化套件涵蓋，須透過 Extension Development Host（EDH）probe 手動取證，結果見 `dev/tests/s1-3-s1-4-runtime-evidence.md`。

工作區外根的自動化涵蓋 `workspace.fs` provider 讀取／樹節點、排序與篩選、`findNodeByPath`。排除使用單一 `**/*.log` pattern 驗證頂層及巢狀檔案。watcher 診斷由外部行程建立工作區外與工作區內檔案，最多等候 20 秒；這些測試不代表 restricted 模式，受限模式的 watcher 與瀏覽／開檔實機證據見 EDH probe 報告。測試設定會還原 workspace/global 值，不在 committed fixture 留下設定變更。watcher 案例會在工作區 fixture 根建立 `watcher-*.txt` 並於 `finally` 刪除；若 Extension Host 崩潰可能殘留未追蹤檔，需人工刪除。

## 已知平台行為／限制

實測 VS Code 1.140 對已註冊 view id 再呼叫 `createTreeView` 不會拋錯，因此不可用重複建立是否拋錯作為 view 註冊證據。本輪以 manifest 契約及可查得的 view focus 命令作 API 級檢查；這不是實際渲染證明。view 的 DOM 渲染證據屬 S1-7 實機驗收（probe CLI），本輪不涵蓋。

## 失敗排查

1. 確認已安裝專案既有 devDependencies，並從專案根目錄執行命令。
2. 本機 VS Code 無法啟動時，檢查 `VSCODE_EXE` 指向可執行檔；也可清除該變數讓 test-electron 下載穩定版，或設定 `VSCODE_TEST_VERSION`。
3. 若測試找不到 fixture，確認 `tests/integration/fixtures/workspace/` 存在且未移動測試輸出目錄；錯誤會列出實際解析路徑。
4. 啟動或下載失敗時查看終端完整輸出；不要清除或修改使用者 VS Code profile。
