import { describe, expect, it } from 'vitest';
import { canDrillUp } from '../../src/spaces/drillContext';

describe('canDrillUp context key', () => {
  it('未下鑽時為 false（換 root 後的情境）', () => {
    // 這是回歸核心：外部換 root 後 drillStack 已清空，
    // context key 必須是 false，否則 pane 標題列會殘留 Return to Parent。
    expect(canDrillUp({ drillStack: [] })).toBe(false);
  });

  it('下鑽中為 true', () => {
    expect(canDrillUp({ drillStack: [{}] })).toBe(true);
    expect(canDrillUp({ drillStack: [{}, {}] })).toBe(true);
  });

  it('pane 不存在／未啟用時為 false（不可顯示按鈕）', () => {
    expect(canDrillUp(undefined)).toBe(false);
  });

  it('只看 drillStack，不受殘留 drillRoot 影響', () => {
    // drillUp 在堆疊清空時會把 drillRoot 設回 null，但同步時序可能讓 drillRoot
    // 短暫非 null；此時仍不應顯示 Return to Parent（堆疊為空＝沒有可返回的層級）。
    const stale = { drillStack: [] as unknown[], drillRoot: '/repo/docs' };
    expect(canDrillUp(stale)).toBe(false);
  });
});
