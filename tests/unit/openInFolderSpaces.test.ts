import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

/**
 * S4.1R17：F-46 `Open in Folder Spaces` 的 manifest 契約。
 * 直接讀真實 package.json（不複製檢查邏輯），確認命令與 Explorer 右鍵入口都存在且
 * `when` 條件足以避免誤觸（非資料夾／根／多選時不出現）。
 */
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
  };
};

describe('F-46 Open in Folder Spaces manifest contract', () => {
  const id = 'codeFolderSpaces.openInFolderSpaces';

  it('contributes the command with an l10n title', () => {
    const entry = pkg.contributes.commands.find(command => command.command === id);
    expect(entry, 'command 必須存在').toBeDefined();
    // 標題走 nls placeholder（不得硬編碼中英文字面值）
    expect(entry?.title).toBe('%command.openInFolderSpaces.title%');
  });

  it('registers an explorer/context entry restricted to folders', () => {
    const items = pkg.contributes.menus['explorer/context'] ?? [];
    const entry = items.find(item => item.command === id);
    expect(entry, 'explorer/context 必須有這個命令').toBeDefined();
    const when = entry?.when ?? '';
    expect(when).toContain('explorerResourceIsFolder');
    // 多選時不應出現（避免對多個資料夾一鍵開 pane）
    expect(when).toContain('!listMultiSelection');
    // 檔案系統根不宜直接當 space 根
    expect(when).toContain('!explorerResourceIsRoot');
    expect(when).toContain('resourceScheme == file');
  });

  it('is not hidden from the command palette (users can run it directly too)', () => {
    const palette = pkg.contributes.menus.commandPalette ?? [];
    const hidden = palette.some(item => item.command === id && item.when === 'false');
    expect(hidden).toBe(false);
  });
});
