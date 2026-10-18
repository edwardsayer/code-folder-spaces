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

  // S4.1R16：label.highlights 已撤回（使用者認為不足以表現父子連動），label 不得被改動。
  it('never rewrites the label (highlights were withdrawn in S4.1R16)', () => {
    const item: { label?: string; description?: string } = { label: 'childA' };
    applyPaneLinkMarker(item, 'pane1', '/parent/childA', true, () => '→ Folder Space 2');
    expect(item.label).toBe('childA');
    expect(item.description).toBe('→ Folder Space 2');
  });
});
