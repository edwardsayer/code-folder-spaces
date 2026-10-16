import { describe, expect, it } from 'vitest';
import { selectedQuickPickId, stableQuickPickItems } from '../../src/ui/stableQuickPick';

describe('stableQuickPickItems', () => {
  it('routes a non-English display selection by its stable id', () => {
    const items = stableQuickPickItems([
      { id: 'setRoot', label: '設定根目錄' },
      { id: 'refresh', label: '重新整理' },
    ] as const);

    expect(items.map(item => item.label)).toEqual(['設定根目錄', '重新整理']);
    expect(selectedQuickPickId(items[0])).toBe('setRoot');
    expect(selectedQuickPickId(items[1])).toBe('refresh');
    expect(selectedQuickPickId(undefined)).toBeUndefined();
  });

  it('preserves preset and sort identifiers when labels are localized', () => {
    const items = stableQuickPickItems([
      { id: 'Explorer', label: '總管' },
      { id: 'mtime', label: '修改時間' },
      { id: 'desc', label: '遞減' },
    ] as const);

    expect(items.map(item => selectedQuickPickId(item))).toEqual(['Explorer', 'mtime', 'desc']);
  });
});
