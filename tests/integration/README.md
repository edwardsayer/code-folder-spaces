# Integration tests

`tests/integration/` 保留給 Extension Development Host 內執行的整合測試（`@vscode/test-cli` / `@vscode/test-electron` + Mocha），用來驗證真實的 VS Code 行為：view 註冊、TreeView 展開／reveal、檔案監看、Workspace Trust 限制、指令執行等。

規劃內容與 Stage 安排見私有規劃目錄：

- `dev/planning/implementation-plan.md`
- `dev/planning/TODO.md`

現階段（Stage 0 scaffold）僅有 `tests/unit/` 的純邏輯測試；整合測試於 Stage 1 建立第一個可用空間樹後導入。
