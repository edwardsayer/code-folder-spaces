import { describe, expect, it } from 'vitest';
import { createLinkEdgesText, createLinkStatusSummaryFromEdges, linkStatusIcon } from '../../src/spaces/linkStatusBar';

/**
 * S4.1R17（OP-22 狀態列改版）：使用者裁決格式為 `Folder Spaces: 1→2/3, 2→4`
 * ——**列出所有父子關係**，每組只呈現上下兩層。
 */
const labels = { prefix: 'Folder Spaces:', separator: ', ', childJoiner: '/', arrow: '→', followOff: (line: string) => `${line} (follow off)` };

describe('link status bar edge groups (OP-22)', () => {
  it('renders the user-decided format for a chain: 1→2, 2→4', () => {
    const summary = createLinkStatusSummaryFromEdges(
      [
        { parentPaneIndex: 1, childPaneIndexes: [2], allFollow: true },
        { parentPaneIndex: 2, childPaneIndexes: [4], allFollow: true },
      ],
      String,
      labels,
    );
    expect(summary.visible).toBe(true);
    expect(summary.text).toBe('Folder Spaces: 1→2, 2→4');
    expect(linkStatusIcon(summary.follow)).toBe('link');
  });

  it('renders multiple children of one parent as 1→2/3', () => {
    const summary = createLinkStatusSummaryFromEdges(
      [{ parentPaneIndex: 1, childPaneIndexes: [2, 3], allFollow: true }],
      String,
      labels,
    );
    expect(summary.text).toBe('Folder Spaces: 1→2/3');
  });

  it('lists every parent-child relation, not just the primary chain', () => {
    // 三個獨立父：1→2, 3→4, 5→6；舊版只顯示主窗格那條，新版全部列出
    const summary = createLinkStatusSummaryFromEdges(
      [
        { parentPaneIndex: 1, childPaneIndexes: [2], allFollow: true },
        { parentPaneIndex: 3, childPaneIndexes: [4], allFollow: true },
        { parentPaneIndex: 5, childPaneIndexes: [6], allFollow: true },
      ],
      String,
      labels,
    );
    expect(summary.text).toBe('Folder Spaces: 1→2, 3→4, 5→6');
  });

  it('marks a group in the tooltip when any child stops following, and switches the icon', () => {
    const summary = createLinkStatusSummaryFromEdges(
      [
        { parentPaneIndex: 1, childPaneIndexes: [2], allFollow: false },
        { parentPaneIndex: 2, childPaneIndexes: [3], allFollow: true },
      ],
      String,
      labels,
    );
    expect(summary.visible).toBe(true);
    expect(summary.text).toBe('Folder Spaces: 1→2, 2→3');
    expect(summary.tooltip).toBe('1→2 (follow off), 2→3');
    expect(linkStatusIcon(summary.follow)).toBe('debug-disconnect');
  });

  it('hides the status bar when there is no parent-child edge at all', () => {
    const summary = createLinkStatusSummaryFromEdges([], String, labels);
    expect(summary).toEqual({ visible: false, text: '', tooltip: '', follow: [] });
  });

  it('ignores groups without children (defensive against partial data)', () => {
    const summary = createLinkStatusSummaryFromEdges(
      [{ parentPaneIndex: 1, childPaneIndexes: [], allFollow: true }],
      String,
      labels,
    );
    expect(summary.visible).toBe(false);
  });

  it('createLinkEdgesText is a pure formatter usable with any labels', () => {
    expect(createLinkEdgesText(
      [{ parentPaneIndex: 1, childPaneIndexes: [2, 3] }, { parentPaneIndex: 2, childPaneIndexes: [4] }],
      index => `FS${index}`,
      ' | ',
      '+',
      '->',
    )).toBe('FS1->FS2+FS3 | FS2->FS4');
  });
});
