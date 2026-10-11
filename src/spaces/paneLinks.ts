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

/** `pane1` is never closable and at least one pane must stay (S4R6-D71). */
export function canClosePane(paneId: string, enabledPaneIds: readonly string[]): boolean {
  return paneId !== 'pane1' && enabledPaneIds.length > 1 && enabledPaneIds.includes(paneId);
}

function paneIndex(id: string): number {
  const match = /^pane([1-8])$/.exec(id);
  return match ? Number(match[1]) : -1;
}
