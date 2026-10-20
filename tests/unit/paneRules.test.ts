import { describe, expect, it } from 'vitest';
import { childSlotOf, isDrillDownNoop, isPaneRootDirectory, paneSlotOf } from '../../src/spaces/paneRules';

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

});

describe('isDrillDownNoop（v2-R6 多 root 回歸）', () => {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  it('allows drilling into the first root when no drill root is set', () => {
    // 使用者回報：多 root 時第一個 root 無法下鑽。舊寫法用 activeRoot（= roots[0]）比對，
    // 會把 roots[0] 誤判為「已在該根」。修好後 drillRoot 為 null 時一律允許。
    expect(isDrillDownNoop(null, 'C:\a', same)).toBe(false);
  });

  it('allows drilling into a root that differs from the current drill root', () => {
    expect(isDrillDownNoop('C:\a\sub', 'C:\b', same)).toBe(false);
  });

  it('blocks drilling into the current drill root itself', () => {
    expect(isDrillDownNoop('C:\a\sub', 'C:\a\sub', same)).toBe(true);
    expect(isDrillDownNoop('C:\A\SUB', 'c:\a\sub', same)).toBe(true);
  });
});
