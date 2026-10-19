import { describe, expect, it } from 'vitest';
import { applyPane2MenuChoice, pane1MenuItems, pane2MenuItems } from '../../src/spaces/paneMenu';
import type { ViewSettings } from '../../src/spaces/viewPresets';

describe('pane menu logic', () => {
  it('lists both pane1 modes and marks the current tree mode', () => {
    const items = pane1MenuItems({ mode: 'tree' });
    expect(items).toHaveLength(7);
    expect(items.find(item => item.id === 'view.tree')?.picked).toBe(true);
    expect(items.find(item => item.id === 'view.dual')?.picked).toBe(false);
  });

  it('marks dual mode as picked', () => {
    const items = pane1MenuItems({ mode: 'dual' });
    expect(items).toHaveLength(7);
    expect(items.find(item => item.id === 'view.dual')?.picked).toBe(true);
  });

  it('disables the folders choice while nested files are shown', () => {
    const folders = pane2MenuItems({ mode: 'flat', level: 'all', content: 'all' }).find(item => item.id === 'folders.toggle');
    expect(folders?.disabled).toBe(true);
    expect(folders?.descriptionKey).toBe('paneMenu.nestedHidesFolders');
  });

  it('uses show labels for files-only tree mode', () => {
    const items = pane2MenuItems({ mode: 'tree', level: 'all', content: 'files' });
    expect(items.find(item => item.id === 'folders.toggle')?.labelKey).toBe('paneMenu.showFolders');
    expect(items.find(item => item.id === 'nested.toggle')?.labelKey).toBe('paneMenu.showNested');
  });

  it('uses hide folders when folders are currently included', () => {
    expect(pane2MenuItems({ mode: 'tree', level: 'all', content: 'all' }).find(item => item.id === 'folders.toggle')?.labelKey)
      .toBe('paneMenu.hideFolders');
  });

  it('does not change folders while flat mode is active', () => {
    expect(applyPane2MenuChoice({ mode: 'flat', level: 'all', content: 'all' }, 'folders.toggle')).toBeNull();
  });

  it('shows folders by switching files-only content to all', () => {
    expect(applyPane2MenuChoice({ mode: 'tree', level: 'all', content: 'files' }, 'folders.toggle'))
      .toEqual({ mode: 'tree', level: 'all', content: 'all' });
  });

  it('forces files-only content when enabling nested mode', () => {
    expect(applyPane2MenuChoice({ mode: 'tree', level: 'all', content: 'folders' }, 'nested.toggle'))
      .toEqual({ mode: 'flat', level: 'all', content: 'files' });
  });

  it('preserves content when disabling nested mode', () => {
    expect(applyPane2MenuChoice({ mode: 'flat', level: 'all', content: 'files' }, 'nested.toggle'))
      .toEqual({ mode: 'tree', level: 'all', content: 'files' });
  });

  it('includes close and does not implement root switching or close as view changes', () => {
    const view: ViewSettings = { mode: 'tree', level: 'all', content: 'all' };
    expect(pane2MenuItems(view).some(item => item.id === 'close')).toBe(true);
    expect(applyPane2MenuChoice(view, 'switch.root')).toBeNull();
    expect(applyPane2MenuChoice(view, 'close')).toBeNull();
    expect(applyPane2MenuChoice(view, 'unknown')).toBeNull();
  });

  it('has unique ids in each pane menu', () => {
    for (const items of [pane1MenuItems({ mode: 'tree' }), pane2MenuItems({ mode: 'tree', level: 'all', content: 'all' })]) {
      expect(new Set(items.map(item => item.id)).size).toBe(items.length);
    }
  });
});
