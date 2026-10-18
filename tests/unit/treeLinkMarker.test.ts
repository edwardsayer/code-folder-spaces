import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ TreeItem: class {} }));

import { applyPaneLinkMarker } from '../../src/spaces/spaceTreeDataProvider';

describe('space tree pane-link marker', () => {
  it('sets a folder description when the injected callback returns a marker', () => {
    const item: { description?: string; tooltip: string } = { tooltip: '/parent/target' };

    expect(applyPaneLinkMarker(item, 'pane1', '/parent/target', true, () => '→ Folder Space 2')).toBe(item);
    expect(item.description).toBe('→ Folder Space 2');
    expect(item.tooltip).toBe('/parent/target');
  });

  it('keeps the description absent when no marker is returned or the item is not a folder', () => {
    const noLink: { description?: string } = {};
    applyPaneLinkMarker(noLink, 'pane1', '/parent/other', true, () => undefined);
    expect(noLink.description).toBeUndefined();

    const file: { description?: string } = {};
    applyPaneLinkMarker(file, 'pane1', '/parent/target.txt', false, () => '→ Folder Space 2');
    expect(file.description).toBeUndefined();
  });

  // S4.1R15：label.highlights 原生高亮（比 description 尾巴標記明顯）
  it('highlights the whole label of a linked folder and restores it afterwards', () => {
    const item: { label?: string | { label: string; highlights?: [number, number][] }; description?: string } = { label: 'childA' };

    applyPaneLinkMarker(item, 'pane1', '/parent/childA', true, () => '→ Folder Space 2');
    expect(item.label).toEqual({ label: 'childA', highlights: [[0, 6]] });

    // 連動結束（callback 回 undefined）→ 還原為純字串，不殘留高亮
    applyPaneLinkMarker(item, 'pane1', '/parent/childA', true, () => undefined);
    expect(item.label).toBe('childA');
    expect(item.description).toBeUndefined();
  });

  it('does not highlight file rows even when a marker exists', () => {
    const file: { label?: string | { label: string; highlights?: [number, number][] }; description?: string } = { label: 'a.txt' };
    applyPaneLinkMarker(file, 'pane1', '/parent/a.txt', false, () => '→ Folder Space 2');
    expect(file.label).toBe('a.txt');
    expect(file.description).toBeUndefined();
  });

  it('keeps an already-object label untouched when no marker is returned', () => {
    const item: { label?: string | { label: string; highlights?: [number, number][] } } = {
      label: { label: 'custom', highlights: [[1, 2]] },
    };
    applyPaneLinkMarker(item, 'pane1', '/parent/x', true, () => undefined);
    // 只還原「字串化」的 label；本來就是物件的保持原樣（不誤刪其他高亮來源）
    expect(item.label).toEqual({ label: 'custom', highlights: [[1, 2]] });
  });
});
