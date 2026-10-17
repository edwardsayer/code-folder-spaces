const MAX_PANE_COUNT = 8;

/** Minimal chain shape both `PaneLinkState` views and full `PaneState` records satisfy. */
type PaneChainEntry = { parentPaneId: string | null };
type PaneFollowEntry = PaneChainEntry & { follow: boolean };

/** True when assigning childPaneId to parentPaneId violates the pane chain; only a newly allocated id (absent from state) makes a new cycle impossible, never an empty root. */
export function wouldCreateCycle(links: Record<string, PaneChainEntry>, parentPaneId: string, childPaneId: string): boolean {
  const parentIndex = paneIndex(parentPaneId);
  const childIndex = paneIndex(childPaneId);
  if (parentIndex < 1 || childIndex < 1 || parentPaneId === childPaneId) return true;
  const visited = new Set<string>();
  let current: string | null = parentPaneId;
  while (current) {
    if (current === childPaneId || visited.has(current)) return true;
    visited.add(current);
    current = links[current]?.parentPaneId ?? null;
  }
  const ancestors = visited.size;
  let descendants = 0;
  current = childPaneId;
  while (true) {
    const next = Object.entries(links).find(([, link]) => link.parentPaneId === current)?.[0];
    if (!next) break;
    if (visited.has(next) || ++descendants >= MAX_PANE_COUNT) return true;
    current = next;
  }
  return ancestors + 1 + descendants > MAX_PANE_COUNT;
}

/** Validate every stored parent edge and ensure no chain exceeds the eight static views. */
export function hasValidPaneLinks(links: Record<string, PaneChainEntry>): boolean {
  for (const [childId, link] of Object.entries(links)) {
    if (!link.parentPaneId) continue;
    if (wouldCreateCycle(links, link.parentPaneId, childId)) return false;
  }
  return true;
}

export function getFollowingChildPaneIds(links: Record<string, PaneFollowEntry>, parentPaneId: string): string[] {
  return Object.entries(links)
    .filter(([, link]) => link.parentPaneId === parentPaneId && link.follow)
    .map(([paneId]) => paneId);
}

export function shouldCascadeSelection(isDirectory: boolean, followsParent: boolean): boolean {
  return isDirectory && followsParent;
}

export function shouldSyncWorkspaceDirectory(pane: { followWorkspaceDirectory: boolean; parentPaneId: string | null; follow: boolean }): boolean {
  return pane.followWorkspaceDirectory && !(pane.parentPaneId && pane.follow);
}

export type WorkspaceSyncPane = {
  roots: readonly string[];
  followWorkspaceDirectory: boolean;
  parentPaneId: string | null;
  follow: boolean;
};

/** 回傳需同步工作區根目錄的窗格，依 pane 編號升冪排列。 */
export function panesToSyncWorkspaceRoots(
  panes: Record<string, WorkspaceSyncPane>,
  workspaceRoots: readonly string[],
  samePath: (left: string, right: string) => boolean,
): string[] {
  return Object.entries(panes)
    .filter(([, pane]) => shouldSyncWorkspaceDirectory(pane) && shouldSyncWorkspaceRoots(pane.roots, workspaceRoots, samePath))
    .map(([paneId]) => paneId)
    .sort((left, right) => paneIndex(left) - paneIndex(right));
}

/**
 * Remove `removedPaneId` and re-attach its children to that pane's parent
 * (S4R6-D62/D71, PD-U3). Children that become top-level stop following.
 */
export function reattachChildren<T extends PaneFollowEntry>(panes: Record<string, T>, removedPaneId: string): Record<string, T> {
  const removed = panes[removedPaneId];
  const nextParent = removed?.parentPaneId ?? null;
  const result: Record<string, T> = {};
  for (const [paneId, pane] of Object.entries(panes)) {
    if (paneId === removedPaneId) continue;
    if (pane.parentPaneId !== removedPaneId) {
      result[paneId] = pane;
      continue;
    }
    result[paneId] = { ...pane, parentPaneId: nextParent, ...(nextParent ? {} : { follow: false }) };
  }
  return result;
}

export function detachChildrenOf<T extends PaneFollowEntry>(panes: Record<string, T>, parentPaneId: string, exceptPaneId?: string): Record<string, T> {
  const nextParent = panes[parentPaneId]?.parentPaneId ?? null;
  const result: Record<string, T> = {};
  for (const [paneId, pane] of Object.entries(panes)) {
    if (paneId === exceptPaneId || pane.parentPaneId !== parentPaneId) {
      result[paneId] = pane;
      continue;
    }
    result[paneId] = { ...pane, parentPaneId: nextParent, ...(nextParent ? {} : { follow: false }) };
  }
  return result;
}

/** Normalize persisted links: remove invalid parents and retain only the lowest-id child per parent. */
export function normalizePaneChains<T extends PaneFollowEntry>(panes: Record<string, T>): Record<string, T> {
  let result: Record<string, T> = {};
  for (const [paneId, pane] of Object.entries(panes)) {
    if (paneIndex(paneId) < 1) continue;
    if (pane.parentPaneId && (paneIndex(pane.parentPaneId) < 1 || !panes[pane.parentPaneId] || pane.parentPaneId === paneId)) {
      result[paneId] = { ...pane, parentPaneId: null, follow: false };
    } else result[paneId] = pane;
  }
  // 若祖先鏈重複，切斷偵測到重複的節點，保留進入環前的合法父邊。
  for (const paneId of Object.keys(result)) {
    const visited = new Set<string>();
    let current: string | null = paneId;
    while (current) {
      if (visited.has(current)) {
        result[current] = { ...result[current], parentPaneId: null, follow: false };
        break;
      }
      visited.add(current);
      current = result[current]?.parentPaneId ?? null;
    }
  }
  for (let pass = 0; pass < MAX_PANE_COUNT; pass += 1) {
    let changed = false;
    for (const parentPaneId of Object.keys(result)) {
      const children = Object.keys(result).filter(id => result[id].parentPaneId === parentPaneId).sort((a, b) => paneIndex(a) - paneIndex(b));
      if (children.length > 1) {
        result = detachChildrenOf(result, parentPaneId, children[0]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

export function isPaneRootDirectory(statType: number, directoryType: number): boolean {
  return (statType & directoryType) !== 0;
}

/**
 * Lowest free slot after the source, then wraps to the lowest free slot globally.
 * A newly allocated child id is absent from state, so adding its link cannot create a cycle.
 */
export function nextChildPaneId(sourcePaneId: string, enabledPaneIds: readonly string[]): string | undefined {
  const used = new Set(enabledPaneIds);
  for (let index = Math.max(paneIndex(sourcePaneId) + 1, 1); index <= MAX_PANE_COUNT; index += 1) {
    const candidate = `pane${index}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let index = 1; index <= MAX_PANE_COUNT; index += 1) {
    const candidate = `pane${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return undefined;
}

/** Any enabled pane may close while at least one pane stays (S4.1R3 revises S4R6-D71: pane1 is closable). */
export function canClosePane(paneId: string, enabledPaneIds: readonly string[]): boolean {
  return enabledPaneIds.length > 1 && enabledPaneIds.includes(paneId);
}

/**
 * 是否應將 follow pane 的 roots 同步為工作區資料夾（S4.1R11 OP-16）。
 *
 * roots 已完全同步（同序、同集合）時回傳 false，避免無謂 persist。
 *
 * 注意：多資料夾工作區必須同步全部 roots；僅以「首項相同」判斷會遺漏
 * workspace 新增第二個資料夾的情境（回歸：pane=[a]、workspace=[a,b] 必須更新）。
 */
export function shouldSyncWorkspaceRoots(
  paneRoots: readonly string[],
  workspaceRoots: readonly string[],
  samePath: (left: string, right: string) => boolean,
): boolean {
  // 已完全同步（同序、同集合）時早退，避免無謂 persist。
  // 其餘情況一律同步：多→單、單→多、換根、順序變更皆然。
  // 下鑽狀態無損僅由「已完全同步即早退」承接；roots 真正變動時，
  // `setPaneRoots` 會依不變式 D 清空 drillRoot 與 drillStack。
  return !(workspaceRoots.length === paneRoots.length &&
    workspaceRoots.every((root, index) => samePath(root, paneRoots[index])));
}

function paneIndex(id: string): number {
  const match = /^pane([1-8])$/.exec(id);
  return match ? Number(match[1]) : -1;
}
