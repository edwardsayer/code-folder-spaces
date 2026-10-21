import * as path from 'node:path';
import { VIEW_PRESETS, isViewSettings, type ViewSettings } from './viewPresets';

export const LAYOUT_KEY = 'codeFolderSpaces.layout.v1';
export const LEGACY_PANE_STATE_KEY = 'codeFolderSpaces.panes.v3';
export const LEGACY_PANE_STATE_V2_KEY = 'codeFolderSpaces.panes.v2';
export const LEGACY_PANE_STATE_V1_KEY = 'codeFolderSpaces.panes.v1';

export type LayoutMode = 'tree' | 'dual';
export type PaneSlot = 'primary' | 'secondary';
export type SortKey = 'name' | 'mtime' | 'ctime';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export interface DrillEntry {
  root: string;
  view: ViewSettings;
  filter: string;
  sort: SortState;
}

export interface LayoutPaneState {
  roots: string[];
  drillRoot: string | null;
  drillStack: DrillEntry[];
  filter: string;
  sort: SortState;
  view: ViewSettings;
  icon: string | null;
  include: string[];
  exclude: string[];
}

export interface LayoutDocument {
  version: 1;
  mode: LayoutMode;
  primary: LayoutPaneState;
  secondary: LayoutPaneState;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface LayoutInitContext {
  primaryRoot?: string;
  primaryView?: ViewSettings;
}

export type LayoutInitOutcome = { kind: 'restored' | 'created' | 'rebuilt'; reason?: string };

const DEFAULT_SORT: SortState = { key: 'name', direction: 'asc' };

function normalizedPath(value: string): string {
  return path.normalize(value);
}

function pathKey(value: string): string {
  const normalized = normalizedPath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeSort(value: unknown): SortState {
  const sort = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    key: sort.key === 'mtime' || sort.key === 'ctime' ? sort.key : 'name',
    direction: sort.direction === 'desc' ? 'desc' : 'asc',
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeView(value: unknown): ViewSettings {
  return isViewSettings(value) ? { mode: value.mode, level: value.level, content: value.content } : { ...VIEW_PRESETS.Explorer };
}

function normalizeDrillStack(value: unknown): DrillEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: DrillEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.root !== 'string') continue;
    entries.push({
      root: normalizedPath(entry.root),
      view: normalizeView(entry.view),
      filter: typeof entry.filter === 'string' ? entry.filter : '',
      sort: normalizeSort(entry.sort),
    });
  }
  return entries;
}

function normalizePane(value: unknown): LayoutPaneState {
  const pane = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    roots: strings(pane.roots).map(normalizedPath),
    drillRoot: typeof pane.drillRoot === 'string' ? normalizedPath(pane.drillRoot) : null,
    drillStack: normalizeDrillStack(pane.drillStack),
    filter: typeof pane.filter === 'string' ? pane.filter : '',
    sort: normalizeSort(pane.sort),
    view: normalizeView(pane.view),
    icon: typeof pane.icon === 'string' ? pane.icon : null,
    include: strings(pane.include),
    exclude: strings(pane.exclude),
  };
}

export function defaultLayoutPane(): LayoutPaneState {
  return {
    roots: [],
    drillRoot: null,
    drillStack: [],
    filter: '',
    sort: { ...DEFAULT_SORT },
    view: { ...VIEW_PRESETS.Explorer },
    icon: null,
    include: [],
    exclude: [],
  };
}

export function normalizeLayout(value: unknown): LayoutDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (document.version !== 1 || (document.mode !== 'tree' && document.mode !== 'dual')) return null;
  if (!document.primary || typeof document.primary !== 'object' || Array.isArray(document.primary)) return null;
  if (!document.secondary || typeof document.secondary !== 'object' || Array.isArray(document.secondary)) return null;
  return {
    version: 1,
    mode: document.mode,
    primary: normalizePane(document.primary),
    secondary: normalizePane(document.secondary),
  };
}

export function buildDefaultLayout(ctx: LayoutInitContext = {}): LayoutDocument {
  const primary = defaultLayoutPane();
  primary.roots = ctx.primaryRoot ? [normalizedPath(ctx.primaryRoot)] : [];
  primary.view = ctx.primaryView ? normalizeView(ctx.primaryView) : { ...VIEW_PRESETS.Explorer };
  const secondary = defaultLayoutPane();
  // v2.1（使用者）：pane2 預設改為 flat 第 1 層檔案清單（List），不再預設列出全部層級。
  secondary.view = { ...VIEW_PRESETS.List };
  return { version: 1, mode: 'tree', primary, secondary };
}

function slotFor(paneId: string): PaneSlot {
  return paneId === 'pane1' ? 'primary' : 'secondary';
}

function activeRoot(pane: LayoutPaneState): string | null {
  return pane.drillRoot ?? pane.roots[0] ?? null;
}

function clearDrill(pane: LayoutPaneState): void {
  pane.drillRoot = null;
  pane.drillStack = [];
}

function rewritePath(value: string, oldPath: string, newPath: string): string {
  const candidate = normalizedPath(value);
  const oldNormalized = normalizedPath(oldPath);
  const relative = path.relative(oldNormalized, candidate);
  const contained = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return contained ? normalizedPath(path.join(newPath, relative)) : candidate;
}

export class LayoutStore {
  private document: LayoutDocument | undefined;
  private context: LayoutInitContext = {};

  /**
   * v2-R1：建構時即嘗試載入既有文檔（與舊 `PaneStateStore` 的同步載入語意一致）。
   * `initialize(ctx)` 仍負責在缺省／損壞時以 context 重建並持久化；兩者不衝突。
   */
  constructor(private readonly memento: MementoLike) {
    this.document = normalizeLayout(memento.get<unknown>(LAYOUT_KEY)) ?? undefined;
  }

  setContext(ctx: LayoutInitContext): void {
    this.context = { ...ctx };
  }

  async initialize(ctx: LayoutInitContext): Promise<LayoutInitOutcome> {
    this.setContext(ctx);
    const stored = this.memento.get<unknown>(LAYOUT_KEY);
    const normalized = normalizeLayout(stored);
    if (normalized) {
      this.document = normalized;
      return { kind: 'restored' };
    }
    this.document = buildDefaultLayout(this.context);
    await this.persist();
    return stored === undefined ? { kind: 'created' } : { kind: 'rebuilt', reason: 'Invalid layout document' };
  }

  getDocument(): LayoutDocument {
    if (!this.document) this.document = buildDefaultLayout(this.context);
    return this.document;
  }

  getMode(): LayoutMode {
    return this.getDocument().mode;
  }

  getPane(slot: PaneSlot): LayoutPaneState {
    return this.getDocument()[slot];
  }

  get(paneId: string): LayoutPaneState {
    return this.getPane(slotFor(paneId));
  }

  async setMode(mode: LayoutMode): Promise<void> {
    const document = this.getDocument();
    if (mode !== document.mode) {
      document.mode = mode;
      if (mode === 'dual' && document.secondary.roots.length === 0) {
        const root = activeRoot(document.primary);
        if (root !== null) {
          document.secondary.roots = [root];
          clearDrill(document.secondary);
        }
      }
    }
    await this.persist();
  }

  async setView(paneId: string, view: ViewSettings): Promise<void> {
    this.get(paneId).view = normalizeView(view);
    await this.persist();
  }

  async switchRoot(paneId: string, root: string | null): Promise<void> {
    const pane = this.get(paneId);
    pane.roots = root === null ? [] : [normalizedPath(root)];
    clearDrill(pane);
    await this.persist();
  }

  async addPaneRoot(paneId: string, root: string): Promise<boolean> {
    const pane = this.get(paneId);
    const normalized = normalizedPath(root);
    if (pane.roots.some(existing => pathKey(existing) === pathKey(normalized))) return false;
    pane.roots.push(normalized);
    await this.persist();
    return true;
  }

  async removePaneRoot(paneId: string, root: string): Promise<boolean> {
    const pane = this.get(paneId);
    const key = pathKey(root);
    const roots = pane.roots.filter(existing => pathKey(existing) !== key);
    if (roots.length === pane.roots.length) return false;
    pane.roots = roots;
    if (pane.drillRoot && pathKey(pane.drillRoot) === key) clearDrill(pane);
    await this.persist();
    return true;
  }

  async setPaneRoots(paneId: string, roots: string[]): Promise<void> {
    const pane = this.get(paneId);
    const normalized = roots.map(normalizedPath);
    const changed = normalized.length !== pane.roots.length || normalized.some((root, index) => pathKey(root) !== pathKey(pane.roots[index]));
    pane.roots = normalized;
    if (changed) clearDrill(pane);
    await this.persist();
  }

  async setFilter(paneId: string, filter: string): Promise<void> {
    this.get(paneId).filter = filter;
    await this.persist();
  }

  async clearFilter(paneId: string): Promise<void> {
    await this.setFilter(paneId, '');
  }

  async setSort(paneId: string, key: SortKey, direction: SortDirection): Promise<void> {
    this.get(paneId).sort = { key, direction };
    await this.persist();
  }

  async drillDown(paneId: string, root: string, childView?: ViewSettings): Promise<void> {
    const pane = this.get(paneId);
    const current = activeRoot(pane);
    if (current !== null) pane.drillStack.push({ root: current, view: { ...pane.view }, filter: pane.filter, sort: { ...pane.sort } });
    pane.drillRoot = normalizedPath(root);
    if (childView) pane.view = normalizeView(childView);
    await this.persist();
  }

  async drillUp(paneId: string): Promise<boolean> {
    const pane = this.get(paneId);
    const entry = pane.drillStack.pop();
    if (!entry) return false;
    // 堆疊清空＝回到頂層（drillRoot 必須為 null，不可沿用 entry.root）；否則還原上一層下鑽根。
    pane.drillRoot = pane.drillStack.length === 0 ? null : entry.root;
    pane.view = { ...entry.view };
    pane.filter = entry.filter;
    pane.sort = { ...entry.sort };
    await this.persist();
    return true;
  }

  async resetRoot(paneId: string): Promise<void> {
    const pane = this.get(paneId);
    clearDrill(pane);
    await this.persist();
  }

  async rewriteRoots(oldPath: string, newPath: string): Promise<void> {
    const document = this.getDocument();
    for (const pane of [document.primary, document.secondary]) {
      pane.roots = pane.roots.map(root => rewritePath(root, oldPath, newPath));
      if (pane.drillRoot) pane.drillRoot = rewritePath(pane.drillRoot, oldPath, newPath);
      pane.drillStack = pane.drillStack.map(entry => ({ ...entry, root: rewritePath(entry.root, oldPath, newPath) }));
    }
    await this.persist();
  }

  async reset(): Promise<void> {
    this.document = buildDefaultLayout(this.context);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.memento.update(LAYOUT_KEY, this.getDocument());
  }
}
