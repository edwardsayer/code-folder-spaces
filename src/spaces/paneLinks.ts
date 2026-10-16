const MAX_PANE_COUNT = 8;

/** Minimal chain shape both `PaneLinkState` views and full `PaneState` records satisfy. */
type PaneChainEntry = { parentPaneId: string | null };
type PaneFollowEntry = PaneChainEntry & { follow: boolean };

/** True when assigning childPaneId to parentPaneId violates the one-way pane chain. */
export function wouldCreateCycle(links: Record<string, PaneChainEntry>, parentPaneId: string, childPaneId: string): boolean {
  const parentIndex = paneIndex(parentPaneId);
  const childIndex = paneIndex(childPaneId);
  if (parentIndex < 1 || childIndex < 1 || parentIndex >= childIndex) return true;
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

/**
 * Remove `removedPaneId` and re-attach its children to that pane's parent
 * (S4R6-D62/D71, PD-U3). Children that become top-level stop following.
 * The `parentIndex < childIndex` invariant is preserved because the grandparent
 * index is below the removed index, which is below every child index.
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

export function isPaneRootDirectory(statType: number, directoryType: number): boolean {
  return (statType & directoryType) !== 0;
}

/**
 * Lowest free slot strictly above `sourcePaneId`, so the chain keeps
 * `parentIndex < childIndex` (S4R6-D62). Returns `undefined` when the pool is full.
 */
export function nextChildPaneId(sourcePaneId: string, enabledPaneIds: readonly string[]): string | undefined {
  const used = new Set(enabledPaneIds);
  for (let index = Math.max(paneIndex(sourcePaneId) + 1, 1); index <= MAX_PANE_COUNT; index += 1) {
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
 * 早退條件（回傳 false）：
 * 1. 已完全同步（同序、同集合）——避免無謂 persist。
 * 2. 工作區僅**單一**資料夾且等於目前鏈根——R10 P1 保護，保留下鑽狀態與無損返回能力。
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
  // 其餘情況一律同步：多→單、單→多、換根、順序變更皆尖。
  // R10 P1 的下鑽狀態保護由 `PaneStateStore.setPaneRoots` 承接
  // （仅當 `drillRoot` 不落於任何新 root 內才清空），
  // 故此處**不得**再以「首項相同」早退，否則 workspace 少一個資料夾時
  // 會永久留下已失效的 root 與其 watcher。
  return !(workspaceRoots.length === paneRoots.length &&
    workspaceRoots.every((root, index) => samePath(root, paneRoots[index])));
}

function paneIndex(id: string): number {
  const match = /^pane([1-8])$/.exec(id);
  return match ? Number(match[1]) : -1;
}
