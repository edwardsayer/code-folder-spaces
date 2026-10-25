import { describe, expect, it } from 'vitest';
import { PANE2_NESTED_OFF, PANE2_NESTED_ON, isPane2Nested, togglePane2Nested, VIEW_PRESETS, getPane2ViewMode, cyclePane2ViewMode } from '../../src/spaces/viewPresets';

describe('pane2 檢視模式切換（v22-R5 三態 Toggle View Mode）', () => {
  it('判斷模式：Explorer、File List、Nested File List', () => {
    expect(getPane2ViewMode(VIEW_PRESETS.Explorer)).toBe('explorer');
    expect(getPane2ViewMode(VIEW_PRESETS.List)).toBe('fileList');
    expect(getPane2ViewMode(VIEW_PRESETS.Files)).toBe('nestedFileList');
  });

  it('循環切換：Explorer -> File List -> Nested File List -> Explorer', () => {
    const s1 = cyclePane2ViewMode(VIEW_PRESETS.Explorer);
    expect(s1).toEqual(VIEW_PRESETS.List);
    const s2 = cyclePane2ViewMode(s1);
    expect(s2).toEqual(VIEW_PRESETS.Files);
    const s3 = cyclePane2ViewMode(s2);
    expect(s3).toEqual(VIEW_PRESETS.Explorer);
  });
});

describe('pane2 巢狀檔案切換（v2.1，相容保留）', () => {
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
