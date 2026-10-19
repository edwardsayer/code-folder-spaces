import { describe, expect, it } from 'vitest';
import { childSlotOf, describePaneLinkEdgeGroups, fixedPaneLinks, isPaneRootDirectory, paneSlotOf } from '../../src/spaces/paneRules';

describe('paneRules', () => {
  it('identifies directory flags', () => {
    expect(isPaneRootDirectory(2, 2)).toBe(true);
    expect(isPaneRootDirectory(1, 2)).toBe(false);
  });

  it('maps fixed slots', () => {
    expect(paneSlotOf('pane1')).toBe('primary');
    expect(paneSlotOf('pane2')).toBe('secondary');
    expect(childSlotOf('primary')).toBe('secondary');
    expect(childSlotOf('secondary')).toBeNull();
  });

  it('projects tree and dual layouts', () => {
    const rootOf = (id: string) => id === 'pane1' ? '/primary' : '/secondary';
    expect(fixedPaneLinks(rootOf, 'tree')).toEqual({ pane1: { root: '/primary', parentPaneId: null, follow: false } });
    expect(fixedPaneLinks(rootOf, 'dual')).toEqual({
      pane1: { root: '/primary', parentPaneId: null, follow: false },
      pane2: { root: '/secondary', parentPaneId: 'pane1', follow: true },
    });
  });

  it('groups no, one, and two link edges', () => {
    expect(describePaneLinkEdgeGroups({})).toEqual([]);
    expect(describePaneLinkEdgeGroups({ pane2: { parentPaneId: 'pane1', follow: true } })).toEqual([
      { parentPaneIndex: 1, childPaneIndexes: [2], allFollow: true },
    ]);
    expect(describePaneLinkEdgeGroups({
      pane2: { parentPaneId: 'pane1', follow: true },
      pane3: { parentPaneId: 'pane1', follow: false },
    })).toEqual([{ parentPaneIndex: 1, childPaneIndexes: [2, 3], allFollow: false }]);
  });
});
