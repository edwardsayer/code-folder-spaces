import { describe, expect, it } from 'vitest';
import { FILE_ACTION_KINDS, focusItemKindOf } from '../../src/spaces/focusItem';

// keys/R2：keybinding 的 `when` 不能用 `viewItem`（在 keybinding 恆為 false），
// 改以 `codeFolderSpaces.<pane>.focusItem` 承載「目前選取項目種類」。
describe('focusItemKindOf', () => {
  it('把節點 contextValue 對應到快捷鍵種類', () => {
    expect(focusItemKindOf('codeFolderSpaces.file')).toBe('file');
    expect(focusItemKindOf('codeFolderSpaces.folder')).toBe('folder');
    expect(focusItemKindOf('codeFolderSpaces.file.code-workspace')).toBe('code-workspace');
    expect(focusItemKindOf('codeFolderSpaces.spaceRoot')).toBe('spaceRoot');
    expect(focusItemKindOf('codeFolderSpaces.spaceRoot.global')).toBe('spaceRootGlobal');
    expect(focusItemKindOf('codeFolderSpaces.flatRootGroup')).toBe('flatRootGroup');
  });

  it('無選取與未知 contextValue 一律回 none（不得沿用上一輪值）', () => {
    expect(focusItemKindOf(undefined)).toBe('none');
    expect(focusItemKindOf('')).toBe('none');
    expect(focusItemKindOf('codeFolderSpaces.somethingNew')).toBe('none');
  });

  it('檔案操作允許的種類集合只涵蓋 file 與 folder（與既有 keybinding 意圖一致）', () => {
    const pattern = new RegExp(FILE_ACTION_KINDS);
    expect(pattern.test('file')).toBe(true);
    expect(pattern.test('folder')).toBe(true);
    for (const kind of ['code-workspace', 'spaceRoot', 'spaceRootGlobal', 'flatRootGroup', 'none']) {
      expect(pattern.test(kind)).toBe(false);
    }
  });
});
