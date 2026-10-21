import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceDefinition } from '../types';
import { mapWithConcurrency } from '../util/concurrency';
import { getLogChannel } from '../util/log';
import { DirectoryCache } from './directoryCache';
import type { DirectoryEntry } from './directoryCache';
import { isVisibleDirectory, isVisibleFile, originOf } from './spaceConfig';
import { assignNestedChildren, parseNestingPatterns } from './fileNesting';
import type { FileNestingRule } from './fileNesting';
import { buildFlatListing, DEFAULT_FLAT_MAX_DEPTH } from './flatListing';
import { VIEW_PRESETS, type ViewPreset, type ViewSettings } from './viewPresets';

const DEFAULT_VIEW: ViewSettings = VIEW_PRESETS.Explorer;
import { matchesPathFilter, sortEntries, StatCache } from './sortEntries';
import type { SortableEntry } from './sortEntries';
import type { SpaceStore } from './spaceStore';
import { effectiveView, rootForUri, type PaneState, type PaneStateStore } from './viewState';

export type SpaceNode = SpaceRootNode | SpaceEntryNode;

/** Supplies the parent-side follow marker for a folder row. */
export type PaneLinkMarkerProvider = (paneId: string, fsPath: string) => string | undefined;

/**
 * S4.1R20：Explorer 等價的可見性判斷。
 * 回傳 true 表示該項目應被隱藏（依 files.exclude 與 explorer.excludeGitIgnore）。
 * 路徑以「相對於 pane root、斜線分隔、無前導斜線」傳入。
 */
export type ExplorerVisibilityProvider = (relativePath: string, isDirectory: boolean) => boolean;

/**
 * Apply an injected pane-link marker to a folder tree item without touching other item fields.
 *
 * v2-R2 修正：只有在 marker **確實有值**時才覆寫 description。
 * 原寫法 `item.description = markerProvider(...)` 在 marker 回傳 `undefined` 時會把既有
 * description（例如 global root 的 `$(globe)`）一併抹掉。
 */
export function applyPaneLinkMarker<T extends { description?: string | boolean }>(
  item: T,
  paneId: string,
  fsPath: string,
  isFolder: boolean,
  markerProvider?: PaneLinkMarkerProvider,
): T {
  const marker = isFolder && markerProvider ? markerProvider(paneId, fsPath) : undefined;
  if (marker !== undefined) item.description = marker;
  return item;
}

const DIRECTORY_CHILD_CHECK_CONCURRENCY = 16;

/** F-42: file-nesting matching is case-insensitive on these platforms (spec §2). */
const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

async function readDirectoryFromWorkspaceFs(uri: string): Promise<DirectoryEntry[]> {
  return await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri));
}

/**
 * Provider-owned cache (S4R7 W2): reads through `workspace.fs`, reports failures on the
 * shared log channel (S4R7-D82) and delegates snapshot revalidate notifications to the
 * owning provider. When the extension layer injects one shared cache (W3), it owns both
 * the error sink and the cross-pane repaint wiring instead.
 */
function createDefaultDirectoryCache(onDidRevalidate: () => void): DirectoryCache {
  return new DirectoryCache({
    readDirectory: readDirectoryFromWorkspaceFs,
    onError: (uri, error) => getLogChannel().error(`Directory listing failed for ${uri}: ${String(error)}`),
    onDidRevalidate,
  });
}

async function statSafe(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

function resolveIcon(icon: string | undefined): vscode.ThemeIcon | vscode.Uri | undefined {
  if (!icon) {
    return undefined;
  }
  if (path.isAbsolute(icon)) {
    return vscode.Uri.file(icon);
  }
  const themeIconId = icon.startsWith('$(') && icon.endsWith(')') ? icon.slice(2, -1) : icon;
  return new vscode.ThemeIcon(themeIconId);
}

/** Top-level row: the pane's own root (S4R6-D69: a pane is a standalone Folder Space). */
export class SpaceRootNode extends vscode.TreeItem {
  readonly parent: undefined = undefined;
  readonly rootPath: string;

  constructor(
    readonly definition: SpaceDefinition,
    readonly paneId: string,
    expanded = false
  ) {
    super(definition.name, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.rootPath = definition.basePath;
    // The pane id keeps ids unique when two panes show the same root (PD-I2).
    this.id = `codeFolderSpaces.${paneId}:root:${definition.basePath}`;
    this.resourceUri = vscode.Uri.file(definition.basePath);
    // v21-R5：來源寫進 contextValue，讓「Mark as Global／Unmark Global」由**被右鍵的節點**決定，
    // 不再依賴 `codeFolderSpaces.root.isGlobal`（右鍵不會改變選取，導致標記後仍顯示 Mark）。
    this.contextValue = originOf(definition) === 'global' ? 'codeFolderSpaces.spaceRoot.global' : 'codeFolderSpaces.spaceRoot';
    this.tooltip = definition.basePath;
    if (originOf(definition) === 'global') {
      // spec §3.4 允許 `$(globe)` 或前綴 `🌐`。實測（2026-10-19 EDH）：VS Code 的
      // `TreeItem.description` **不解析 codicon 語法**，寫 `$(globe)` 會原樣顯示成字面文字，
      // 故改用 Unicode 地球符號。
      const description = typeof this.description === 'string' ? this.description : '';
      this.description = description ? `🌐 ${description}` : '🌐';
    }
    this.iconPath = resolveIcon(definition.icon) ?? vscode.ThemeIcon.Folder;
  }

  /** Filesystem URI of this pane root. */
  get uri(): vscode.Uri {
    return vscode.Uri.file(this.rootPath);
  }
}

/** Directory or file row inside a pane. */
/** flat Contents「.」群組（pane root 直屬檔案）的 contextValue：不匹配任何資料夾選單／快捷鍵。 */
export const FLAT_ROOT_GROUP_CONTEXT = 'codeFolderSpaces.flatRootGroup';

let leafFolderIcon: { light: vscode.Uri; dark: vscode.Uri } | undefined;
/** 由 activate() 注入端點資料夾圖示（light／dark SVG）。 */
export function setLeafFolderIcon(extensionUri: vscode.Uri): void {
  leafFolderIcon = {
    light: vscode.Uri.joinPath(extensionUri, 'resources', 'folder-leaf-light.svg'),
    dark: vscode.Uri.joinPath(extensionUri, 'resources', 'folder-leaf-dark.svg'),
  };
}

export class SpaceEntryNode extends vscode.TreeItem {
  readonly parent: SpaceRootNode | SpaceEntryNode | undefined;
  /**
   * F-42 nested child rows (file nesting only; empty when nesting is inactive).
   * Collapsible parents get `ThemeIcon('file')` per D56 because a collapsible
   * file row would otherwise render with a folder twisty icon.
   */
  readonly nestedChildren: SpaceEntryNode[] = [];

  /** Owning pane, inherited through the parent chain to the root row. */
  readonly paneId: string;

  /** Owning pane root, inherited through the parent chain to the root row. */
  readonly rootPath: string;

  /** S4.1R6 OP-10：flat「全部」模式的資料夾群組列，記錄其直屬檔案的相對路徑（供過濾比對）。 */
  flatFileRelPaths?: string[];

  constructor(
    readonly uri: vscode.Uri,
    readonly isDirectory: boolean,
    readonly space: SpaceDefinition,
    parent: SpaceRootNode | SpaceEntryNode,
    hasChildren = false,
    hideRootParent = false
  ) {
    super(
      path.basename(uri.fsPath),
      isDirectory
        ? hasChildren
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.None
    );
    this.parent = hideRootParent && parent instanceof SpaceRootNode ? undefined : parent;
    this.paneId = parent.paneId;
    this.rootPath = parent.rootPath;
    this.id = `${isDirectory ? 'codeFolderSpaces.dir' : 'codeFolderSpaces.file'}:${this.paneId}:${uri.fsPath}`;
    this.resourceUri = uri;
    // OP-11：無子項的資料夾（端點）以小圓角矩形圖示標示（對照 Obsidian is-terminal-folder）；有子項者沿用原生 twisty＋主題圖示。
    if (isDirectory && !hasChildren && leafFolderIcon) this.iconPath = leafFolderIcon;
    this.contextValue = isDirectory ? 'codeFolderSpaces.folder' : 'codeFolderSpaces.file';
    this.tooltip = uri.fsPath;
    if (!isDirectory) {
      this.command = {
        command: 'codeFolderSpaces.openEntry',
        title: vscode.l10n.t('Open File'),
        arguments: [uri],
      };
    }
  }
}

/**
 * Per-pane tree scope (spec §2.4.6 D69): `definition` is the pane definition
 * resolved from the pane's own state (root + name/icon/showFiles/include/exclude),
 * not from a `spaces` setting index.
 */
export interface PaneProviderScope {
  paneId: string;
  definitions: SpaceDefinition[];
}

interface PaneTreeState {
  view: ViewSettings;
  filter: string;
  sort: { key: 'name' | 'mtime' | 'ctime'; direction: 'asc' | 'desc' };
  drillStack: readonly unknown[];
  drillRoot: string | null;
}

/**
 * Tree data provider for one pane slot.
 *
 * Folder-scoped tree over `workspace.fs`, directories first, optional files,
 * per-pane include/exclude globs. Native decorations, git status and problems
 * come for free through `resourceUri`.
 */
export class SpaceTreeDataProvider implements vscode.TreeDataProvider<SpaceNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SpaceNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SpaceNode | undefined | void> = this._onDidChangeTreeData.event;
  /** 過濾橫幅文字變更（審查 F2：列舉完成後即時更新 treeView.message）。 */
  private readonly _onDidChangeFilterMessage = new vscode.EventEmitter<string>();
  readonly onDidChangeFilterMessage: vscode.Event<string> = this._onDidChangeFilterMessage.event;

  private readonly _storeListener: vscode.Disposable;
  private _scope?: PaneProviderScope;
  private readonly _statCache = new StatCache();
  private _nestingRulesCache: { key: string; rules: FileNestingRule[] } | undefined;
  private readonly _directoryCache: DirectoryCache;
  private readonly _ownsDirectoryCache: boolean;
  /** Listing generation: bumped on refresh／root switch／dispose so stale awaits cause no side effects (S4R7-D83). */
  private _generation = 0;
  private _disposed = false;
  private _paneLinkMarkerProvider?: PaneLinkMarkerProvider;
  /** S4.1R20：跟隨 Explorer 隱藏規則（files.exclude 與 explorer.excludeGitIgnore）。
   *  未注入時不套用任何額外隱藏（保留既有行為）。 */
  explorerVisibility?: ExplorerVisibilityProvider;
  /** S4.1R17：扁平列舉最大遞歸深度（設定 `codeFolderSpaces.maxDepth`，預設 10）。 */
  maxDepth = DEFAULT_FLAT_MAX_DEPTH;
  filterMessage = '';

  /**
   * @param directoryCache Optional shared cache injected by the extension layer (S4R7 W3).
   * An injected cache is never disposed by this provider; without one the provider owns and
   * disposes its own default cache.
   */
  constructor(
    store: SpaceStore,
    private readonly _viewState?: PaneStateStore,
    scope?: PaneProviderScope,
    directoryCache?: DirectoryCache,
    paneLinkMarkerProvider?: PaneLinkMarkerProvider
  ) {
    this._scope = scope;
    this._paneLinkMarkerProvider = paneLinkMarkerProvider;
    this._ownsDirectoryCache = directoryCache === undefined;
    this._directoryCache = directoryCache ?? createDefaultDirectoryCache(() => {
      // Only a snapshot hint that actually changed triggers this, so one repaint converges (S4R7-D82).
      if (!this._disposed) {
        this.refresh();
      }
    });
    this._storeListener = store.onDidChange(() => this.refresh());
  }

  /** Replace the pane definition after a root/display change, then repaint. */
  setScope(scope: PaneProviderScope | undefined): void {
    this._scope = scope;
    // refresh() 遞增代次並失效快取：換根後舊根的列舉結果一律作廢（S4R7-D83）。
    this.refresh();
  }

  get scope(): PaneProviderScope | undefined {
    return this._scope;
  }

  effectiveDefinitions(): SpaceDefinition[] {
    const definitions = this._scope?.definitions ?? [];
    const drillRoot = this._paneState()?.drillRoot;
    if (!drillRoot) return definitions;
    const root = rootForUri(definitions.map(definition => definition.basePath), drillRoot);
    const definition = definitions.find(item => root !== null && samePath(item.basePath, root));
    return definition ? [{ ...definition, basePath: drillRoot }] : definitions;
  }

  private rootForPath(fsPath: string): SpaceDefinition | undefined {
    const definitions = this.effectiveDefinitions();
    if (definitions.length === 1) return definitions[0];
    const root = rootForUri(definitions.map(definition => definition.basePath), fsPath);
    return definitions.find(definition => root !== null && samePath(definition.basePath, root));
  }

  refresh(): void {
    this._generation += 1;
    if (this._disposed) {
      return;
    }
    // 手動 Refresh／寫入後 refresh／換根都不得保留已驗證的記憶體結果；
    // 只失效 memory/pending、保留快照提示（提示僅影響 chevron 且會背景 revalidate，審查 F1）。
    this._directoryCache.invalidateMemory();
    this._statCache.clear();
    this._nestingRulesCache = undefined;
    // filterMessage 不在此清空：橫幅保留上一代計數，直到新列舉完成以事件更新（審查 F2）。
    this._onDidChangeTreeData.fire();
  }

  /**
   * Waits until the directory reads that have already started converge (S4R7-D84).
   * Does not promise that the VS Code renderer has painted, and does not wait for
   * listings requested after this call.
   */
  async whenSettled(): Promise<void> {
    await this._directoryCache.whenSettled();
  }

  /** Set or replace the parent-side link marker callback, then repaint the tree. */
  setPaneLinkMarkerProvider(provider: PaneLinkMarkerProvider | undefined): void {
    this._paneLinkMarkerProvider = provider;
    this.refresh();
  }

  getTreeItem(element: SpaceNode): vscode.TreeItem {
    const isFolder = element instanceof SpaceRootNode || (element instanceof SpaceEntryNode && element.isDirectory);
    return applyPaneLinkMarker(element, element.paneId, element instanceof SpaceRootNode ? element.rootPath : element.uri.fsPath, isFolder, this._paneLinkMarkerProvider);
  }

  getParent(element: SpaceNode): SpaceNode | undefined {
    return element.parent;
  }

  /** S4.1R20：Explorer 等價隱藏（files.exclude + explorer.excludeGitIgnore）。 */
  private _hiddenByExplorer(relativePath: string, isDirectory: boolean): boolean {
    return this.explorerVisibility ? this.explorerVisibility(relativePath, isDirectory) : false;
  }

  private _paneState(): PaneTreeState | undefined {
    if (!this._viewState || !this._scope) return undefined;
    const state: PaneState = this._viewState.get(this._scope.paneId);
    return { view: effectiveView(state), filter: state.filter, sort: state.sort, drillStack: state.drillStack, drillRoot: state.drillRoot };
  }

  /**
   * Single directory-read seam (S4R7-D79/D82): display listings never serve an
   * unvalidated snapshot, only the chevron probe may (`allowSnapshot`).
   * A failed read resolves to an empty listing so existing display behaviour is unchanged;
   * the cache keeps nothing on failure and reports the error through its own sink.
   */
  private async _readEntries(uri: vscode.Uri, allowSnapshot: boolean): Promise<DirectoryEntry[]> {
    try {
      return await this._directoryCache.read(uri.toString(), allowSnapshot);
    } catch {
      return [];
    }
  }

  /** S4.1R2：為 true 時 root 列預設展開（follow 的子 pane 換根後即可看到第一層內容）。 */
  expandRoot = false;

  /** True when a refresh／root switch／dispose happened while an enumeration was awaited. */
  private _isStale(generation: number): boolean {
    return generation !== this._generation;
  }

  async getChildren(element?: SpaceNode): Promise<SpaceNode[]> {
    if (!element) {
      const definitions = this.effectiveDefinitions();
      if (definitions.length === 0) return [];
      if (definitions.length === 1) return this._listChildren(new SpaceRootNode(definitions[0], this._scope!.paneId, this.expandRoot));
      return definitions.map(definition => new SpaceRootNode(definition, this._scope!.paneId, this.expandRoot));
    }
    return this._listChildren(element);
  }

  /**
   * Resolves a filesystem path to a tree node (used by `TreeView.reveal`).
   * Returns `undefined` when the path is outside this pane's own root
   * (S4R6-D67: the boundary is the pane root, not the configured spaces)
   * or hidden by filters.
   */
  async findNodeByPath(fsPath: string): Promise<SpaceNode | undefined> {
    const scope = this._scope;
    if (!scope) {
      return undefined;
    }
    const normalized = path.normalize(fsPath);
    const definition = this.rootForPath(normalized);
    if (!definition) return undefined;
    const activeRoot = definition.basePath;
    if (!isInsideOrEqual(activeRoot, normalized)) {
      return undefined;
    }
    const viewState = this._paneState();
    if (samePath(activeRoot, normalized)) {
      return this.effectiveDefinitions().length === 1 ? undefined : new SpaceRootNode(definition, scope.paneId, this.expandRoot);
    }
    const settings = (viewState?.view ?? DEFAULT_VIEW);
    const segments = path
      .relative(activeRoot, normalized)
      .split(/[\\/]+/)
      .filter(Boolean);
    if (settings.level !== 'all' && segments.length > settings.level) {
      return undefined;
    }
    if (settings.mode === 'flat') {
      return this._findFlatNode(definition, scope.paneId, normalized, segments, settings.content, viewState?.filter ?? '');
    }
    let current: SpaceRootNode | SpaceEntryNode = new SpaceRootNode(definition, scope.paneId, this.expandRoot);
    let relativePath = '';
    for (const [index, segment] of segments.entries()) {
      const parentRelative = relativePath;
      relativePath = relativePath ? `${relativePath}/${segment}` : segment;
      const uri = vscode.Uri.joinPath(current.uri, segment);
      const stat = await statSafe(uri);
      if (!stat) {
        return undefined;
      }
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      if (isDirectory) {
        if (!isVisibleDirectory(segment, relativePath, definition.exclude)) {
          return undefined;
        }
      } else if (!definition.showFiles || !isVisibleFile(segment, relativePath, definition.include, definition.exclude)) {
        return undefined;
      }
      if (viewState?.filter && !matchesPathFilter(relativePath, viewState.filter)) {
        return undefined;
      }
      if (!isDirectory && index === segments.length - 1) {
        // F-42：最終段落若是嵌套子檔，父節點必須是同層父檔節點，
        // 否則 TreeView.reveal 的 getParent 鏈與渲染樹不一致（FN-I4）。
        const nestingNode = await this._resolveNestedAncestry(current, definition, settings, viewState, segment, parentRelative);
        if (nestingNode) {
          return nestingNode;
        }
      }
      current = new SpaceEntryNode(uri, isDirectory, definition, current, isDirectory, this.effectiveDefinitions().length === 1 && current instanceof SpaceRootNode);
    }
    return current;
  }

  /** S4.1R6：flat 模式的 reveal 節點——Files／Folders 為單層清單（父＝root）；All 為「資料夾群組＞檔案」兩層。 */
  private async _findFlatNode(
    definition: SpaceDefinition,
    paneId: string,
    target: string,
    segments: string[],
    content: 'all' | 'folders' | 'files',
    filter: string
  ): Promise<SpaceNode | undefined> {
    const stat = await statSafe(vscode.Uri.file(target));
    if (!stat) return undefined;
    const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    // 沿途資料夾須可見；最終段落依型別檢查。
    let relativePath = '';
    for (const [index, segment] of segments.entries()) {
      relativePath = relativePath ? `${relativePath}/${segment}` : segment;
      const last = index === segments.length - 1;
      if (last && !isDirectory) {
        if (!definition.showFiles || !isVisibleFile(segment, relativePath, definition.include, definition.exclude)) return undefined;
      } else if (!isVisibleDirectory(segment, relativePath, definition.exclude)) {
        return undefined;
      }
    }
    if (content === 'files' && isDirectory) return undefined;
    if (content === 'folders' && !isDirectory) return undefined;
    const root = new SpaceRootNode(definition, paneId, this.expandRoot);
    if (content !== 'all') {
      if (filter && !matchesPathFilter(relativePath, filter)) return undefined;
      return new SpaceEntryNode(vscode.Uri.file(target), isDirectory, definition, root, false, this.effectiveDefinitions().length === 1);
    }
    const groupUri = isDirectory ? vscode.Uri.file(target) : vscode.Uri.file(path.dirname(target));
    const group = new SpaceEntryNode(groupUri, true, definition, root, true, this.effectiveDefinitions().length === 1);
    const groupRelative = path.relative(definition.basePath, groupUri.fsPath).split(path.sep).join('/') || '.';
    if (isDirectory) {
      // 目錄目標也須符合群組保留條件（資料夾路徑符合；直屬檔案是否符合需讀取，故只檢查路徑或無過濾）。
      if (filter && !matchesPathFilter(groupRelative, filter)) {
        const hasMatchingFile = (await vscode.workspace.fs.readDirectory(groupUri)).some(([name, type]) => (type & vscode.FileType.File) !== 0 && matchesPathFilter(groupRelative === '.' ? name : `${groupRelative}/${name}`, filter));
        if (!hasMatchingFile) return undefined;
      }
      return group;
    }
    if (filter && !matchesPathFilter(relativePath, filter) && !matchesPathFilter(path.relative(definition.basePath, groupUri.fsPath).split(path.sep).join('/') || '.', filter)) return undefined;
    return new SpaceEntryNode(vscode.Uri.file(target), false, definition, group, false);
  }

  /**
   * F-42 reveal support: when `segment` (a file in directory `parent`) is nested under
   * one or more parent files, rebuild the fabricated parent-file chain so `getParent`
   * matches the rendered tree. Returns `undefined` when nesting is inactive or the
   * segment renders directly under `parent`.
   */
  private async _resolveNestedAncestry(
    parent: SpaceRootNode | SpaceEntryNode,
    space: SpaceDefinition,
    settings: ViewPreset,
    viewState: { filter?: string } | undefined,
    segment: string,
    parentRelative: string
  ): Promise<SpaceNode | undefined> {
    const nesting = this._nestingContext(settings, viewState);
    if (!nesting) {
      return undefined;
    }
    const visibleFiles = await this._visibleFileNames(parent.uri, space, parentRelative);
    const directoryName = path.basename(parent.uri.fsPath);
    const assignment = assignNestedChildren(visibleFiles.names, directoryName, nesting.rules, CASE_INSENSITIVE_PLATFORM);
    // 由 childrenOf 反向找出父鏈（assignment 為 forest，cycle 已在指派時截斷）。
    const chain: string[] = [];
    let cursor: string | undefined = segment;
    const seenNames = new Set<string>();
    while (cursor !== undefined && !seenNames.has(cursor)) {
      seenNames.add(cursor);
      const parentName = [...assignment.childrenOf.entries()].find(([, children]) => children.includes(cursor!))?.[0];
      if (parentName === undefined) {
        break;
      }
      chain.unshift(parentName);
      cursor = parentName;
    }
    if (chain.length === 0) {
      return undefined;
    }
    // 建立父鏈節點並彼此接通 nestedChildren：reveal 展開父列時會呼叫
    // getChildren，若未接通就會拿到空子列而無法定位（FN-I4）。
    const fabricated: SpaceEntryNode[] = [];
    let cursorNode: SpaceRootNode | SpaceEntryNode = parent;
    for (const parentName of chain) {
      const parentUri = visibleFiles.uriByName.get(parentName);
      if (!parentUri) {
        return undefined;
      }
      const parentNode = new SpaceEntryNode(parentUri, false, space, cursorNode, false, this.effectiveDefinitions().length === 1);
      if (fabricated.length > 0) {
        fabricated[fabricated.length - 1].nestedChildren.push(parentNode);
      }
      fabricated.push(parentNode);
      cursorNode = parentNode;
    }
    const leaf = new SpaceEntryNode(vscode.Uri.joinPath(parent.uri, segment), false, space, cursorNode);
    fabricated[fabricated.length - 1].nestedChildren.push(leaf);
    for (const parentNode of fabricated) {
      parentNode.collapsibleState = nesting.expand
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      parentNode.iconPath = new vscode.ThemeIcon('file');
    }
    return leaf;
  }

  /** F-42: visible file names (and URIs) of one directory, same rules as `_listChildren`. */
  private async _visibleFileNames(dirUri: vscode.Uri, space: SpaceDefinition, parentRelative: string): Promise<{ names: string[]; uriByName: Map<string, vscode.Uri> }> {
    const names: string[] = [];
    const uriByName = new Map<string, vscode.Uri>();
    for (const [name, type] of await this._readEntries(dirUri, false)) {
      if (!(type & vscode.FileType.File)) {
        continue;
      }
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      if (!space.showFiles || !isVisibleFile(name, relativePath, space.include, space.exclude)) {
        continue;
      }
      names.push(name);
      uriByName.set(name, vscode.Uri.joinPath(dirUri, name));
    }
    return { names, uriByName };
  }

  /**
   * F-42 嵌套啟用條件（spec §3 三項全成立）＋ patterns／expand 於列舉時讀取；
   * patterns 解析以 JSON key 記憶化，`refresh()` 清空，不做持久快取。
   */
  private _nestingContext(settings: ViewPreset, viewState: { filter?: string } | undefined): { rules: FileNestingRule[]; expand: boolean } | undefined {
    if (settings.mode !== 'tree' || settings.content === 'folders' || viewState?.filter) {
      return undefined;
    }
    const explorer = vscode.workspace.getConfiguration('explorer');
    if (explorer.get<boolean>('fileNesting.enabled', false) !== true) {
      return undefined;
    }
    const patterns = explorer.get<Record<string, string>>('fileNesting.patterns', {});
    const key = JSON.stringify(patterns);
    if (this._nestingRulesCache?.key !== key) {
      this._nestingRulesCache = { key, rules: parseNestingPatterns(patterns) };
    }
    const rules = this._nestingRulesCache.rules;
    if (rules.length === 0) {
      return undefined;
    }
    return { rules, expand: explorer.get<boolean>('fileNesting.expand', true) === true };
  }

  private async _listChildren(element: SpaceRootNode | SpaceEntryNode): Promise<SpaceNode[]> {
    const generation = this._generation;
    // F-42: file rows render their nested children; without nesting this stays empty
    // and the row keeps its existing CollapsibleState.None behaviour.
    if (element instanceof SpaceEntryNode && !element.isDirectory) {
      return element.nestedChildren;
    }
    const space = element instanceof SpaceRootNode ? element.definition : element.space;
    const viewState = this._paneState();
    const settings = (viewState?.view ?? DEFAULT_VIEW);
    if (element instanceof SpaceRootNode && settings.mode === 'flat') {
      const flat = await this._listFlat(space, element, settings.content, settings.level);
      if (this._isStale(generation)) {
        return [];
      }
      if (settings.content === 'all') {
        // 群組保留條件：資料夾路徑或其任一直屬檔案符合過濾。
        const filter = viewState?.filter ?? '';
        return this._applyFilter(flat, element.rootPath, filter, generation, node =>
          matchesPathFilter(path.relative(element.rootPath, node.uri.fsPath).replace(/\\/g, '/') || '.', filter)
          || (node.flatFileRelPaths ?? []).some(file => matchesPathFilter(file, filter)));
      }
      return this._applyFilter(flat, element.rootPath, viewState?.filter ?? '', generation);
    }
    if (settings.mode === 'flat' && element instanceof SpaceEntryNode && element.isDirectory) {
      return this._listFlatGroupFiles(space, element, viewState?.filter ?? '', generation);
    }
    if (settings.content === 'files' && element instanceof SpaceEntryNode && element.isDirectory) return [];
    if (settings.content === 'folders' && element instanceof SpaceEntryNode && !element.isDirectory) return [];
    const activeRoot = element.rootPath;
    const elementDepth = path.relative(activeRoot, element.uri.fsPath).split(/[\\/]+/).filter(Boolean).length;
    if (settings.level !== 'all' && elementDepth >= settings.level) return [];
    const entries = await this._readEntries(element.uri, false);
    if (this._isStale(generation)) {
      return [];
    }
    const parentRelative = path.relative(activeRoot, element.uri.fsPath).replace(/\\/g, '/');
    const directories: { name: string; uri: vscode.Uri; relativePath: string }[] = [];
    const fileCandidates: { name: string; uri: vscode.Uri }[] = [];

    for (const [name, type] of entries) {
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      const uri = vscode.Uri.joinPath(element.uri, name);
      if (type & vscode.FileType.Directory) {
        if (!isVisibleDirectory(name, relativePath, space.exclude) || this._hiddenByExplorer(relativePath, true)) {
          continue;
        }
        directories.push({ name, uri, relativePath });
      } else if (type & vscode.FileType.File) {
        if (settings.content === 'folders' || !space.showFiles || !isVisibleFile(name, relativePath, space.include, space.exclude)
          || this._hiddenByExplorer(relativePath, false)) {
          continue;
        }
        fileCandidates.push({ name, uri });
      }
    }

    const directoryNodes = await mapWithConcurrency(directories, DIRECTORY_CHILD_CHECK_CONCURRENCY, async (directory) => {
      const atLevelLimit = settings.level !== 'all' && elementDepth + 1 >= settings.level;
      const hasChildren = !atLevelLimit && await this._directoryHasVisibleChildren(directory.uri, space, directory.relativePath, settings);
      return new SpaceEntryNode(directory.uri, true, space, element, hasChildren, this.effectiveDefinitions().length === 1 && element instanceof SpaceRootNode);
    });
    if (this._isStale(generation)) {
      return [];
    }
    const nesting = this._nestingContext(settings, viewState);
    let files: SpaceEntryNode[];
    if (nesting) {
      // F-42：把同層可見檔案交由純邏輯模組指派巢狀父項，子項自同層移除（D54/D55/D56）。
      const assignment = assignNestedChildren(fileCandidates.map(file => file.name), path.basename(element.uri.fsPath), nesting.rules, CASE_INSENSITIVE_PLATFORM);
      const byName = new Map(fileCandidates.map(file => [file.name, file]));
      const buildSubtree = async (name: string, parentNode: SpaceRootNode | SpaceEntryNode, ancestors: ReadonlySet<string>): Promise<SpaceEntryNode> => {
        const candidate = byName.get(name)!;
        const node = new SpaceEntryNode(candidate.uri, false, space, parentNode, false, this.effectiveDefinitions().length === 1 && parentNode instanceof SpaceRootNode);
        const childNames = (assignment.childrenOf.get(name) ?? []).filter(child => child !== name && !ancestors.has(child) && byName.has(child));
        if (childNames.length > 0) {
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(name);
          const children = await Promise.all(childNames.map(child => buildSubtree(child, node, nextAncestors)));
          node.nestedChildren.push(...await this._sortNodes(children, generation));
          node.collapsibleState = nesting.expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
          node.iconPath = new vscode.ThemeIcon('file');
        }
        return node;
      };
      files = [];
      for (const candidate of fileCandidates) {
        if (assignment.nestedNames.has(candidate.name)) {
          continue;
        }
        files.push(await buildSubtree(candidate.name, element, new Set()));
      }
    } else {
      files = fileCandidates.map(candidate => new SpaceEntryNode(candidate.uri, false, space, element, false, this.effectiveDefinitions().length === 1 && element instanceof SpaceRootNode));
    }
    const candidates = [...directoryNodes, ...files];
    const sorted = await this._sortNodes(candidates, generation);
    if (this._isStale(generation)) {
      return [];
    }
    return this._applyFilter(sorted, activeRoot, viewState?.filter ?? '', generation);
  }

  private async _listFlat(
    space: SpaceDefinition,
    root: SpaceRootNode,
    content: 'all' | 'folders' | 'files',
    level: 1 | 2 | 'all'
  ): Promise<SpaceEntryNode[]> {
    const generation = this._generation;
    const listing = await buildFlatListing(async (parent: vscode.Uri | undefined) => {
      // 舊代次的遞迴不再打來源，也不再產生可被回填的讀取（S4R7-D83）。
      if (this._isStale(generation)) {
        return [];
      }
      const parentUri = parent ?? root.uri;
      const parentRelative = path.relative(root.rootPath, parentUri.fsPath).replace(/\\/g, '/');
      const result: { value: vscode.Uri; isDirectory: boolean }[] = [];
      for (const [name, type] of await this._readEntries(parentUri, false)) {
        const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
        const uri = vscode.Uri.joinPath(parentUri, name);
        if (type & vscode.FileType.Directory) {
          if (isVisibleDirectory(name, relativePath, space.exclude) && !this._hiddenByExplorer(relativePath, true)) result.push({ value: uri, isDirectory: true });
        } else if (type & vscode.FileType.File) {
          if (content !== 'folders' && space.showFiles && isVisibleFile(name, relativePath, space.include, space.exclude)
            && !this._hiddenByExplorer(relativePath, false)) {
            result.push({ value: uri, isDirectory: false });
          }
        }
      }
      return result;
    }, this.maxDepth, level);
    if (this._isStale(generation)) {
      return [];
    }
    const relativeOf = (uri: vscode.Uri): string => path.relative(root.rootPath, uri.fsPath).replace(/\\/g, '/');

    if (content === 'all') {
      // OP-10：第一層＝資料夾群組（標籤為自 pane root 起的相對路徑；root 直屬檔案歸入「.」群組），
      // 第二層＝該資料夾的直屬檔案（僅檔名）。群組是否可展開取決於是否有直屬檔案。
      const filesByDir = new Map<string, string[]>();
      for (const { value: uri, isDirectory } of listing) {
        if (isDirectory) continue;
        const dir = path.dirname(uri.fsPath);
        const list = filesByDir.get(dir) ?? [];
        list.push(relativeOf(uri));
        filesByDir.set(dir, list);
      }
      const groups: SpaceEntryNode[] = [];
      const makeGroup = (uri: vscode.Uri, label: string): SpaceEntryNode => {
        const files = filesByDir.get(uri.fsPath) ?? [];
        const node = new SpaceEntryNode(uri, true, space, root, files.length > 0, this.effectiveDefinitions().length === 1);
        node.label = label;
        node.flatFileRelPaths = files;
        return node;
      };
      if (filesByDir.has(root.uri.fsPath)) {
        // 「.」群組代表 pane root 本身：不得具資料夾 CRUD／拖放語意（見 FLAT_ROOT_GROUP_CONTEXT）。
        const rootGroup = makeGroup(root.uri, '.');
        rootGroup.contextValue = FLAT_ROOT_GROUP_CONTEXT;
        groups.push(rootGroup);
      }
      for (const { value: uri, isDirectory } of listing) {
        if (isDirectory) groups.push(makeGroup(uri, relativeOf(uri)));
      }
      return this._sortNodes(groups, generation);
    }

    // Files／Folders：第一級清單，項目名稱為自 pane root 起的完整相對路徑。
    // 在 Flat 模式下資料夾皆不可展開（點擊無子項可開合），一律顯示端點符號。
    const nodes = listing
      .filter(({ isDirectory }) => content === 'folders' ? isDirectory : !isDirectory)
      .map(({ value: uri, isDirectory }) => {
        const node = new SpaceEntryNode(uri, isDirectory, space, root, false, this.effectiveDefinitions().length === 1);
        node.label = relativeOf(uri);
        return node;
      });
    return this._sortNodes(nodes, generation);
  }

  /** flat「全部」模式：群組列展開時列出該資料夾的直屬檔案（僅檔名）。 */
  private async _listFlatGroupFiles(
    space: SpaceDefinition,
    group: SpaceEntryNode,
    filter: string,
    generation: number
  ): Promise<SpaceNode[]> {
    if (!space.showFiles) return [];
    const parentRelative = path.relative(group.rootPath, group.uri.fsPath).replace(/\\/g, '/');
    const groupMatches = !filter || matchesPathFilter(parentRelative || '.', filter);
    const nodes: SpaceEntryNode[] = [];
    for (const [name, type] of await this._readEntries(group.uri, false)) {
      if (!(type & vscode.FileType.File)) continue;
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      if (!isVisibleFile(name, relativePath, space.include, space.exclude)) continue;
      if (!groupMatches && !matchesPathFilter(relativePath, filter)) continue;
      nodes.push(new SpaceEntryNode(vscode.Uri.joinPath(group.uri, name), false, space, group, false));
    }
    if (this._isStale(generation)) return [];
    return this._sortNodes(nodes, generation);
  }

  private _applyFilter(
    nodes: SpaceEntryNode[],
    rootPath: string,
    filter: string,
    generation: number,
    matcher?: (node: SpaceEntryNode) => boolean
  ): SpaceEntryNode[] {
    const filtered = filter ? nodes.filter(node => matcher ? matcher(node) : matchesPathFilter(path.relative(rootPath, node.uri.fsPath).replace(/\\/g, '/'), filter)) : nodes;
    const message = filter ? vscode.l10n.t('{0} / {1} matches', filtered.length, nodes.length) : '';
    // `filterMessage` 是跨列舉共享的可變欄位：只有代次仍相符的列舉能寫入（S4R7-D83），
    // 並在內容變更時通知外層即時更新 treeView.message（審查 F2）。
    if (!this._isStale(generation) && message !== this.filterMessage) {
      this.filterMessage = message;
      this._onDidChangeFilterMessage.fire(message);
    }
    return filtered;
  }

  private async _sortNodes(nodes: SpaceEntryNode[], generation: number): Promise<SpaceEntryNode[]> {
    const sort = this._paneState()?.sort ?? { key: 'name' as const, direction: 'asc' as const };
    const entries = nodes.map(node => ({ name: String(node.label ?? ''), uri: node.uri.toString(), node }));
    const statTimes = async (entry: SortableEntry) => {
      // 代次已變：不讀 stat、不回填備忘錄，呼叫端會丢棄整個結果（S4R7-D83）。
      if (this._isStale(generation)) {
        return undefined;
      }
      return this._statCache.get(entry.uri, async () => {
        try { const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(entry.uri)); return { mtime: stat.mtime, ctime: stat.ctime }; }
        catch { return undefined; }
      });
    };
    if (sort.key === 'name') {
      const folders = entries.filter(entry => entry.node.isDirectory);
      const files = entries.filter(entry => !entry.node.isDirectory);
      const sortedFolders = await sortEntries(folders, sort.key, sort.direction, statTimes);
      const sortedFiles = await sortEntries(files, sort.key, sort.direction, statTimes);
      return [...sortedFolders, ...sortedFiles].map(entry => entry.node);
    }
    return (await sortEntries(entries, sort.key, sort.direction, statTimes)).map(entry => entry.node);
  }

  private async _directoryHasVisibleChildren(
    uri: vscode.Uri,
    space: SpaceDefinition,
    parentRelative: string,
    settings: ViewPreset
  ): Promise<boolean> {
    // D79：快照只允許用在此處（chevron「有無子項」提示）；實際顯示列一律走 allowSnapshot=false。
    const entries = await this._readEntries(uri, true);
    return entries.some(([name, type]) => {
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      if (type & vscode.FileType.Directory) {
        return isVisibleDirectory(name, relativePath, space.exclude);
      }
      if (type & vscode.FileType.File) {
        return settings.content !== 'folders' && space.showFiles && isVisibleFile(name, relativePath, space.include, space.exclude);
      }
      return false;
    });
  }

  dispose(): void {
    this._disposed = true;
    // 作廢所有在途列舉的副作用，並停止本 provider 的後續事件（S4R7-D83）。
    this._generation += 1;
    this._storeListener.dispose();
    this._onDidChangeTreeData.dispose();
    this._onDidChangeFilterMessage.dispose();
    if (this._ownsDirectoryCache) {
      this._directoryCache.dispose();
    }
  }
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInsideOrEqual(basePath: string, candidate: string): boolean {
  const relative = path.relative(basePath, candidate);
  if (relative === '') {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
