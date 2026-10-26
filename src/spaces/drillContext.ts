/**
 * `codeFolderSpaces.<pane>.canDrillUp` context key 的計算（v22-R7+）。
 *
 * ## 為什麼要抽出來
 *
 * 這個 key 決定 pane 標題列是否顯示 `Return to Parent`。它只在 `syncContext()` 更新，
 * 而「從外部換 root」的路徑（pane cascade）早期只呼叫 `syncPaneContexts()`，
 * 導致 pane2 root 已換成新目錄、`Return to Parent` 卻仍在。
 *
 * 缺陷本體在 context key，不在 store（`LayoutStore.switchRoot()` 本來就會 `clearDrill()`）。
 * 因此把「給定 pane 狀態 → canDrillUp 該是什麼」變成純函式，
 * 讓回歸可以直接被單元測試鎖住，而不必依賴實機目視或無法讀值的 context key。
 */

/** 只取計算所需的欄位，避免與 UI 型別耦合。 */
export interface DrillContextState {
  drillStack: readonly unknown[];
}

/**
 * `canDrillUp` 的唯一真相：**只**看下鑽堆疊是否非空。
 *
 * 不可以改用 `drillRoot != null`：`drillUp` 在堆疊清空時會把 `drillRoot` 設回 `null`，
 * 但殘留的 `drillRoot` 也可能在未同步時存在，兩者語意不同（見 `AGENTS.md` pitfalls
 * 「判定『下鑽中』需 drillRoot != null && drillStack.length > 0」）。
 */
export function canDrillUp(state: DrillContextState | undefined): boolean {
  return Boolean(state && state.drillStack.length > 0);
}
