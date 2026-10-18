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
});
