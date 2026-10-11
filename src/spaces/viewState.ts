import * as path from 'node:path';
import type { SpaceDefinition } from '../types';
import type { ViewPresetName } from './viewPresets';
import { DEFAULT_VIEW_PRESET, isViewPresetName } from './viewPresets';
import { hasValidPaneLinks, reattachChildren, wouldCreateCycle } from './paneLinks';

/** Current workspaceState key (S4R6-D63: per-pane view state, no more `bySpace`). */
export const PANE_STATE_KEY = 'codeFolderSpaces.panes.v2';
/** Legacy v1 key that stores shared per-space view state; cleared once migrated. */
export const LEGACY_PANE_STATE_KEY = 'codeFolderSpaces.panes.v1';

export type SortKey = 'name' | 'mtime' | 'ctime';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export interface ViewStateSnapshot {
  root: string;
  preset: ViewPresetName;
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
  root: string | null;
  parentPaneId: string | null;
  follow: boolean;
  preset: ViewPresetName;
  filter: string;
  sort: SortState;
  drillStack: ViewStateSnapshot[];
  /** null = D70 fallback: a configured space hit wins, otherwise the root basename. */
  name: string | null;
  /** null = D70 fallback: a configured space hit wins, otherwise the default folder icon. */
  icon: string | null;
  showFiles: boolean;
  include: string[];
  exclude: string[];
}

export interface PaneStateDocument {
  [key: string]: unknown;
  version: 2;
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
  root?: string | null;
  parentPaneId?: string | null;
  follow?: boolean;
}

export function defaultPaneState(options: DefaultPaneOptions = {}): PaneState {
  return {
    root: options.root ?? null,
    parentPaneId: options.parentPaneId ?? null,
    follow: options.follow ?? false,
    preset: options.preset ?? DEFAULT_VIEW_PRESET,
    filter: '',
    sort: { key: 'name', direction: 'asc' },
    drillStack: [],
    name: null,
    icon: null,
    showFiles: options.showFiles ?? true,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  };
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
  return value.filter(isSnapshot).map(snapshot => ({
    ...snapshot,
    root: path.normalize(snapshot.root),
    sort: { ...normalizeSort(snapshot.sort) },
  }));
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Normalize one v2 pane record, preserving unknown fields (spec §2.4.2). */
export function normalizePane(value: unknown, fallbackShowFiles = true): PaneState {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    ...source,
    root: typeof source.root === 'string' ? path.normalize(source.root) : null,
    parentPaneId: typeof source.parentPaneId === 'string' && PANE_ID_PATTERN.test(source.parentPaneId) ? source.parentPaneId : null,
    follow: source.follow === true,
    preset: isViewPresetName(source.preset) ? source.preset : DEFAULT_VIEW_PRESET,
    filter: typeof source.filter === 'string' ? source.filter : '',
    sort: normalizeSort(source.sort),
    drillStack: normalizeDrillStack(source.drillStack),
    name: normalizeOptionalString(source.name),
    icon: normalizeOptionalString(source.icon),
    showFiles: typeof source.showFiles === 'boolean' ? source.showFiles : fallbackShowFiles,
    include: normalizeStringArray(source.include),
    exclude: normalizeStringArray(source.exclude),
  };
}

/** Normalize a v2 document; anything malformed (or a foreign version) yields the empty default. */
export function normalizePaneState(value: unknown): PaneStateDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: 2, panes: {} };
  const source = value as Record<string, unknown>;
  if (source.version !== 2 || !source.panes || typeof source.panes !== 'object' || Array.isArray(source.panes)) {
    return { version: 2, panes: {} };
  }
  const panes: Record<string, PaneState> = {};
  for (const [paneId, raw] of Object.entries(source.panes as Record<string, unknown>)) {
    if (!PANE_ID_PATTERN.test(paneId)) continue;
    panes[paneId] = normalizePane(raw);
  }
  return { ...source, version: 2, panes };
}

/** Initial layout for a new workspace (spec §2.2.2 with S4R6 semantics). */
export function buildDefaultLayout(spaces: SpaceDefinition[], configuredCount: number, showFilesDefault: boolean): PaneStateDocument {
  const count = getEnabledPaneCount(configuredCount);
  const panes: Record<string, PaneState> = {};
  for (let index = 1; index <= count; index++) {
    const space = spaces[index - 1];
    panes[`pane${index}`] = normalizePane({
      root: space?.basePath ?? null,
      parentPaneId: index > 1 ? `pane${index - 1}` : null,
      follow: index > 1,
      showFiles: space?.showFiles ?? showFilesDefault,
      include: space?.include ?? [],
      exclude: space?.exclude ?? [],
    });
  }
  return { version: 2, panes };
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
    panes[paneId] = normalizePane({
      ...view,
      root,
      parentPaneId: link.parentPaneId,
      follow: link.follow,
      name: null,
      icon: null,
      showFiles: space?.showFiles ?? showFilesDefault,
      include: space?.include ?? [],
      exclude: space?.exclude ?? [],
    });
  }
  return { version: 2, panes };
}

/** Resolve the per-pane tree definition (S4R6-D69/D70); null when the pane has no root. */
export function resolvePaneDefinition(pane: PaneState, spaces: SpaceDefinition[]): SpaceDefinition | null {
  if (!pane.root) return null;
  const hit = spaces.find(space => samePath(space.basePath, pane.root as string));
  return {
    basePath: pane.root,
    name: pane.name ?? hit?.name ?? path.basename(pane.root),
    icon: pane.icon ?? hit?.icon,
    showFiles: pane.showFiles,
    include: pane.include,
    exclude: pane.exclude,
    sourceIndex: hit?.sourceIndex ?? -1,
  };
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
      root: pane.root ? rewrite(pane.root) : null,
      drillStack: pane.drillStack.map(snapshot => ({ ...snapshot, root: rewrite(snapshot.root) })),
    };
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
  async initialize(context: PaneInitContext): Promise<PaneInitOutcome> {
    const storedV2 = this.memento.get<unknown>(PANE_STATE_KEY);
    const storedV1 = this.memento.get<unknown>(LEGACY_PANE_STATE_KEY);
    if (isV2Document(storedV2)) {
      this.state = normalizePaneState(storedV2);
      if (Object.keys(this.state.panes).length === 0) return this.persistDefault(context, 'created');
      if (storedV1 !== undefined) await this.memento.update(LEGACY_PANE_STATE_KEY, undefined);
      return { kind: 'restored', enabled: Object.keys(this.state.panes).length };
    }
    const legacySource = storedV1 ?? (isV1Document(storedV2) ? storedV2 : undefined);
    if (legacySource === undefined) return this.persistDefault(context, 'created');
    try {
      this.state = migrateV1ToV2(legacySource, context.spaces, context.showFilesDefault);
      await this.persist();
      await this.memento.update(LEGACY_PANE_STATE_KEY, undefined);
      return { kind: 'migrated', enabled: Object.keys(this.state.panes).length };
    } catch (error) {
      return this.persistDefault(context, 'rebuilt', String(error));
    }
  }

  /** Reset the layout to the default two-pane chain for `pane.resetLayout`. */
  async resetToDefaults(context: PaneInitContext): Promise<void> {
    await this.persistDefault(context, 'created');
  }

  private async persistDefault(context: PaneInitContext, kind: 'created' | 'rebuilt', reason?: string): Promise<PaneInitOutcome> {
    this.state = buildDefaultLayout(context.spaces, context.configuredCount, context.showFilesDefault);
    await this.persist();
    await this.memento.update(LEGACY_PANE_STATE_KEY, undefined);
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
      root: pane.root,
      parentPaneId: pane.parentPaneId,
      follow: pane.follow,
    }]));
  }

  async enablePane(paneId: string, state: Partial<PaneState> = {}): Promise<void> {
    if (!PANE_ID_PATTERN.test(paneId)) throw new Error(`Invalid pane id: ${paneId}`);
    if (this.state.panes[paneId]) throw new Error(`Pane already enabled: ${paneId}`);
    const merged = normalizePane({ ...defaultPaneState(), ...state });
    const candidate = { ...this.state.panes, [paneId]: merged };
    if (!hasValidPaneLinks(candidate)) throw new Error('Pane links must be acyclic, ordered, and no deeper than eight panes.');
    this.state = { ...this.state, panes: candidate };
    await this.persist();
  }

  /**
   * Disable a pane slot. Its children re-attach to its parent (S4R6-D62/D71,
   * PD-U3); pane1 is never removable and is enforced by callers.
   */
  async disablePane(paneId: string): Promise<void> {
    if (!this.state.panes[paneId]) return;
    const panes = reattachChildren(this.state.panes, paneId);
    this.state = { ...this.state, panes };
    await this.persist();
  }

  /** Coarse root change: switching the root resets the drill stack (as in v1). */
  async setPaneRoot(paneId: string, root: string | null): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    pane.root = root ? path.normalize(root) : null;
    pane.drillStack = [];
    await this.persist();
  }

  /** Alias kept for command call sites that read as an explicit root switch. */
  async switchRoot(paneId: string, root: string | null): Promise<void> {
    await this.setPaneRoot(paneId, root);
  }

  /** Restore the chain root (bottom of the drill stack) and drop the stack. */
  async resetRoot(paneId: string): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane || pane.drillStack.length === 0) return;
    pane.root = pane.drillStack[0].root;
    pane.drillStack = [];
    await this.persist();
  }

  async setPaneDisplay(paneId: string, patch: Partial<Pick<PaneState, 'name' | 'icon' | 'showFiles' | 'include' | 'exclude'>>): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    Object.assign(pane, patch);
    await this.persist();
  }

  /** Re-link a pane (chain parent + follow) or toggle follow with its current parent. */
  async setPaneParent(paneId: string, parentPaneId: string | null, follow: boolean): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    const candidate: Record<string, PaneLinkState> = { ...this.getPaneLinks(), [paneId]: { root: pane.root, parentPaneId, follow } };
    if (parentPaneId && wouldCreateCycle(candidate, parentPaneId, paneId)) {
      throw new Error('Pane links must be acyclic, ordered, and no deeper than eight panes.');
    }
    pane.parentPaneId = parentPaneId && PANE_ID_PATTERN.test(parentPaneId) ? parentPaneId : null;
    pane.follow = pane.parentPaneId ? follow : false;
    await this.persist();
  }

  async drillDown(paneId: string, root: string): Promise<void> {
    const pane = this.state.panes[paneId];
    if (!pane) return;
    pane.drillStack = [...pane.drillStack, { root: pane.root as string, preset: pane.preset, filter: pane.filter, sort: { ...pane.sort } }];
    pane.root = path.normalize(root);
    pane.preset = DEFAULT_VIEW_PRESET;
    await this.persist();
  }

  async drillUp(paneId: string): Promise<boolean> {
    const pane = this.state.panes[paneId];
    if (!pane) return false;
    const stack = [...pane.drillStack];
    const previous = stack.pop();
    if (!previous) return false;
    pane.root = previous.root;
    pane.preset = previous.preset;
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
