/**
 * 從外部重設某個 pane 的 root（v22-R7+，使用者 2026-10-26 指示）。
 *
 * ## 為什麼需要這個模組
 *
 * 「root 被外部換掉」有兩條路徑——pane cascade（在 pane1 選資料夾）與
 * `Activate Child Space`（點資料夾列的 inline 按鈕）。兩者都必須讓舊的下鑽堆疊作廢，
 * 否則 pane2 的 root 已是新目錄，但標題列的 `Return to Parent` 仍在，按下去會跳到
 * 與目前 root 無關的舊路徑。
 *
 * 資料層的 `LayoutStore.switchRoot()` 本身就會 `clearDrill()`，實際漏掉的是
 * **context key**：`codeFolderSpaces.<pane>.canDrillUp` 只在 `syncContext()` 更新，
 * 而 cascade 當時只呼叫 `syncPaneContexts()`，所以按鈕殘留（只有 cascade 看得出來，
 * `Activate Child Space` 因為另外呼叫了 `syncContext()` 而正常）。
 *
 * 把順序綁在這裡，是為了讓「少呼叫 syncContext」變成可被單元測試捕捉的回歸，
 * 而不是只能靠實機目視。
 */

export interface ExternalPaneRootDeps {
  /** 換掉 root（實作需保證清空下鑽堆疊）。 */
  switchRoot(paneId: string, root: string): Promise<void>;
  /** 清掉該 pane 的展開狀態快取。 */
  resetExpansion(paneId: string): void;
  /** 重新套用該 pane 的 scope／定義。 */
  applyScope(paneId: string): void;
  /** 依新的 root 重建檔案監看器。 */
  rebuildWatchers(): void;
  /** 重繪該 pane。 */
  refresh(paneId: string): void;
  /** 同步 per-pane context（enabled／hasRoot／canRemoveRoot…）。 */
  syncPaneContexts(): Promise<void>;
  /** 重繪父 pane 的鏈結列。 */
  refreshParentLinkRow(): void;
  /**
   * 同步全域與 per-pane 的 context key。
   * **必須呼叫**：`canDrillUp` 只在這裡更新，漏掉它 `Return to Parent` 就會殘留。
   */
  syncContext(): Promise<void>;
}

/**
 * 套用一次「外部來源」的 pane root 變更。順序即為契約：
 * 換 root → 清快取 → 重套 scope → 重建監看 → 重繪 → 同步兩種 context。
 */
export async function applyExternalPaneRoot(
  deps: ExternalPaneRootDeps,
  paneId: string,
  root: string
): Promise<void> {
  await deps.switchRoot(paneId, root);
  deps.resetExpansion(paneId);
  deps.applyScope(paneId);
  deps.rebuildWatchers();
  deps.refresh(paneId);
  await deps.syncPaneContexts();
  deps.refreshParentLinkRow();
  await deps.syncContext();
}
