import * as path from 'node:path';
import type { ViewPresetName } from './viewPresets';
import { DEFAULT_VIEW_PRESET, isViewPresetName } from './viewPresets';

export const PANE_STATE_KEY = 'codeFolderSpaces.panes.v1';

export type SortKey = 'name' | 'mtime' | 'ctime';
export type SortDirection = 'asc' | 'desc';

export interface ViewStateSnapshot {
  root: string;
  preset: ViewPresetName;
  filter: string;
  sort: { key: SortKey; direction: SortDirection };
}

export interface SpaceViewState {
  [key: string]: unknown;
  root?: string;
  drillStack?: ViewStateSnapshot[];
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
    const drillStack = Array.isArray(state.drillStack) ? state.drillStack.filter(isSnapshot).map(snapshot => ({
      ...snapshot,
      root: normalizeSpaceKey(snapshot.root),
      sort: { ...snapshot.sort },
    })) : [];
    bySpace[normalizeSpaceKey(basePath)] = {
      ...state,
      ...(typeof state.root === 'string' ? { root: path.normalize(state.root) } : {}),
      drillStack,
      preset: isViewPresetName(preset) ? preset : DEFAULT_VIEW_PRESET,
      filter: typeof state.filter === 'string' ? state.filter : '',
      sort: { key, direction },
    };
  }
  // 保留未知欄位，避免 S4 等後續版本新增的 pane／per-space 狀態在本版更新時被抹除。
  return { ...source, version: 1, bySpace };
}

/** Per-window state adapter. Schema normalization is isolated for unit testing. */
function isSnapshot(value: unknown): value is ViewStateSnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const sort = item.sort as Record<string, unknown> | undefined;
  return typeof item.root === 'string' && isViewPresetName(item.preset) && typeof item.filter === 'string' &&
    Boolean(sort && (sort.key === 'name' || sort.key === 'mtime' || sort.key === 'ctime') &&
      (sort.direction === 'asc' || sort.direction === 'desc'));
}

/** Rewrite normalized space keys and all root references after a filesystem rename. */
export type RenameImpact = { kind: 'space-root' } | { kind: 'inside-space'; basePath: string } | { kind: 'unrelated' };

export function classifySpaceRename(basePaths: string[], oldPath: string): RenameImpact {
  const exact = basePaths.find(basePath => normalizeSpaceKey(basePath) === normalizeSpaceKey(oldPath));
  if (exact) return { kind: 'space-root' };
  const containing = basePaths.find(basePath => isPathWithin(normalizeSpaceKey(oldPath), normalizeSpaceKey(basePath)));
  return containing ? { kind: 'inside-space', basePath: containing } : { kind: 'unrelated' };
}

export function rewriteRenamedPath(value: unknown, basePath: string, oldPath: string, newPath: string): PaneStateDocument {
  const document = normalizePaneState(value);
  const key = normalizeSpaceKey(basePath);
  const state = document.bySpace[key];
  if (state) document.bySpace[key] = rewriteRoots(state, oldPath, newPath);
  return document;
}

export function renameSpaceKeys(value: unknown, oldPath: string, newPath: string): PaneStateDocument {
  const document = normalizePaneState(value);
  const oldKey = normalizeSpaceKey(oldPath);
  const newKey = normalizeSpaceKey(newPath);
  if (oldKey === newKey) return document;
  const changes = Object.entries(document.bySpace).filter(([key]) => isPathWithin(key, oldKey));
  for (const [key] of changes) {
    const destination = normalizeSpaceKey(newPath + key.slice(oldKey.length));
    if (document.bySpace[destination] && !changes.some(([source]) => source === destination)) {
      throw new Error(`Pane state rename collision: ${destination}`);
    }
  }
  for (const [key, state] of changes) {
    delete document.bySpace[key];
    const destination = normalizeSpaceKey(newPath + key.slice(oldKey.length));
    document.bySpace[destination] = rewriteRoots(state, oldPath, newPath);
  }
  return document;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rewriteRoots(state: SpaceViewState, oldPath: string, newPath: string): SpaceViewState {
  const rewrite = (root: string): string => isPathWithin(normalizeSpaceKey(root), normalizeSpaceKey(oldPath))
    ? path.join(newPath, path.relative(oldPath, root)) : root;
  return { ...state, ...(state.root ? { root: rewrite(state.root) } : {}), drillStack: state.drillStack?.map(item => ({ ...item, root: rewrite(item.root) })) };
}

export class PaneStateStore {
  private state: PaneStateDocument;

  constructor(private readonly memento: MementoLike) {
    this.state = normalizePaneState(memento.get<unknown>(PANE_STATE_KEY));
  }

  get(basePath: string): SpaceViewState {
    return this.state.bySpace[normalizeSpaceKey(basePath)] ?? { preset: DEFAULT_VIEW_PRESET, filter: '', sort: { key: 'name', direction: 'asc' } };
  }

  async ensureRoot(basePath: string): Promise<string> {
    const state = this.get(basePath);
    if (state.root) return state.root;
    await this.update(basePath, { ...state, root: basePath, drillStack: [] });
    return basePath;
  }

  async drillDown(basePath: string, root: string): Promise<void> {
    const state = this.get(basePath);
    const currentRoot = state.root ?? basePath;
    const stack = [...(state.drillStack ?? []), { root: currentRoot, preset: state.preset, filter: state.filter, sort: { ...state.sort } }];
    await this.update(basePath, { ...state, root, drillStack: stack, preset: 'Explorer' });
  }

  async drillUp(basePath: string): Promise<boolean> {
    const state = this.get(basePath);
    const stack = [...(state.drillStack ?? [])];
    const previous = stack.pop();
    if (!previous) return false;
    await this.update(basePath, { ...state, ...previous, drillStack: stack });
    return true;
  }

  async resetRoot(basePath: string): Promise<void> {
    await this.switchRoot(basePath, basePath);
  }

  /** 切換根是重置 stack 的粗粒度操作；drillDown／drillUp 才是堆疊操作。 */
  async switchRoot(basePath: string, root: string): Promise<void> {
    await this.update(basePath, { ...this.get(basePath), root, drillStack: [] });
  }

  async migrateRename(oldPath: string, newPath: string): Promise<void> {
    this.state = renameSpaceKeys(this.state, oldPath, newPath);
    await this.memento.update(PANE_STATE_KEY, this.state);
  }

  async rewriteRename(basePath: string, oldPath: string, newPath: string): Promise<void> {
    this.state = rewriteRenamedPath(this.state, basePath, oldPath, newPath);
    await this.memento.update(PANE_STATE_KEY, this.state);
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
