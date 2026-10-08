import * as path from 'node:path';
import type { ViewPresetName } from './viewPresets';
import { DEFAULT_VIEW_PRESET, isViewPresetName } from './viewPresets';

export const PANE_STATE_KEY = 'codeFolderSpaces.panes.v1';

export type SortKey = 'name' | 'mtime' | 'ctime';
export type SortDirection = 'asc' | 'desc';

export interface SpaceViewState {
  [key: string]: unknown;
  preset: ViewPresetName;
  filter: string;
  sort: { key: SortKey; direction: SortDirection };
}

interface PaneStateDocument {
  [key: string]: unknown;
  version: 1;
  bySpace: Record<string, SpaceViewState>;
}

/** Normalize per-space keys consistently with the host platform's path semantics. */
export function normalizeSpaceKey(basePath: string): string {
  const normalized = path.normalize(basePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export function normalizePaneState(value: unknown): PaneStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: 1, bySpace: {} };
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !source.bySpace || typeof source.bySpace !== 'object' || Array.isArray(source.bySpace)) {
    return { version: 1, bySpace: {} };
  }
  const bySpace: Record<string, SpaceViewState> = {};
  for (const [basePath, raw] of Object.entries(source.bySpace as Record<string, unknown>)) {
    const preset = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).preset : undefined;
    const state = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sort = state.sort && typeof state.sort === 'object' ? state.sort as Record<string, unknown> : {};
    const key = sort.key === 'mtime' || sort.key === 'ctime' ? sort.key : 'name';
    const direction = sort.direction === 'desc' ? 'desc' : 'asc';
    bySpace[normalizeSpaceKey(basePath)] = {
      ...state,
      preset: isViewPresetName(preset) ? preset : DEFAULT_VIEW_PRESET,
      filter: typeof state.filter === 'string' ? state.filter : '',
      sort: { key, direction },
    };
  }
  // 保留未知欄位，避免 S4 等後續版本新增的 pane／per-space 狀態在本版更新時被抹除。
  return { ...source, version: 1, bySpace };
}

/** Per-window state adapter. Schema normalization is isolated for unit testing. */
export class PaneStateStore {
  private state: PaneStateDocument;

  constructor(private readonly memento: MementoLike) {
    this.state = normalizePaneState(memento.get<unknown>(PANE_STATE_KEY));
  }

  get(basePath: string): SpaceViewState {
    return this.state.bySpace[normalizeSpaceKey(basePath)] ?? { preset: DEFAULT_VIEW_PRESET, filter: '', sort: { key: 'name', direction: 'asc' } };
  }

  async setPreset(basePath: string, preset: ViewPresetName): Promise<void> {
    await this.update(basePath, { ...this.get(basePath), preset });
  }

  async setFilter(basePath: string, filter: string): Promise<void> {
    await this.update(basePath, { ...this.get(basePath), filter });
  }

  async clearFilter(basePath: string): Promise<void> {
    await this.setFilter(basePath, '');
  }

  async setSort(basePath: string, key: SortKey, direction: SortDirection): Promise<void> {
    await this.update(basePath, { ...this.get(basePath), sort: { key, direction } });
  }

  private async update(basePath: string, value: SpaceViewState): Promise<void> {
    this.state.bySpace[normalizeSpaceKey(basePath)] = value;
    await this.memento.update(PANE_STATE_KEY, this.state);
  }
}
