import { describe, expect, it } from 'vitest';
import { PANE2_NESTED_OFF, PANE2_NESTED_ON, isPane2Nested, togglePane2Nested, VIEW_PRESETS } from '../../src/spaces/viewPresets';

describe('pane2 巢狀檔案切換（v2.1，使用者定義）', () => {
  it('未勾選＝flat／第 1 層／只列檔案（List）', () => {
    expect(PANE2_NESTED_OFF).toEqual(VIEW_PRESETS.List);
    expect(isPane2Nested(PANE2_NESTED_OFF)).toBe(false);
  });

  it('已勾選＝flat／所有層級／只列檔案（Files），仍是 flat', () => {
    expect(PANE2_NESTED_ON).toEqual(VIEW_PRESETS.Files);
    expect(isPane2Nested(PANE2_NESTED_ON)).toBe(true);
    expect(PANE2_NESTED_ON.mode).toBe('flat');
  });

  it('在兩個 flat 檢視之間互換，不回到 tree', () => {
    expect(togglePane2Nested(PANE2_NESTED_OFF)).toEqual(VIEW_PRESETS.Files);
    expect(togglePane2Nested(PANE2_NESTED_ON)).toEqual(VIEW_PRESETS.List);
    expect(togglePane2Nested(VIEW_PRESETS.List).mode).toBe('flat');
  });

  it('tree 或其他自訂組合一律視為未勾選，勾選後進入 Files', () => {
    expect(isPane2Nested(VIEW_PRESETS.Explorer)).toBe(false);
    expect(isPane2Nested({ mode: 'flat', level: 2, content: 'files' })).toBe(false);
    expect(togglePane2Nested(VIEW_PRESETS.Explorer)).toEqual(VIEW_PRESETS.Files);
  });

  it('回傳新物件，不共用 VIEW_PRESETS 參考', () => {
    const next = togglePane2Nested(PANE2_NESTED_OFF);
    expect(next).not.toBe(PANE2_NESTED_OFF);
    expect(VIEW_PRESETS.List).toEqual({ mode: 'flat', level: 1, content: 'files' });
  });
});
