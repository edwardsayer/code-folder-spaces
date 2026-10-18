import { describe, expect, it } from 'vitest';
import { createLinkStatusSummary, linkStatusIcon } from '../../src/spaces/linkStatusBar';

/** 模擬 extension 端已 l10n 過的標籤（本模組不負責翻譯）。 */
const labels = (numbers: readonly number[]) => numbers.map(n => `Folder Space ${n}`);

describe('link status bar summary', () => {
  it('hides an empty or single-pane chain', () => {
    expect(createLinkStatusSummary([], 'chain', [])).toEqual({ visible: false, text: '', tooltip: '', follow: [] });
    expect(createLinkStatusSummary(['Folder Space 1'], 'chain', []).visible).toBe(false);
  });

  it('formats a single link with localized pane names', () => {
    const summary = createLinkStatusSummary(labels([1, 2]), 'chain tooltip', [true]);
    expect(summary).toEqual({ visible: true, text: 'Folder Space 1 → Folder Space 2', tooltip: 'chain tooltip', follow: [true] });
    expect(linkStatusIcon(summary.follow)).toBe('link');
  });

  it('formats a multi-link chain and marks any paused link as disconnected', () => {
    const summary = createLinkStatusSummary(labels([1, 2, 3]), 'chain tooltip', [true, false]);
    expect(summary.visible).toBe(true);
    expect(summary.text).toBe('Folder Space 1 → Folder Space 2 → Folder Space 3');
    expect(summary.follow).toEqual([true, false]);
    expect(linkStatusIcon(summary.follow)).toBe('debug-disconnect');
  });
});
