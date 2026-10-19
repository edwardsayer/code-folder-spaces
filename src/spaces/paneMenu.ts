import type { ViewSettings } from './viewPresets';

export type PaneMenuItem = {
  /** 穩定的選項 id（handler 用它分派，不要用 label 比對）。 */
  id: string;
  /** l10n key（純邏輯層不產生 UI 字串）。 */
  labelKey: string;
  /** 可選的補充說明 l10n key。 */
  descriptionKey?: string;
  /** QuickPick 的打勾狀態。 */
  picked?: boolean;
  /** 不可選（例如 pane2 在 flat 時的 Show Folders）。 */
  disabled?: boolean;
};

export function pane1MenuItems(state: { mode: 'tree' | 'dual' }): PaneMenuItem[] {
  return [
    { id: 'view.tree', labelKey: 'paneMenu.view.tree', picked: state.mode === 'tree' },
    { id: 'view.dual', labelKey: 'paneMenu.view.dual', picked: state.mode === 'dual' },
    { id: 'add.space', labelKey: 'paneMenu.addSpace' },
    { id: 'workspace.folders', labelKey: 'paneMenu.workspaceFolders' },
    { id: 'switch.root', labelKey: 'paneMenu.switchRoot' },
    { id: 'sort', labelKey: 'paneMenu.sort' },
    { id: 'reset.layout', labelKey: 'paneMenu.resetLayout' },
  ];
}

export function pane2MenuItems(view: ViewSettings): PaneMenuItem[] {
  const isFlat = view.mode === 'flat';
  return [
    {
      id: 'folders.toggle',
      labelKey: view.content === 'files' ? 'paneMenu.showFolders' : 'paneMenu.hideFolders',
      ...(isFlat ? { disabled: true, descriptionKey: 'paneMenu.nestedHidesFolders' } : {}),
    },
    {
      id: 'nested.toggle',
      labelKey: isFlat ? 'paneMenu.hideNested' : 'paneMenu.showNested',
    },
    { id: 'switch.root', labelKey: 'paneMenu.switchRoot' },
  ];
}

export function applyPane2MenuChoice(view: ViewSettings, choiceId: string): ViewSettings | null {
  switch (choiceId) {
    case 'folders.toggle':
      if (view.mode === 'flat') return null;
      return { ...view, content: view.content === 'files' ? 'all' : 'files' };
    case 'nested.toggle':
      return view.mode === 'tree'
        ? { ...view, mode: 'flat', content: 'files' }
        : { ...view, mode: 'tree' };
    case 'switch.root':
    default:
      return null;
  }
}
