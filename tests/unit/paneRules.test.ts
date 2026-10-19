import { describe, expect, it } from 'vitest';
import { childSlotOf, isPaneRootDirectory, paneSlotOf } from '../../src/spaces/paneRules';

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
