export type ViewMode = 'tree' | 'flat';
export type ViewLevel = 1 | 2 | 'all';
export type ViewContent = 'all' | 'folders' | 'files';
export type ViewPresetName = 'Explorer' | 'Navigate' | 'Columns' | 'Context' | 'Contents' | 'Files' | 'List';

export interface ViewPreset {
  readonly mode: ViewMode;
  readonly level: ViewLevel;
  readonly content: ViewContent;
}

export const VIEW_PRESETS: Readonly<Record<ViewPresetName, ViewPreset>> = {
  Explorer: { mode: 'tree', level: 'all', content: 'all' },
  Navigate: { mode: 'tree', level: 'all', content: 'folders' },
  Columns: { mode: 'tree', level: 1, content: 'folders' },
  Context: { mode: 'tree', level: 2, content: 'folders' },
  Contents: { mode: 'flat', level: 'all', content: 'all' },
  Files: { mode: 'flat', level: 'all', content: 'files' },
  List: { mode: 'flat', level: 1, content: 'files' },
};

export const DEFAULT_VIEW_PRESET: ViewPresetName = 'Explorer';

export function isViewPresetName(value: unknown): value is ViewPresetName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VIEW_PRESETS, value);
}
