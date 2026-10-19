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

