import * as path from 'node:path';
import type { SpaceDefinition } from '../types';
import type { ViewAxisChange, ViewPresetName, ViewSettings } from './viewPresets';
import { DEFAULT_VIEW_PRESET, VIEW_PRESETS, applyViewAxis, isViewPresetName, isViewSettings, matchPresetName } from './viewPresets';
import { detachChildrenOf, hasValidPaneLinks, normalizePaneChains, reattachChildren, wouldCreateCycle } from './paneLinks';

/** Current workspaceState key (S4R6-D63: per-pane view state, no more `bySpace`). */
export const PANE_STATE_KEY = 'codeFolderSpaces.panes.v3';
/** Previous per-pane state schema. */
export const LEGACY_PANE_STATE_KEY = 'codeFolderSpaces.panes.v2';
/** Legacy v1 key that stores shared per-space view state; cleared once migrated. */
export const LEGACY_V1_PANE_STATE_KEY = 'codeFolderSpaces.panes.v1';

export type SortKey = 'name' | 'mtime' | 'ctime';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export interface ViewStateSnapshot {
  root: string;
  preset: ViewPresetName;
  /** 自訂組合（不在任何預設集內）；缺省＝由 preset 決定。 */
  view?: ViewSettings;
  filter: string;
  sort: SortState;
}

/**
 * Pane link view (root + chain + follow). Kept as the compat projection of
 * `PaneState` for cascade/validation callers (S4R6-D63).
 */
export interface PaneLinkState {
  root: string | null;
  parentPaneId: string | null;
  follow: boolean;
}

/**
 * Full per-pane state (spec §2.4.2). Unknown fields are preserved on read/write
 * so forward-compatible keys are not erased by this version.
 */
export interface PaneState {
  [key: string]: unknown;
  roots: string[];
  drillRoot: string | null;
  parentPaneId: string | null;
  follow: boolean;
  followWorkspaceDirectory: boolean;
  /** 最近套用（或目前符合）的預設集名稱；`view` 存在時以 `view` 為準。 */
  preset: ViewPresetName;
  /** S4.1R7：自訂檢視組合（模式×層級×內容）；缺省＝`VIEW_PRESETS[preset]`。 */
  view?: ViewSettings;
  filter: string;
  sort: SortState;
  drillStack: ViewStateSnapshot[];
  /** S4.1R9（OP-13）：接龍自適應父面板備份的獨立檢視模式。 */
  adaptiveParentBackup?: {
    preset: ViewPresetName;
    view?: ViewSettings;
  } | null;
  /** null = D70 fallback: a configured space hit wins, otherwise the default folder icon. */
  icon: string | null;
  showFiles: boolean;
  include: string[];
  exclude: string[];
}

export interface PaneStateDocument {
  [key: string]: unknown;
  version: 3;
  panes: Record<string, PaneState>;
}

export const MAX_PANE_COUNT = 8;

const PANE_ID_PATTERN = /^pane[1-8]$/;

/** Clamp the configured pane count to the supported static view slots. */
export function clampPaneCount(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_PANE_COUNT, Math.floor(value))) : 2;
}

/**
 * Initial enabled pane count for a fresh layout (S4R6-D65): `min(count, 8)`,
 * deliberately independent of how many spaces are configured.
 */
export function getEnabledPaneCount(configuredCount: number): number {
  return clampPaneCount(configuredCount);
}

/** Normalize per-space keys consistently with the host platform's path semantics. */
export function normalizeSpaceKey(basePath: string): string {
  const normalized = path.normalize(basePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return normalizeSpaceKey(a) === normalizeSpaceKey(b);
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface DefaultPaneOptions {
  preset?: ViewPresetName;
  showFiles?: boolean;
  include?: string[];
  exclude?: string[];
  roots?: string[];
  parentPaneId?: string | null;
  follow?: boolean;
  followWorkspaceDirectory?: boolean;
}

export function defaultPaneState(options: DefaultPaneOptions = {}): PaneState {
  return {
    roots: options.roots ?? [],
    drillRoot: null,
    followWorkspaceDirectory: options.followWorkspaceDirectory ?? false,
    parentPaneId: options.parentPaneId ?? null,
    follow: options.follow ?? false,
    preset: options.preset ?? DEFAULT_VIEW_PRESET,
    filter: '',
    sort: { key: 'name', direction: 'asc' },
    drillStack: [],
    icon: null,
    showFiles: options.showFiles ?? true,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  };
}

/** 目前生效的檢視設定：自訂 `view` 優先，否則由預設集查表。 */
export function effectiveView(pane: { preset: ViewPresetName; view?: ViewSettings }): ViewSettings {
  return pane.view && isViewSettings(pane.view) ? pane.view : VIEW_PRESETS[pane.preset] ?? VIEW_PRESETS[DEFAULT_VIEW_PRESET];
}

function normalizeSort(value: unknown): SortState {
  const sort = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    key: sort.key === 'mtime' || sort.key === 'ctime' ? sort.key : 'name',
    direction: sort.direction === 'desc' ? 'desc' : 'asc',
  };
}

function isSnapshot(value: unknown): value is ViewStateSnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const sort = item.sort as Record<string, unknown> | undefined;
  return typeof item.root === 'string' && isViewPresetName(item.preset) && typeof item.filter === 'string' &&
    Boolean(sort && (sort.key === 'name' || sort.key === 'mtime' || sort.key === 'ctime') &&
      (sort.direction === 'asc' || sort.direction === 'desc'));
}

function normalizeDrillStack(value: unknown): ViewStateSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSnapshot).map(snapshot => {
    const normalized: ViewStateSnapshot = {
      ...snapshot,
      root: path.normalize(snapshot.root),
      sort: { ...normalizeSort(snapshot.sort) },
    };
    if (!isViewSettings(snapshot.view)) delete normalized.view;
    return normalized;
  });
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Normalize one pane record, accepting the v2 `root` shape for migration compatibility. */
export function normalizePane(value: unknown, fallbackShowFiles = true, isPrimary = false): PaneState {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const roots = Array.isArray(source.roots) ? normalizeStringArray(source.roots).map(root => path.normalize(root))
    : typeof source.root === 'string' ? [path.normalize(source.root)] : [];
  const pane: PaneState = {
    ...source, roots, drillRoot: typeof source.drillRoot === 'string' ? path.normalize(source.drillRoot) : null,
    parentPaneId: typeof source.parentPaneId === 'string' && PANE_ID_PATTERN.test(source.parentPaneId) ? source.parentPaneId : null,
    follow: source.follow === true && (source.parentPaneId === undefined || source.parentPaneId === null || (typeof source.parentPaneId === 'string' && PANE_ID_PATTERN.test(source.parentPaneId))),
    followWorkspaceDirectory: typeof source.followWorkspaceDirectory === 'boolean' ? source.followWorkspaceDirectory : isPrimary,
    preset: isViewPresetName(source.preset) ? source.preset : DEFAULT_VIEW_PRESET,
    filter: typeof source.filter === 'string' ? source.filter : '', sort: normalizeSort(source.sort),
    drillStack: normalizeDrillStack(source.drillStack), icon: normalizeOptionalString(source.icon),
    showFiles: typeof source.showFiles === 'boolean' ? source.showFiles : fallbackShowFiles,
    include: normalizeStringArray(source.include), exclude: normalizeStringArray(source.exclude),
  };
  if (isViewSettings(source.view)) pane.view = { mode: source.view.mode, level: source.view.level, content: source.view.content };
  else delete pane.view;
  if (source.adaptiveParentBackup && typeof source.adaptiveParentBackup === 'object') {
    const backup = source.adaptiveParentBackup as Record<string, unknown>;
    if (isViewPresetName(backup.preset)) pane.adaptiveParentBackup = { preset: backup.preset,
      ...(isViewSettings(backup.view) ? { view: { mode: backup.view.mode, level: backup.view.level, content: backup.view.content } } : {}) };
    else delete pane.adaptiveParentBackup;
  } else delete pane.adaptiveParentBackup;
  delete (pane as Record<string, unknown>).root;
  delete (pane as Record<string, unknown>).name;
  return pane;
}

function lowestPaneId(ids: string[]): string | undefined {
  return ids.filter(id => PANE_ID_PATTERN.test(id)).sort((a, b) => paneIndexOf(a) - paneIndexOf(b))[0];
}

/** Normalize a v3 document; malformed or foreign-version values yield the empty default. */
export function normalizePaneState(value: unknown): PaneStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: 3, panes: {} };
  const source = value as Record<string, unknown>;
  if (source.version !== 3 || !source.panes || typeof source.panes !== 'object' || Array.isArray(source.panes)) return { version: 3, panes: {} };
  const paneValues = source.panes as Record<string, unknown>;
  const primary = lowestPaneId(Object.keys(paneValues));
  const panes: Record<string, PaneState> = {};
  for (const [paneId, raw] of Object.entries(paneValues)) if (PANE_ID_PATTERN.test(paneId)) panes[paneId] = normalizePane(raw, true, paneId === primary);
  return { ...source, version: 3, panes: normalizePaneChains(panes) };
}

export function activeRoot(pane: PaneState): string | null { return pane.drillRoot ?? pane.roots[0] ?? null; }

/** Find the most-specific configured root containing target. */
export function rootForUri(roots: readonly string[], target: string): string | null {
  return roots.filter(root => isPathWithin(path.normalize(target), path.normalize(root)))
    .sort((a, b) => path.relative(path.normalize(a), path.normalize(target)).length - path.relative(path.normalize(b), path.normalize(target)).length)[0] ?? null;
}

/** Convert a validated v2 document to v3 and move the global follow default to its primary pane. */
export function migrateV2ToV3(value: unknown, followWorkspaceDirectoryDefault: boolean): PaneStateDocument {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).version !== 2 ||
      !(value as Record<string, unknown>).panes || typeof (value as Record<string, unknown>).panes !== 'object' || Array.isArray((value as Record<string, unknown>).panes)) {
    throw new Error('panes.v2 is malformed');
  }
  const rawPanes = (value as { panes: Record<string, unknown> }).panes;
  const primary = lowestPaneId(Object.keys(rawPanes));
  const panes: Record<string, PaneState> = {};
  for (const [id, raw] of Object.entries(rawPanes)) {
    if (!PANE_ID_PATTERN.test(id)) continue;
    const old = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const oldStack = Array.isArray(old.drillStack) ? old.drillStack as unknown[] : [];
    const hasStack = oldStack.length > 0;
    const firstStackRoot = hasStack ? (oldStack[0] as Record<string, unknown> | undefined)?.root : undefined;
    const chainRoot = typeof firstStackRoot === 'string' && firstStackRoot ? path.normalize(firstStackRoot) : null;
    const oldRoot = typeof old.root === 'string' && old.root ? path.normalize(old.root) : null;
    const roots = hasStack ? (chainRoot ? [chainRoot] : []) : oldRoot ? [oldRoot] : [];
    panes[id] = normalizePane({ ...old, roots, drillRoot: chainRoot ? oldRoot : null,
      followWorkspaceDirectory: id === primary ? followWorkspaceDirectoryDefault : false }, true, id === primary);
  }
  return { ...source, version: 3, panes: normalizePaneChains(panes) };
}

/** Initial layout for a new workspace (spec §2.2.2 with S4R6 semantics). */
export function buildDefaultLayout(spaces: SpaceDefinition[], configuredCount: number, showFilesDefault: boolean, followWorkspaceDirectoryDefault = false): PaneStateDocument {
  const count = getEnabledPaneCount(configuredCount);
  const panes: Record<string, PaneState> = {};
  for (let index = 1; index <= count; index++) {
    const space = spaces[index - 1];
    panes[`pane${index}`] = normalizePane({
      roots: space ? [space.basePath] : [],
      followWorkspaceDirectory: index === 1 ? followWorkspaceDirectoryDefault : false,
      parentPaneId: index > 1 ? `pane${index - 1}` : null,
      follow: index > 1,
      showFiles: space?.showFiles ?? showFilesDefault,
      include: space?.include ?? [],
      exclude: space?.exclude ?? [],
    });
  }
  return { version: 3, panes };
}

/** One-time v1 → v2 migration (spec §2.4.3); throws when the v1 document is unusable. */
export function migrateV1ToV2(value: unknown, spaces: SpaceDefinition[], showFilesDefault: boolean): PaneStateDocument {
  const legacy = normalizeLegacyV1(value);
  if (!legacy.panes) throw new Error('panes.v1 has no pane layout to migrate');
  const panes: Record<string, PaneState> = {};
  // D72: keep the enabled pane count exactly as v1 stored it; never auto-fill.
  for (const [paneId, link] of Object.entries(legacy.panes)) {
    if (!PANE_ID_PATTERN.test(paneId)) continue;
    const view = link.root ? legacy.bySpace[normalizeSpaceKey(link.root)] : undefined;
    const space = spaces.find(candidate => link.root !== null && samePath(candidate.basePath, link.root));
    // A drilled v1 pane displays its bySpace root; otherwise the chain root.
    const legacyDrillStack = Array.isArray(view?.drillStack) ? view.drillStack : [];
    const drilled = Boolean(view && legacyDrillStack.length > 0 && typeof view.root === 'string');
    const root = drilled ? path.normalize(view!.root as string) : link.root;
    panes[paneId] = { ...normalizePane({
      ...view,
      root,
      parentPaneId: link.parentPaneId,
      follow: link.follow,
      icon: null,
      showFiles: space?.showFiles ?? showFilesDefault,
      include: space?.include ?? [],
      exclude: space?.exclude ?? [],
    }), root } as unknown as PaneState;
  }
  return { version: 2, panes } as unknown as PaneStateDocument;
}

/** Resolve each pane root into a pane-scoped definition. */
export function resolvePaneDefinitions(pane: PaneState, spaces: SpaceDefinition[]): SpaceDefinition[] {
  return pane.roots.map(root => {
    const hit = spaces.find(space => samePath(space.basePath, root));
    return { basePath: root, name: hit?.name ?? path.basename(root), icon: pane.icon ?? hit?.icon,
      showFiles: pane.showFiles, include: pane.include, exclude: pane.exclude, sourceIndex: hit?.sourceIndex ?? -1 };
  });
}

/** Existing single-definition projection retained for compatible callers. */
export function resolvePaneDefinition(pane: PaneState, spaces: SpaceDefinition[]): SpaceDefinition | null {
  return resolvePaneDefinitions(pane, spaces)[0] ?? null;
}

/** Rewrite every pane root and drill stack path that lives under a renamed directory. */
export function rewritePaneDocumentRoots(document: PaneStateDocument, oldPath: string, newPath: string): PaneStateDocument {
  const normalizedOld = path.normalize(oldPath);
  const rewritten: Record<string, PaneState> = {};
  for (const [paneId, pane] of Object.entries(document.panes)) {
    const rewrite = (root: string): string => isPathWithin(path.normalize(root), normalizedOld)
      ? path.join(newPath, path.relative(normalizedOld, path.normalize(root)))
      : root;
    rewritten[paneId] = {
      ...pane,
      roots: pane.roots.map(rewrite),
      drillRoot: pane.drillRoot ? rewrite(pane.drillRoot) : null,
      drillStack: pane.drillStack.map(snapshot => ({ ...snapshot, root: rewrite(snapshot.root) })),
    };
    delete (rewritten[paneId] as Record<string, unknown>).name;
  }
  return { ...document, panes: rewritten };
}

/** Classify a filesystem rename against configured space roots (setting-staleness only). */
export type RenameImpact = { kind: 'space-root' } | { kind: 'inside-space'; basePath: string } | { kind: 'unrelated' };

export function classifySpaceRename(basePaths: string[], oldPath: string): RenameImpact {
  const exact = basePaths.find(basePath => samePath(basePath, oldPath));
  if (exact) return { kind: 'space-root' };
  const containing = basePaths.find(basePath => isPathWithin(path.normalize(oldPath), normalizeSpaceKey(basePath)));
  return containing ? { kind: 'inside-space', basePath: containing } : { kind: 'unrelated' };
}

// ---------------------------------------------------------------------------
// Legacy v1 normalization, kept only as the migration source reader (§2.4.3).
// ---------------------------------------------------------------------------

interface LegacyV1State {
  root?: string;
  preset?: unknown;
  filter?: unknown;
  sort?: unknown;
  drillStack?: unknown;
  [key: string]: unknown;
}

interface LegacyV1Document {
  version: 1;
  bySpace: Record<string, LegacyV1State>;
  panes?: Record<string, PaneLinkState>;
}

function normalizeLegacyV1(value: unknown): LegacyV1Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('panes.v1 is missing or malformed');
  const source = value as Record<string, unknown>;
  if (source.version !== 1) throw new Error('panes.v1 has an unknown version');
  if (!source.bySpace || typeof source.bySpace !== 'object' || Array.isArray(source.bySpace)) {
    throw new Error('panes.v1 has no bySpace map');
  }
  const bySpace: Record<string, LegacyV1State> = {};
  for (const [basePath, raw] of Object.entries(source.bySpace as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const state = raw as LegacyV1State;
    const preset = isViewPresetName(state.preset) ? state.preset : DEFAULT_VIEW_PRESET;
    bySpace[normalizeSpaceKey(basePath)] = {
      ...state,
      ...(typeof state.root === 'string' ? { root: path.normalize(state.root) } : {}),
      preset,
      filter: typeof state.filter === 'string' ? state.filter : '',
      sort: normalizeSort(state.sort),
      drillStack: normalizeDrillStack(state.drillStack),
    };
  }
  const panes: Record<string, PaneLinkState> | undefined = source.panes && typeof source.panes === 'object' && !Array.isArray(source.panes)
    ? Object.fromEntries(Object.entries(source.panes as Record<string, unknown>).flatMap(([id, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const pane = raw as Record<string, unknown>;
      return [[id, {
        root: typeof pane.root === 'string' ? path.normalize(pane.root) : null,
        parentPaneId: typeof pane.parentPaneId === 'string' ? pane.parentPaneId : null,
        follow: pane.follow === true,
      }]];
    }))
    : undefined;
  return { version: 1, bySpace, panes };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PaneInitContext {
  spaces: SpaceDefinition[];
  showFilesDefault: boolean;
  configuredCount: number;
  followWorkspaceDirectoryDefault: boolean;
}

export type PaneInitOutcome =
  | { kind: 'restored'; enabled: number }
  | { kind: 'migrated'; enabled: number }
  | { kind: 'created'; enabled: number }
  | { kind: 'rebuilt'; reason: string };

/**
 * Per-window pane state (workspaceState). All APIs key on `paneId` (S4R6-D63);
 * `codeFolderSpaces.spaces` is only the candidate-root list and default source.
 */
export class PaneStateStore {
  private state: PaneStateDocument;

  constructor(private readonly memento: MementoLike) {
    this.state = normalizePaneState(memento.get<unknown>(PANE_STATE_KEY));
  }

  /**
   * Restore, migrate (v1 → v2, one-time), or create the initial layout.
   * The v1 key is removed after a successful migration.
   */
    /**
   * 檢查是否可自舊版 workspaceState 轉移至 globalState。
   */
  async migrateFromWorkspaceStateIfEmpty(workspaceMemento: MementoLike | undefined, followWorkspaceDirectoryDefault: boolean): Promise<void> {
    if (!workspaceMemento || this.memento.get<unknown>(PANE_STATE_KEY)) return;
    const globalV3 = workspaceMemento.get<unknown>(PANE_STATE_KEY);
    if (isV3Document(globalV3)) { this.state = normalizePaneState(globalV3); await this.persist(); return; }
    const wsV2 = workspaceMemento.get<unknown>(LEGACY_PANE_STATE_KEY);
    if (isV2Document(wsV2)) { this.state = migrateV2ToV3(wsV2, followWorkspaceDirectoryDefault); await this.persist(); }
  }

  async initialize(context: PaneInitContext): Promise<PaneInitOutcome> {
    const storedV3 = this.memento.get<unknown>(PANE_STATE_KEY);
    const storedV2 = this.memento.get<unknown>(LEGACY_PANE_STATE_KEY);
    const storedV1 = this.memento.get<unknown>(LEGACY_V1_PANE_STATE_KEY);
    if (isV3Document(storedV3)) {
      this.state = normalizePaneState(storedV3);
      if (!Object.keys(this.state.panes).length) return this.persistDefault(context, 'created');
      if (!isUsableLayout(this.state.panes)) return this.persistDefault(context, 'rebuilt', 'invalid pane layout');
      if (this.memento.get<unknown>(LEGACY_PANE_STATE_KEY) !== undefined) await this.memento.update(LEGACY_PANE_STATE_KEY, undefined);
      if (this.memento.get<unknown>(LEGACY_V1_PANE_STATE_KEY) !== undefined) await this.memento.update(LEGACY_V1_PANE_STATE_KEY, undefined);
      return { kind: 'restored', enabled: Object.keys(this.state.panes).length };
    }
    try {
      if (isV2Document(storedV2)) {
        this.state = migrateV2ToV3(storedV2, context.followWorkspaceDirectoryDefault);
        if (!isUsableLayout(this.state.panes)) throw new Error('migrated layout has invalid pane links');
        await this.persist(); await this.memento.update(LEGACY_PANE_STATE_KEY, undefined);
        return { kind: 'migrated', enabled: Object.keys(this.state.panes).length };
      }
      if (isV1Document(storedV1)) {
        const v2 = migrateV1ToV2(storedV1, context.spaces, context.showFilesDefault);
        this.state = migrateV2ToV3(v2, context.followWorkspaceDirectoryDefault);
        if (!isUsableLayout(this.state.panes)) throw new Error('migrated layout has invalid pane links');
        await this.persist(); await this.memento.update(LEGACY_V1_PANE_STATE_KEY, undefined);
        return { kind: 'migrated', enabled: Object.keys(this.state.panes).length };
      }
      const hasInvalidStoredState = storedV3 !== undefined || storedV2 !== undefined || storedV1 !== undefined;
      return this.persistDefault(context, hasInvalidStoredState ? 'rebuilt' : 'created', hasInvalidStoredState ? 'unrecognized pane state version' : undefined);
    } catch (error) { return this.persistDefault(context, 'rebuilt', String(error)); }
  }

  /** Reset the layout to the default two-pane chain for `pane.resetLayout`. */
  async resetToDefaults(context: PaneInitContext): Promise<void> {
    await this.persistDefault(context, 'created');
  }

  private async persistDefault(context: PaneInitContext, kind: 'created' | 'rebuilt', reason?: string): Promise<PaneInitOutcome> {
    this.state = buildDefaultLayout(context.spaces, context.configuredCount, context.showFilesDefault, context.followWorkspaceDirectoryDefault);
    await this.persist();
    await this.memento.update(LEGACY_PANE_STATE_KEY, undefined);
    await this.memento.update(LEGACY_V1_PANE_STATE_KEY, undefined);
    return kind === 'rebuilt' ? { kind, reason: reason ?? '' } : { kind: 'created', enabled: Object.keys(this.state.panes).length };
  }

  /** Current pane state; disabled/unknown ids behave like an empty default pane. */
  get(paneId: string): PaneState {
    return this.state.panes[paneId] ?? defaultPaneState();
  }

  /** Enabled panes are exactly the ids present in the document (spec §2.4.2). */
  getEnabledPaneIds(): string[] {
    return Object.keys(this.state.panes).sort((a, b) => paneIndexOf(a) - paneIndexOf(b));
  }

  /** Lowest free slot `pane1..pane8`, or undefined when all eight are used (PD-U2). */
  allocatePaneId(minIndex = 1): string | undefined {
    for (let index = Math.max(1, minIndex); index <= MAX_PANE_COUNT; index++) {
      const id = `pane${index}`;
      if (!this.state.panes[id]) return id;
    }
    return undefined;
  }

  /** Compat projection used by the cascade controller and stale checks. */
  getPaneLinks(): Record<string, PaneLinkState> {
    return Object.fromEntries(Object.entries(this.state.panes).map(([paneId, pane]) => [paneId, {
      root: activeRoot(pane),
      parentPaneId: pane.parentPaneId,
      follow: pane.follow,
    }]));
  }

  async enablePane(paneId: string, state: Partial<PaneState> = {}): Promise<void> {
    if (!PANE_ID_PATTERN.test(paneId)) throw new Error(`Invalid pane id: ${paneId}`);
    if (this.state.panes[paneId]) throw new Error(`Pane already enabled: ${paneId}`);
    const merged = normalizePane({ ...defaultPaneState(), ...state });
    const current = merged.parentPaneId ? detachChildrenOf(this.state.panes, merged.parentPaneId, paneId) : this.state.panes;
    const candidate = { ...current, [paneId]: merged };
    if (!hasValidPaneLinks(candidate)) throw new Error('Pane links must be acyclic and no deeper than eight panes.');
    this.state = { ...this.state, panes: candidate };
    await this.persist();
  }

  /**
   * Disable a pane slot. Its children re-attach to its parent (S4R6-D62/D71,
   * PD-U3); any pane may be removed while one remains (enforced by callers, S4.1R3).
   */
  async disablePane(paneId: string): Promise<void> {
    if (!this.state.panes[paneId]) return;
    const panes = reattachChildren(this.state.panes, paneId);
    this.state = { ...this.state, panes };
    await this.persist();
  }

  /** 清除下鑽並還原首次下鑽前的基準檢視。 */
  private clearDrillState(pane: PaneState): void {
    const base = pane.drillStack[0];
    if (base) {
      pane.preset = base.preset;
      if (base.view) pane.view = { ...base.view };
      else delete pane.view;
      pane.filter = base.filter;
      pane.sort = { ...base.sort };
    }
    pane.drillRoot = null;
    pane.drillStack = [];
  }

  /** Replace roots with a single selected root, clearing drill navigation. */
  async switchRoot(paneId: string, root: string | null): Promise<void> {
    const pane = this.state.panes[paneId]; if (!pane) return;
    pane.roots = root ? [path.normalize(root)] : []; this.clearDrillState(pane); await this.persist();
  }

  async addPaneRoot(paneId: string, root: string): Promise<boolean> {
    const pane = this.state.panes[paneId]; if (!pane) return false;
    const normalized = path.normalize(root); if (pane.roots.some(item => samePath(item, normalized))) return false;
    pane.roots = [...pane.roots, normalized]; await this.persist(); return true;
  }

  async removePaneRoot(paneId: string, root: string): Promise<boolean> {
    const pane = this.state.panes[paneId]; if (!pane) return false;
    const normalized = path.normalize(root); const roots = pane.roots.filter(item => !samePath(item, normalized));
    if (roots.length === pane.roots.length) return false;
    pane.roots = roots;
    this.clearDrillState(pane);
    await this.persist(); return true;
  }

  async setPaneRoots(paneId: string, roots: string[]): Promise<void> {
    const pane = this.state.panes[paneId]; if (!pane) return;
    const normalized = roots.map(root => path.normalize(root));
    if (normalized.length !== pane.roots.length || normalized.some((root, index) => !samePath(root, pane.roots[index]))) {
      pane.roots = normalized;
      this.clearDrillState(pane);
    }
    await this.persist();
  }

  async setPaneFollowWorkspaceDirectory(paneId: string, enabled: boolean): Promise<void> {
    const pane = this.state.panes[paneId]; if (!pane) return;
    pane.followWorkspaceDirectory = enabled; await this.persist();
  }

  async resetRoot(paneId: string): Promise<void> {
    const pane = this.state.panes[paneId]; if (!pane || pane.drillStack.length === 0) return;
    pane.drillRoot = null; pane.drillStack = []; await this.persist();
  }

  async setPaneDisplay(paneId: string, patch: Partial<Pick<PaneState, 'icon' | 'showFiles' | 'include' | 'exclude'>>): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    Object.assign(pane, patch);
    await this.persist();
  }

  /** Re-link a pane (chain parent + follow) or toggle follow with its current parent. */
  async setPaneParent(paneId: string, parentPaneId: string | null, follow: boolean): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    const current = parentPaneId ? detachChildrenOf(this.state.panes, parentPaneId, paneId) : this.state.panes;
    const candidate: Record<string, PaneLinkState> = { ...Object.fromEntries(Object.entries(current).map(([id, item]) => [id, { root: activeRoot(item), parentPaneId: item.parentPaneId, follow: item.follow }])), [paneId]: { root: activeRoot(pane), parentPaneId, follow } };
    if (parentPaneId && wouldCreateCycle(candidate, parentPaneId, paneId)) {
      throw new Error('Pane links must be acyclic and no deeper than eight panes.');
    }
    this.state = { ...this.state, panes: current };
    pane.parentPaneId = parentPaneId && PANE_ID_PATTERN.test(parentPaneId) ? parentPaneId : null;
    pane.follow = pane.parentPaneId ? follow : false;
    await this.persist();
  }

  /**
   * S4.1R8（OP-12）：就地下鑽（In-place Drill-down）。
   * 保存當前檢視狀態至歷史堆疊，下鑽後自動套用預設的子面板檢視預設集（Contents 扁平內容總覽，對齊 Obsidian 規格）。
   * 點擊標題列「←」返回（drillUp）時無損還原。
   */
  async drillDown(paneId: string, root: string, childPreset: ViewPresetName = 'Contents'): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    pane.drillStack = [...pane.drillStack, { root: activeRoot(pane) ?? path.normalize(root), preset: pane.preset, ...(pane.view ? { view: { ...pane.view } } : {}), filter: pane.filter, sort: { ...pane.sort } }];
    pane.drillRoot = path.normalize(root);
    pane.preset = childPreset;
    delete pane.view;
    await this.persist();
  }

  async drillUp(paneId: string): Promise<boolean> {
    const pane = this.state.panes[paneId];
    if (!pane) return false;
    const stack = [...pane.drillStack];
    const previous = stack.pop();
    if (!previous) return false;
    pane.drillRoot = stack.length === 0 ? null : previous.root;
    pane.preset = previous.preset;
    if (previous.view) pane.view = { ...previous.view };
    else delete pane.view;
    pane.filter = previous.filter;
    pane.sort = { ...previous.sort };
    pane.drillStack = stack;
    await this.persist();
    return true;
  }

  async setPreset(paneId: string, preset: ViewPresetName): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    pane.preset = preset;
    delete pane.view; // 預設集＝一鍵套用三個維度，清除自訂組合
    await this.persist();
  }

  /** 單一維度變更（OP-14）：其餘兩維不動；結果恰為某預設集時回到該預設集，否則存為自訂組合。 */
  /**
   * S4.1R9（OP-13）：接龍自適應父面板模式。
   * 當父面板擁有連動子面板時，自動備份當前檢視並切換為導覽預設集（純目錄瀏覽）；
   * 當子面板解除或關閉時，自動無損還原。
   */
  async handleAdaptiveCascadeParent(
    paneId: string,
    hasFollowingChild: boolean,
    cascadeParentPreset: ViewPresetName = 'Navigate'
  ): Promise<boolean> {
    const pane = this.state.panes[paneId];
    if (!pane) return false;

    if (hasFollowingChild) {
      if (!pane.adaptiveParentBackup) {
        // 備份當前獨立檢視
        pane.adaptiveParentBackup = {
          preset: pane.preset,
          ...(pane.view ? { view: { ...pane.view } } : {}),
        };
        pane.preset = cascadeParentPreset;
        delete pane.view;
        await this.persist();
        return true;
      }
    } else if (pane.adaptiveParentBackup) {
      // 還原備份的獨立檢視
      pane.preset = pane.adaptiveParentBackup.preset;
      if (pane.adaptiveParentBackup.view) {
        pane.view = { ...pane.adaptiveParentBackup.view };
      } else {
        delete pane.view;
      }
      pane.adaptiveParentBackup = null;
      await this.persist();
      return true;
    }
    return false;
  }

  async setViewAxis(paneId: string, change: ViewAxisChange): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    const view = effectiveView(pane);
    const next = change.axis === 'mode' ? applyViewAxis(view, 'mode', change.value)
      : change.axis === 'level' ? applyViewAxis(view, 'level', change.value)
      : applyViewAxis(view, 'content', change.value);
    const matched = matchPresetName(next);
    if (matched) {
      pane.preset = matched;
      delete pane.view;
    } else {
      pane.view = next;
    }
    await this.persist();
  }

  async setFilter(paneId: string, filter: string): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    pane.filter = filter;
    await this.persist();
  }

  async clearFilter(paneId: string): Promise<void> {
    await this.setFilter(paneId, '');
  }

  async setSort(paneId: string, key: SortKey, direction: SortDirection): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    pane.sort = { key, direction };
    await this.persist();
  }

  /** Rename handling is pane-scoped now: roots and drill stacks follow the renamed tree. */
  async rewriteRoots(oldPath: string, newPath: string): Promise<void> {
    this.state = rewritePaneDocumentRoots(this.state, oldPath, newPath);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.memento.update(PANE_STATE_KEY, this.state);
  }
}

function isV3Document(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { version?: unknown }).version === 3);
}

function isV2Document(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { version?: unknown }).version === 2);
}

function isV1Document(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { version?: unknown }).version === 1);
}

function paneIndexOf(paneId: string): number {
  const match = /^pane([1-8])$/.exec(paneId);
  return match ? Number(match[1]) : MAX_PANE_COUNT + 1;
}

/** 審查 F-10：載入／遷移後的佈局必須鏈結合法且至少有一個窗格（S4.1R3 修訂 D71：不再要求 pane1 存在）。 */
function isUsableLayout(panes: Record<string, PaneState>): boolean {
  return Object.keys(panes).length > 0 && hasValidPaneLinks(panes);
}
