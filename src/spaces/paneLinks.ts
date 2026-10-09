import * as path from 'node:path';
import type { PaneLinkState } from './viewState';

const MAX_PANE_COUNT = 8;

/** True when assigning childPaneId to parentPaneId violates the one-way pane chain. */
export function wouldCreateCycle(links: Record<string, PaneLinkState>, parentPaneId: string, childPaneId: string): boolean {
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
export function hasValidPaneLinks(links: Record<string, PaneLinkState>): boolean {
  for (const [childId, link] of Object.entries(links)) {
    if (!link.parentPaneId) continue;
    if (wouldCreateCycle(links, link.parentPaneId, childId)) return false;
  }
  return true;
}

export function getFollowingChildPaneIds(links: Record<string, PaneLinkState>, parentPaneId: string): string[] {
  return Object.entries(links)
    .filter(([, link]) => link.parentPaneId === parentPaneId && link.follow)
    .map(([paneId]) => paneId);
}

export function shouldCascadeSelection(isDirectory: boolean, followsParent: boolean): boolean {
  return isDirectory && followsParent;
}

export function rewritePaneRoots(links: Record<string, PaneLinkState>, oldPath: string, newPath: string): Record<string, PaneLinkState> {
  const normalizedOld = path.normalize(oldPath);
  const rewritten: Record<string, PaneLinkState> = {};
  for (const [id, link] of Object.entries(links)) {
    if (!link.root) { rewritten[id] = link; continue; }
    const relative = path.relative(normalizedOld, path.normalize(link.root));
    const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    rewritten[id] = inside ? { ...link, root: path.join(newPath, relative) } : link;
  }
  return rewritten;
}

export function isPaneRootDirectory(statType: number, directoryType: number): boolean {
  return (statType & directoryType) !== 0;
}

function paneIndex(id: string): number {
  const match = /^pane([1-8])$/.exec(id);
  return match ? Number(match[1]) : -1;
}
