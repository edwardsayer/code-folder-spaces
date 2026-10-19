export type PaneSlotName = 'primary' | 'secondary';

/** 相容投影型別（原 paneLinks.PaneLinkState 的等價定義；R4 隨 linkStatusBar 一併移除）。 */
export interface PaneLinkState { root: string | null; parentPaneId: string | null; follow: boolean; }

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

/** 將固定的 primary/secondary 佈局投影為舊 pane link 形狀。 */
export function fixedPaneLinks(
  rootOf: (paneId: string) => string | null,
  mode: 'tree' | 'dual',
): Record<string, { root: string | null; parentPaneId: string | null; follow: boolean }> {
  const links = { pane1: { root: rootOf('pane1'), parentPaneId: null, follow: false } };
  if (mode === 'dual') return { ...links, pane2: { root: rootOf('pane2'), parentPaneId: 'pane1', follow: true } };
  return links;
}

function paneNumber(id: string): number {
  const match = /^pane([1-8])$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export function describePaneLinkEdgeGroups(
  links: Record<string, { parentPaneId: string | null; follow: boolean }>,
): Array<{ parentPaneIndex: number; childPaneIndexes: number[]; allFollow: boolean }> {
  const grouped = new Map<number, Array<{ index: number; follow: boolean }>>();
  for (const [childId, link] of Object.entries(links)) {
    if (!link.parentPaneId) continue;
    const parent = paneNumber(link.parentPaneId);
    const child = paneNumber(childId);
    if (!parent || !child) continue;
    const children = grouped.get(parent) ?? [];
    children.push({ index: child, follow: link.follow });
    grouped.set(parent, children);
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([parentPaneIndex, children]) => ({
    parentPaneIndex,
    childPaneIndexes: children.map(child => child.index).sort((a, b) => a - b),
    allFollow: children.every(child => child.follow),
  }));
}
