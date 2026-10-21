import { describe, expect, it } from 'vitest';
import { GLOBAL_PANE_TITLE, paneTitleFor } from '../../src/spaces/paneTitle';

describe('pane1 標題（v21-R6 使用者設計）', () => {
  it('workspace／專案資料夾：以名稱為標題', () => {
    expect(paneTitleFor({ workspaceName: 'FET-Trans', rootCount: 1 })).toBe('FET-Trans');
    expect(paneTitleFor({ workspaceName: 'my-project', rootCount: 1 })).toBe('my-project');
  });

  it('多個 root 時採用「名稱 + n」', () => {
    expect(paneTitleFor({ workspaceName: 'my-project', rootCount: 3 })).toBe('my-project 3');
    expect(paneTitleFor({ workspaceName: 'FET-Trans', rootCount: 2 })).toBe('FET-Trans 2');
  });

  it('沒有 workspace／專案時顯示 Global（0 或 1 個 root 皆同）', () => {
    expect(paneTitleFor({ rootCount: 0 })).toBe(GLOBAL_PANE_TITLE);
    expect(paneTitleFor({ rootCount: 1 })).toBe('Global');
  });

  it('沒有 workspace 但有多個 global root 時仍是「Global + n」', () => {
    expect(paneTitleFor({ rootCount: 2 })).toBe('Global 2');
  });

  it('空白名稱視為沒有名稱（回 Global）', () => {
    expect(paneTitleFor({ workspaceName: '   ', rootCount: 1 })).toBe(GLOBAL_PANE_TITLE);
  });
});
