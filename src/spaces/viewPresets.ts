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

export type ViewAxis = 'mode' | 'level' | 'content';

/** 檢視設定：模式 × 層級 × 內容三個獨立維度（預設集只是一鍵套用三值的捷徑，S4.1R7／OP-14）。 */
export type ViewSettings = ViewPreset;

export function isViewSettings(value: unknown): value is ViewSettings {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (item.mode === 'tree' || item.mode === 'flat')
    && (item.level === 1 || item.level === 2 || item.level === 'all')
    && (item.content === 'all' || item.content === 'folders' || item.content === 'files');
}

/** 以單一維度更新檢視設定；其餘兩維保持不變（組合不必落在任何預設集內）。 */
export type ViewAxisChange =
  | { axis: 'mode'; value: ViewMode }
  | { axis: 'level'; value: ViewLevel }
  | { axis: 'content'; value: ViewContent };

export function applyViewAxis(view: ViewSettings, axis: 'mode', value: ViewMode): ViewSettings;
export function applyViewAxis(view: ViewSettings, axis: 'level', value: ViewLevel): ViewSettings;
export function applyViewAxis(view: ViewSettings, axis: 'content', value: ViewContent): ViewSettings;
export function applyViewAxis(view: ViewSettings, axis: ViewAxis, value: ViewMode | ViewLevel | ViewContent): ViewSettings {
  return { ...view, [axis]: value } as ViewSettings;
}

/** 目前設定恰好等於某預設集時回傳其名稱，否則 undefined（自訂組合）。 */
export function matchPresetName(view: ViewSettings): ViewPresetName | undefined {
  return (Object.keys(VIEW_PRESETS) as ViewPresetName[]).find(name => {
    const preset = VIEW_PRESETS[name];
    return preset.mode === view.mode && preset.level === view.level && preset.content === view.content;
  });
}

/**
 * OP-13：讀取 Obsidian 原版四項設定的安全解析函式。
 */
export function resolveConfiguredDefaultPreset(configured?: unknown): ViewPresetName {
  return isViewPresetName(configured) ? configured : DEFAULT_VIEW_PRESET;
}

export function resolveConfiguredDefaultChildPreset(configured?: unknown): ViewPresetName {
  return isViewPresetName(configured) ? configured : 'Contents';
}

export function resolveConfiguredCascadeParentPreset(configured?: unknown): ViewPresetName {
  return isViewPresetName(configured) ? configured : 'Navigate';
}
