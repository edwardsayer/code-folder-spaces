import { describe, expect, it } from 'vitest';
import {
  getFollowingChildPaneIds,
  hasValidPaneLinks,
  isPaneRootDirectory,
  reattachChildren,
  shouldCascadeSelection,
  wouldCreateCycle,
} from '../../src/spaces/paneLinks';
import type { PaneLinkState } from '../../src/spaces/viewState';

const chain = (count: number): Record<string, PaneLinkState> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`pane${index + 1}`, {
  root: `/space/${index + 1}`, parentPaneId: index ? `pane${index}` : null, follow: index > 0,
}]));

/** Every remaining parent edge must point at an existing, lower-numbered pane (S4R6-D71 invariant). */
function assertNoOrphansAndOrdered(panes: Record<string, { parentPaneId: string | null }>): void {
  for (const [paneId, pane] of Object.entries(panes)) {
    if (!pane.parentPaneId) continue;
    expect(panes[pane.parentPaneId], `${paneId} points at a missing parent ${pane.parentPaneId}`).toBeDefined();
    expect(Number(pane.parentPaneId.replace('pane', '')), `${paneId} parent is not lower-numbered`).toBeLessThan(Number(paneId.replace('pane', '')));
  }
}

describe('pane links', () => {
  it('rejects backwards links, cycles, and chains deeper than eight panes', () => {
    const links = chain(8);
    expect(wouldCreateCycle(links, 'pane3', 'pane2')).toBe(true);
    expect(wouldCreateCycle(links, 'pane3', 'pane1')).toBe(true);
    expect(hasValidPaneLinks(links)).toBe(true);
    const tooDeep = { ...links, pane8: { ...links.pane8, parentPaneId: 'pane7' }, pane9: { root: '/ninth', parentPaneId: 'pane8', follow: true } };
    expect(hasValidPaneLinks(tooDeep)).toBe(false);
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

describe('reattachChildren (PD-U3, S4R6-D62/D71)', () => {
  it('re-attaches the children of a closed middle pane to its parent', () => {
    const panes = chain(4);
    const next = reattachChildren(panes, 'pane2');
    expect(Object.keys(next)).toEqual(['pane1', 'pane3', 'pane4']);
    expect(next.pane3).toEqual({ root: '/space/3', parentPaneId: 'pane1', follow: true });
    // Deeper descendants keep their (unchanged) parent edge.
    expect(next.pane4.parentPaneId).toBe('pane3');
    assertNoOrphansAndOrdered(next);
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
    assertNoOrphansAndOrdered(next);
    expect(hasValidPaneLinks(next)).toBe(true);
  });

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
    assertNoOrphansAndOrdered(next);
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
    assertNoOrphansAndOrdered(next);
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
      assertNoOrphansAndOrdered(panes);
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
});
