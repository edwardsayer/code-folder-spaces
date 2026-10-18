import { describe, expect, it } from 'vitest';
import {
  describePaneLinkChain,
  describePaneLinkEdgeGroups,
  linkedChildPaneNumber,
  canClosePane,
  getFollowingChildPaneIds,
  hasValidPaneLinks,
  detachChildrenOf,
  normalizePaneChains,
  isPaneRootDirectory,
  nextChildPaneId,
  panesToSyncWorkspaceRoots,
  reattachChildren,
  shouldCascadeSelection,
  shouldSyncWorkspaceRoots,
  shouldSyncWorkspaceDirectory,
  wouldCreateCycle,
} from '../../src/spaces/paneLinks';
import type { PaneLinkDisplayEntry } from '../../src/spaces/paneLinks';
import type { PaneLinkState } from '../../src/spaces/viewState';

const chain = (count: number): Record<string, PaneLinkState> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`pane${index + 1}`, {
  root: `/space/${index + 1}`, parentPaneId: index ? `pane${index}` : null, follow: index > 0,
}]));

/** Every parent edge exists, is not self-referential, and reaches a finite acyclic chain. */
function assertNoOrphansAndChains(panes: Record<string, { parentPaneId: string | null }>): void {
  for (const [paneId, pane] of Object.entries(panes)) {
    if (!pane.parentPaneId) continue;
    expect(panes[pane.parentPaneId], `${paneId} points at a missing parent ${pane.parentPaneId}`).toBeDefined();
    expect(pane.parentPaneId).not.toBe(paneId);
    const visited = new Set([paneId]);
    let current: string | null = pane.parentPaneId;
    while (current) {
      expect(visited.has(current), `${paneId} chain contains a cycle`).toBe(false);
      visited.add(current);
      current = panes[current]?.parentPaneId ?? null;
    }
  }
}

describe('pane link display helpers (R13)', () => {
  const makeLinks = (count: number): Record<string, PaneLinkState> => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`pane${index + 1}`, {
      root: `/space/${index + 1}`, parentPaneId: index ? `pane${index}` : null, follow: index > 0,
    }]),
  );

  it('hides an unlinked chain and describes single- and multi-link chains', () => {
    expect(describePaneLinkChain(makeLinks(1), { mainPaneId: 'pane1' })).toEqual({ hidden: true, segments: [] });
    const one = describePaneLinkChain(makeLinks(2), { mainPaneId: 'pane1' });
    expect(one.hidden).toBe(false);
    expect(one.segments.map(segment => segment.paneIndex)).toEqual([1, 2]);
    const three = describePaneLinkChain(makeLinks(3), { mainPaneId: 'pane1' });
    expect(three.segments.map(segment => segment.paneId)).toEqual(['pane1', 'pane2', 'pane3']);
  });

  it('marks paused links, safely truncates cycles and enforces the depth limit', () => {
    const paused = makeLinks(2);
    paused.pane2.follow = false;
    expect(describePaneLinkChain(paused, { mainPaneId: 'pane1' }).segments[1].icon).toBe('debug-disconnect');
    const cycle = makeLinks(3);
    cycle.pane1.parentPaneId = 'pane3';
    expect(describePaneLinkChain(cycle, { mainPaneId: 'pane1' }).segments).toHaveLength(3);
    expect(describePaneLinkChain(makeLinks(4), { mainPaneId: 'pane1', maxDepth: 2 }).segments).toHaveLength(2);
    expect(describePaneLinkChain(makeLinks(2), { mainPaneId: 'pane8' })).toEqual({ hidden: true, segments: [] });
  });

  it('marks only the direct following child that targets the candidate root', () => {
    const links: Record<string, PaneLinkState> = {
      pane1: { root: '/parent', parentPaneId: null, follow: false },
      pane2: { root: '/target', parentPaneId: 'pane1', follow: true },
      pane3: { root: '/target', parentPaneId: 'pane1', follow: true },
    };
    expect(linkedChildPaneNumber(links, 'pane1', 'pane2', '/target')).toBe(2);
    expect(linkedChildPaneNumber(links, 'pane1', 'pane2', '/elsewhere')).toBeUndefined();
    links.pane2.follow = false;
    expect(linkedChildPaneNumber(links, 'pane1', 'pane2', '/target')).toBeUndefined();
    expect(linkedChildPaneNumber(links, 'pane3', 'pane2', '/target')).toBeUndefined();
  });

  it('uses active drilled roots and supports multiple roots without confusing sibling panes', () => {
    const links: Record<string, PaneLinkDisplayEntry> = {
      pane1: { root: '/parent', parentPaneId: null, follow: false },
      pane2: { roots: ['/first', '/second'], drillRoot: '/drilled', parentPaneId: 'pane1', follow: true },
      pane3: { roots: ['/second'], parentPaneId: null, follow: false },
    };
    expect(linkedChildPaneNumber(links, 'pane1', 'pane2', '/drilled')).toBe(2);
    expect(linkedChildPaneNumber(links, 'pane1', 'pane2', '/second')).toBe(2);
    expect(linkedChildPaneNumber(links, 'pane1', 'pane3', '/second')).toBeUndefined();
  });
});

describe('pane links', () => {
  it('selects only panes whose workspace roots need synchronization in pane order', () => {
    const pane = (roots: string[], options: Partial<{ followWorkspaceDirectory: boolean; parentPaneId: string | null; follow: boolean }> = {}) => ({
      roots,
      followWorkspaceDirectory: options.followWorkspaceDirectory ?? true,
      parentPaneId: options.parentPaneId ?? null,
      follow: options.follow ?? false,
    });
    const panes = {
      pane3: pane(['/old', '/b']),
      pane1: pane(['/a']),
      pane2: pane(['/b', '/a']),
      pane4: pane(['/old'], { parentPaneId: 'pane1', follow: true }),
      pane5: pane(['/old'], { followWorkspaceDirectory: false }),
    };
    const samePath = (left: string, right: string) => left === right;
    expect(panesToSyncWorkspaceRoots(panes, ['/a'], samePath)).toEqual(['pane2', 'pane3']);
    expect(panesToSyncWorkspaceRoots({ pane1: pane(['/a']) }, ['/a'], samePath)).toEqual([]);
    expect(panesToSyncWorkspaceRoots({ pane1: pane(['/a']) }, ['/a', '/b'], samePath)).toEqual(['pane1']);
    expect(panesToSyncWorkspaceRoots({ pane1: pane(['/a', '/b']) }, ['/a'], samePath)).toEqual(['pane1']);
    expect(panesToSyncWorkspaceRoots({ pane1: pane(['/a', '/b']) }, ['/b', '/a'], samePath)).toEqual(['pane1']);
    expect(panesToSyncWorkspaceRoots({ pane1: pane(['/a']) }, [], samePath)).toEqual(['pane1']);
    expect(panesToSyncWorkspaceRoots({ pane1: pane([]) }, [], samePath)).toEqual([]);
    expect(panesToSyncWorkspaceRoots({ pane1: panes.pane4, pane2: panes.pane5 }, ['/new'], samePath)).toEqual([]);
  });
  it('accepts reverse slot order while rejecting real cycles, invalid ids, and excessive depth', () => {
    const links: Record<string, PaneLinkState> = {
      pane1: { root: '/a', parentPaneId: null, follow: false },
      pane2: { root: '/b', parentPaneId: null, follow: false },
      pane3: { root: '/c', parentPaneId: null, follow: false },
    };
    expect(wouldCreateCycle(links, 'pane3', 'pane2')).toBe(false);
    expect(wouldCreateCycle(links, 'pane3', 'pane1')).toBe(false);
    expect(wouldCreateCycle({ ...links, pane1: { ...links.pane1, parentPaneId: 'pane2' } }, 'pane1', 'pane2')).toBe(true);
    expect(wouldCreateCycle(links, 'pane9', 'pane3')).toBe(true);
    expect(wouldCreateCycle(links, 'pane3', 'pane3')).toBe(true);
    const tooDeep = chain(8);
    expect(hasValidPaneLinks(tooDeep)).toBe(true);
    const overDepth = { ...tooDeep, pane9: { root: '/ninth', parentPaneId: 'pane8', follow: true } };
    expect(hasValidPaneLinks(overDepth)).toBe(false);
  });

  it('accepts a one-way link to a higher-numbered pane and rejects self-parenting', () => {
    const links = chain(3);
    expect(wouldCreateCycle(links, 'pane1', 'pane3')).toBe(false);
    expect(wouldCreateCycle(links, 'pane3', 'pane3')).toBe(true);
    expect(wouldCreateCycle(links, 'pane9', 'pane3')).toBe(true);
  });

  it('selects only direct children that follow, excluding deeper, unrelated, and paused panes', () => {
    const links: Record<string, PaneLinkState> = {
      pane1: { root: '/space', parentPaneId: null, follow: false },
      pane2: { root: '/space/child', parentPaneId: 'pane1', follow: true },
      pane3: { root: '/space/child/grandchild', parentPaneId: 'pane2', follow: true },
      pane4: { root: '/other', parentPaneId: 'pane1', follow: false },
      pane5: { root: '/unrelated', parentPaneId: null, follow: true },
    };
    expect(getFollowingChildPaneIds(links, 'pane1')).toEqual(['pane2']);
    expect(getFollowingChildPaneIds(links, 'pane2')).toEqual(['pane3']);
  });

  it('only cascades folders while follow is enabled and identifies stale non-directories', () => {
    expect(shouldCascadeSelection(true, true)).toBe(true);
    expect(shouldCascadeSelection(false, true)).toBe(false);
    expect(shouldCascadeSelection(true, false)).toBe(false);
    expect(isPaneRootDirectory(2, 2)).toBe(true);
    expect(isPaneRootDirectory(1, 2)).toBe(false);
  });
});

describe('pane chain normalization helpers', () => {
  it('detaches children to their grandparent and disables follow for newly top-level panes', () => {
    const panes = {
      pane1: { parentPaneId: null, follow: false },
      pane2: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane2', follow: true },
      pane4: { parentPaneId: 'pane2', follow: true },
      pane5: { parentPaneId: null, follow: false },
    };
    expect(detachChildrenOf(panes, 'pane2', 'pane3')).toEqual({
      ...panes, pane4: { parentPaneId: 'pane1', follow: true },
    });
    expect(detachChildrenOf(panes, 'pane1').pane2).toEqual({ parentPaneId: null, follow: false });
    expect(panes.pane4.parentPaneId).toBe('pane2');
  });

  it('breaks two- and three-pane cycles without changing a valid long chain', () => {
    const threeCycle = normalizePaneChains({
      pane1: { parentPaneId: 'pane3', follow: true },
      pane2: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane2', follow: true },
    });
    assertNoOrphansAndChains(threeCycle);
    expect(Object.values(threeCycle).filter(pane => pane.parentPaneId === null)).toHaveLength(1);

    const twoCycle = normalizePaneChains({
      pane1: { parentPaneId: 'pane2', follow: true },
      pane2: { parentPaneId: 'pane1', follow: true },
    });
    assertNoOrphansAndChains(twoCycle);
    expect(Object.values(twoCycle).filter(pane => pane.parentPaneId === null)).toHaveLength(1);

    const mixed = normalizePaneChains({
      pane1: { parentPaneId: 'pane2', follow: true },
      pane2: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane1', follow: true },
    });
    assertNoOrphansAndChains(mixed);
    // S4.1R15（OP-22）：一父多子合法——斷環後 pane3 不再是「多子被收斂」的犧牲者。
    expect(mixed.pane2.parentPaneId).toBe('pane1');
    expect(mixed.pane3.parentPaneId).toBe('pane1');

    const valid = { pane1: { parentPaneId: null, follow: false }, pane2: { parentPaneId: 'pane1', follow: true }, pane3: { parentPaneId: 'pane2', follow: true } };
    expect(normalizePaneChains(valid)).toEqual(valid);
  });

  it('preserves the valid tail entering a cycle and cuts the repeated cycle node', () => {
    const normalized = normalizePaneChains({
      pane1: { parentPaneId: 'pane2', follow: true },
      pane2: { parentPaneId: 'pane3', follow: true },
      pane3: { parentPaneId: 'pane2', follow: true },
    });
    expect(normalized.pane1.parentPaneId).toBe('pane2');
    // 環 pane2→pane3→pane2：切入點 pane2 被清為 null；pane3 保留指向 pane2（已不再成環）。
    expect(normalized.pane2.parentPaneId).toBeNull();
    expect(normalized.pane3.parentPaneId).toBe('pane2');
    assertNoOrphansAndChains(normalized);
  });

  it('filters invalid pane keys and keeps all valid siblings (S4.1R15 multi-child)', () => {
    const normalized = normalizePaneChains({
      pane1: { parentPaneId: null, follow: false },
      pane2: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane1', follow: true },
      pane0: { parentPaneId: 'pane1', follow: true },
    });
    expect(Object.keys(normalized)).toEqual(['pane1', 'pane2', 'pane3']);
    expect(normalized.pane2.parentPaneId).toBe('pane1');
    // 一父多子：兩個合法子都保留。
    expect(normalized.pane3.parentPaneId).toBe('pane1');
  });

  it('normalizes missing, invalid and self parents while keeping multiple valid children', () => {
    const normalized = normalizePaneChains({
      pane1: { parentPaneId: null, follow: false },
      pane2: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane1', follow: true },
      pane4: { parentPaneId: 'pane9', follow: true },
      pane5: { parentPaneId: 'pane5', follow: true },
      pane6: { parentPaneId: 'pane8', follow: true },
    });
    expect(normalized.pane2.parentPaneId).toBe('pane1');
    // S4.1R15（OP-22）：pane3 是合法子，不因 pane2 存在而被踢出。
    expect(normalized.pane3.parentPaneId).toBe('pane1');
    expect(normalized.pane4).toEqual({ parentPaneId: null, follow: false });
    expect(normalized.pane5).toEqual({ parentPaneId: null, follow: false });
    expect(normalized.pane6).toEqual({ parentPaneId: null, follow: false });
  });
});

describe('reattachChildren (PD-U3, S4R6-D62/D71)', () => {
  it('re-attaches the children of a closed middle pane to its parent', () => {
    const panes = chain(4);
    const next = reattachChildren(panes, 'pane2');
    expect(Object.keys(next)).toEqual(['pane1', 'pane3', 'pane4']);
    expect(next.pane3).toEqual({ root: '/space/3', parentPaneId: 'pane1', follow: true });
    // Deeper descendants keep their (unchanged) parent edge.
    expect(next.pane4.parentPaneId).toBe('pane3');
    assertNoOrphansAndChains(next);
    expect(hasValidPaneLinks(next)).toBe(true);
  });

  it('makes children top-level and stops them following when the closed pane had no parent', () => {
    const panes: Record<string, PaneLinkState> = {
      pane1: { root: '/a', parentPaneId: null, follow: false },
      pane2: { root: '/b', parentPaneId: 'pane1', follow: true },
      pane3: { root: '/c', parentPaneId: 'pane1', follow: false },
    };
    const next = reattachChildren(panes, 'pane1');
    expect(next.pane2).toEqual({ root: '/b', parentPaneId: null, follow: false });
    expect(next.pane3).toEqual({ root: '/c', parentPaneId: null, follow: false });
    assertNoOrphansAndChains(next);
    expect(hasValidPaneLinks(next)).toBe(true);
  });

  // 任意 map 的純函式仍需保留多子處理能力；1:1 約束由 store 層強制。
  it('re-attaches several siblings at once and preserves their own settings', () => {
    const panes: Record<string, PaneLinkState> = {
      pane1: { root: '/a', parentPaneId: null, follow: false },
      pane2: { root: '/b', parentPaneId: 'pane1', follow: true },
      pane3: { root: '/c', parentPaneId: 'pane2', follow: true },
      pane4: { root: '/d', parentPaneId: 'pane2', follow: false },
      pane5: { root: '/e', parentPaneId: 'pane2', follow: true },
    };
    const next = reattachChildren(panes, 'pane2');
    expect(next.pane3).toEqual({ root: '/c', parentPaneId: 'pane1', follow: true });
    expect(next.pane4).toEqual({ root: '/d', parentPaneId: 'pane1', follow: false });
    expect(next.pane5).toEqual({ root: '/e', parentPaneId: 'pane1', follow: true });
    assertNoOrphansAndChains(next);
    expect(hasValidPaneLinks(next)).toBe(true);
    // The cascade target after the close is the re-attached follower set of pane1.
    expect(getFollowingChildPaneIds(next, 'pane1')).toEqual(['pane3', 'pane5']);
  });

  it('closes the last pane of a chain without touching unrelated panes', () => {
    const panes: Record<string, PaneLinkState> = {
      pane1: { root: '/a', parentPaneId: null, follow: false },
      pane2: { root: '/b', parentPaneId: 'pane1', follow: true },
      pane7: { root: '/g', parentPaneId: 'pane1', follow: true },
    };
    const next = reattachChildren(panes, 'pane2');
    expect(next).toEqual({
      pane1: { root: '/a', parentPaneId: null, follow: false },
      pane7: { root: '/g', parentPaneId: 'pane1', follow: true },
    });
    assertNoOrphansAndChains(next);
  });

  it('is a no-op for an unknown pane id and does not mutate the input document', () => {
    const panes = chain(3);
    const snapshot = JSON.parse(JSON.stringify(panes)) as Record<string, PaneLinkState>;
    expect(reattachChildren(panes, 'pane8')).toEqual(snapshot);
    const closed = reattachChildren(panes, 'pane2');
    expect(panes).toEqual(snapshot);
    expect(closed).not.toBe(panes);
    expect(closed.pane3).not.toBe(panes.pane3);
  });

  it('keeps the chain valid after repeatedly closing middle panes', () => {
    let panes: Record<string, PaneLinkState> = chain(8);
    for (const removed of ['pane4', 'pane2', 'pane6', 'pane3']) {
      panes = reattachChildren(panes, removed);
      assertNoOrphansAndChains(panes);
      expect(hasValidPaneLinks(panes)).toBe(true);
    }
    expect(panes.pane1).toEqual({ root: '/space/1', parentPaneId: null, follow: false });
    expect(Object.keys(panes)).toEqual(['pane1', 'pane5', 'pane7', 'pane8']);
    expect(panes.pane8.parentPaneId).toBe('pane7');
  });

  it('preserves extra per-pane fields when re-attaching full PaneState records', () => {
    const panes = {
      pane1: { root: '/a', parentPaneId: null, follow: false, preset: 'Explorer', filter: '' },
      pane2: { root: '/b', parentPaneId: 'pane1', follow: true, preset: 'Files', filter: 'keep-me' },
      pane3: { root: '/c', parentPaneId: 'pane2', follow: true, preset: 'List', filter: 'own' },
    };
    const next = reattachChildren(panes, 'pane2');
    expect(next.pane3).toEqual({ root: '/c', parentPaneId: 'pane1', follow: true, preset: 'List', filter: 'own' });
    expect(next.pane1).toBe(panes.pane1);
  });

  it('allocates the lowest free slot after the source, then wraps to the lowest free slot (F-11)', () => {
    expect(nextChildPaneId('pane1', ['pane1', 'pane2'])).toBe('pane3');
    expect(nextChildPaneId('pane1', ['pane1', 'pane3'])).toBe('pane2');
    expect(nextChildPaneId('pane2', ['pane1', 'pane2'])).toBe('pane3');
    // 池已滿 → undefined
    expect(nextChildPaneId('pane1', ['pane1', 'pane2', 'pane3', 'pane4', 'pane5', 'pane6', 'pane7', 'pane8'])).toBeUndefined();
    // 來源已是最後一個插槽 → 回繞至全域最低空閒插槽。
    expect(nextChildPaneId('pane8', ['pane1', 'pane8'])).toBe('pane2');
  });

  it('closes any enabled pane (including pane1) while at least one pane stays (F-11, S4.1R3 revises D71)', () => {
    expect(canClosePane('pane2', ['pane1', 'pane2'])).toBe(true);
    expect(canClosePane('pane1', ['pane1', 'pane2'])).toBe(true);
    expect(canClosePane('pane1', ['pane1'])).toBe(false);
    expect(canClosePane('pane2', ['pane2'])).toBe(false);
    expect(canClosePane('pane3', ['pane1', 'pane2'])).toBe(false);
  });

  it('skips following child panes during workspace directory synchronization', () => {
    expect(shouldSyncWorkspaceDirectory({ followWorkspaceDirectory: true, parentPaneId: 'pane1', follow: true })).toBe(false);
    expect(shouldSyncWorkspaceDirectory({ followWorkspaceDirectory: true, parentPaneId: 'pane1', follow: false })).toBe(true);
    expect(shouldSyncWorkspaceDirectory({ followWorkspaceDirectory: true, parentPaneId: null, follow: true })).toBe(true);
    expect(shouldSyncWorkspaceDirectory({ followWorkspaceDirectory: false, parentPaneId: null, follow: false })).toBe(false);
  });

  it('MR-UI4：pane1 跟隨工作區目錄，其他 pane 保留自己的根', () => {
    const panes = {
      pane1: { roots: ['/old'], parentPaneId: null, follow: false, followWorkspaceDirectory: true },
      pane2: { roots: ['/private'], parentPaneId: null, follow: false, followWorkspaceDirectory: false },
      pane3: { roots: ['/child'], parentPaneId: 'pane1', follow: true, followWorkspaceDirectory: true },
    };
    const same = (a: string, b: string) => a === b;
    const selected = Object.keys(panes).filter(id => shouldSyncWorkspaceDirectory(panes[id as keyof typeof panes]));
    expect(selected).toEqual(['pane1']);
    expect(panesToSyncWorkspaceRoots(panes, ['/workspace'], same)).toEqual(['pane1']);
  });

  it('syncs follow pane roots when a multi-folder workspace gains another folder (S4.1R11 OP-16)', () => {
    const same = (a: string, b: string) => a === b;
    // 加入第二個專案資料夾是 OP-16 的核心用例，不可因首項相同而早退。
    expect(shouldSyncWorkspaceRoots(['D:/a'], ['D:/a', 'D:/b'], same)).toBe(true);
    // 完全同步時早退（避免無謂 persist）。
    expect(shouldSyncWorkspaceRoots(['D:/a', 'D:/b'], ['D:/a', 'D:/b'], same)).toBe(false);
    // R10 P1 的下鑽保護由 setPaneRoots 承接，不得以首項相同早退。
    expect(shouldSyncWorkspaceRoots(['D:/a'], ['D:/a'], same)).toBe(false);
    // 換掉第一個專案仍須同步。
    expect(shouldSyncWorkspaceRoots(['D:/a'], ['D:/c'], same)).toBe(true);
    // 多根收回單根：必須同步，否則已失效的 root 與 watcher 會殘留（審查 P1-1 回歸）。
    expect(shouldSyncWorkspaceRoots(['D:/a', 'D:/b'], ['D:/a'], same)).toBe(true);
    // 尚無 root 的 follow pane 必須被填入。
    expect(shouldSyncWorkspaceRoots([], ['D:/a'], same)).toBe(true);
    // 順序不同視為不同集合。
    expect(shouldSyncWorkspaceRoots(['D:/b', 'D:/a'], ['D:/a', 'D:/b'], same)).toBe(true);
  });
});

describe('describePaneLinkEdgeGroups (S4.1R17 / OP-22 狀態列改版)', () => {
  const make = (spec: Record<string, { parent: string | null; follow?: boolean }>) =>
    Object.fromEntries(Object.entries(spec).map(([id, v]) => [id, { parentPaneId: v.parent, follow: v.follow ?? true }]));

  it('returns every parent-child edge as one group per parent, sorted by parent index', () => {
    const groups = describePaneLinkEdgeGroups(make({
      pane1: { parent: null },
      pane2: { parent: 'pane1' },
      pane3: { parent: 'pane1' },
      pane4: { parent: 'pane2' },
    }));
    expect(groups).toEqual([
      { parentPaneIndex: 1, childPaneIndexes: [2, 3], allFollow: true },
      { parentPaneIndex: 2, childPaneIndexes: [4], allFollow: true },
    ]);
  });

  it('reports allFollow=false when any child stops following', () => {
    const groups = describePaneLinkEdgeGroups(make({
      pane1: { parent: null },
      pane2: { parent: 'pane1', follow: true },
      pane3: { parent: 'pane1', follow: false },
    }));
    expect(groups).toEqual([{ parentPaneIndex: 1, childPaneIndexes: [2, 3], allFollow: false }]);
  });

  it('returns an empty list when there is no parent-child edge', () => {
    expect(describePaneLinkEdgeGroups(make({ pane1: { parent: null }, pane2: { parent: null } }))).toEqual([]);
  });

  it('lists independent trees side by side instead of only the primary chain', () => {
    const groups = describePaneLinkEdgeGroups(make({
      pane1: { parent: null }, pane2: { parent: 'pane1' },
      pane3: { parent: null }, pane4: { parent: 'pane3' },
    }));
    expect(groups.map(g => g.parentPaneIndex)).toEqual([1, 3]);
  });

  it('ignores non-pane keys and dangling parents', () => {
    const groups = describePaneLinkEdgeGroups({
      pane1: { parentPaneId: null, follow: false },
      bogus: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane9', follow: true },
    });
    expect(groups).toEqual([{ parentPaneIndex: 1, childPaneIndexes: [], allFollow: true }].slice(0, 0));
  });
});
