import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFollowingChildPaneIds, hasValidPaneLinks, isPaneRootDirectory, rewritePaneRoots, shouldCascadeSelection, wouldCreateCycle } from '../../src/spaces/paneLinks';
import type { PaneLinkState } from '../../src/spaces/viewState';

const chain = (count: number): Record<string, PaneLinkState> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`pane${index + 1}`, {
  root: `/space/${index + 1}`, parentPaneId: index ? `pane${index}` : null, follow: index > 0,
}]));

describe('pane links', () => {
  it('rejects backwards links, cycles, and chains deeper than eight panes', () => {
    const links = chain(8);
    expect(wouldCreateCycle(links, 'pane3', 'pane2')).toBe(true);
    expect(wouldCreateCycle(links, 'pane3', 'pane1')).toBe(true);
    expect(hasValidPaneLinks(links)).toBe(true);
    const tooDeep = { ...links, pane8: { ...links.pane8, parentPaneId: 'pane7' }, pane9: { root: '/ninth', parentPaneId: 'pane8', follow: true } };
    expect(hasValidPaneLinks(tooDeep)).toBe(false);
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

  it('rewrites pane root paths on rename, including nested roots', () => {
    const links = { pane1: { root: '/space', parentPaneId: null, follow: false }, pane2: { root: '/space/old/nested', parentPaneId: 'pane1', follow: true }, pane3: { root: '/elsewhere', parentPaneId: 'pane2', follow: true } };
    expect(rewritePaneRoots(links, '/space/old', '/space/new')).toMatchObject({
      pane2: { root: path.join('/space/new', 'nested') }, pane3: { root: '/elsewhere' },
    });
  });
});
