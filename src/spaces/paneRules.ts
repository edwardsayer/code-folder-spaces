export type PaneSlotName = 'primary' | 'secondary';

/** 目錄型態由檔案系統旗標判斷。 */
export function isPaneRootDirectory(fileType: number, directoryType: number): boolean {
  return (fileType & directoryType) !== 0;
}

/** pane1 對應 primary，其餘插槽對應 secondary。 */
export function paneSlotOf(paneId: string): PaneSlotName {
  return paneId === 'pane1' ? 'primary' : 'secondary';
}

/** secondary 沒有子插槽，primary 的固定子插槽為 secondary。 */
export function childSlotOf(slot: PaneSlotName): PaneSlotName | null {
  return slot === 'primary' ? 'secondary' : null;
}


/**
 * v2-R6：判斷 `drillDown` 是否為 no-op。
 *
 * **必須只看 `drillRoot`**，不可用 `activeRoot`（= `drillRoot ?? roots[0]`）：
 * 多 root 時 `activeRoot` 會回 `roots[0]`，導致「對第一個 root 下鑽」被誤判為
 * 「已在該根」而擋掉（使用者 2026-10-20 回報：pane1 同時顯示兩個 root 時，
 * 第一個 root 無法 drill down）。
 */
export function isDrillDownNoop(drillRoot: string | null, target: string, samePath: (a: string, b: string) => boolean): boolean {
  return drillRoot !== null && samePath(drillRoot, target);
}
