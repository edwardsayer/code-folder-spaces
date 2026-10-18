import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefaultLayout } from '../../src/spaces/viewState';

const WIN = process.platform === 'win32';
const P = (...parts: string[]): string => path.join(WIN ? 'D:/' : '/d', ...parts);

/**
 * S4.1R19（使用者需求）：全新 workspace 預設 2 個 space，
 * 各自依 Default Preset（pane1）與 Default Child Preset（pane2+）呈現。
 */
describe('S4.1R19 new-workspace default layout presets', () => {
  it('applies primary and child presets to the two default panes', () => {
    const doc = buildDefaultLayout([], 2, true, false, { primary: 'Explorer', child: 'Contents' });
    expect(doc.panes.pane1.preset).toBe('Explorer');
    expect(doc.panes.pane2.preset).toBe('Contents');
  });

  it('keeps pane2 chained to pane1 with follow enabled so it can track directory changes', () => {
    const doc = buildDefaultLayout([], 2, true, false, { primary: 'Explorer', child: 'Contents' });
    expect(doc.panes.pane2.parentPaneId).toBe('pane1');
    expect(doc.panes.pane2.follow).toBe(true);
    expect(doc.panes.pane1.parentPaneId).toBeNull();
  });

  it('falls back to the normalizePane default when no presets are supplied', () => {
    const doc = buildDefaultLayout([], 2, true, false);
    // 未指定時不寫 preset 欄位，由 normalizePane 補預設值（Explorer）
    expect(doc.panes.pane1.preset).toBe('Explorer');
    expect(doc.panes.pane2.preset).toBe('Explorer');
  });

  it('uses configured space roots when spaces are present', () => {
    const doc = buildDefaultLayout(
      [{ basePath: P('proj'), name: 'Proj', icon: undefined, showFiles: true, include: [], exclude: [], sourceIndex: 0 }],
      2, true, false, { primary: 'Items', child: 'Files' },
    );
    expect(doc.panes.pane1.roots).toEqual([P('proj')]);
    expect(doc.panes.pane1.preset).toBe('Items');
    expect(doc.panes.pane2.preset).toBe('Files');
  });
});
