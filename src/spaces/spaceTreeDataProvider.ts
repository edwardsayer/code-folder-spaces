import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceDefinition } from '../types';
import { mapWithConcurrency } from '../util/concurrency';
import { isVisibleDirectory, isVisibleFile } from './spaceConfig';
import { assignNestedChildren, parseNestingPatterns } from './fileNesting';
import type { FileNestingRule } from './fileNesting';
import { buildFlatListing } from './flatListing';
import { VIEW_PRESETS } from './viewPresets';
import type { ViewPreset } from './viewPresets';
import { matchesPathFilter, sortEntries, StatCache } from './sortEntries';
import type { SortableEntry } from './sortEntries';
import type { SpaceStore } from './spaceStore';
import type { PaneStateStore } from './viewState';

export type SpaceNode = SpaceRootNode | SpaceEntryNode;

const DIRECTORY_CHILD_CHECK_CONCURRENCY = 16;

/** F-42: file-nesting matching is case-insensitive on these platforms (spec §2). */
const CASE_INSENSITIVE_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';

async function readDirectorySafe(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
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

/** Top-level row: one configured folder space. */
export class SpaceRootNode extends vscode.TreeItem {
  constructor(
    readonly definition: SpaceDefinition,
    readonly parent: undefined,
    readonly rootPath = definition.basePath
  ) {
    super(
      samePath(rootPath, definition.basePath) ? definition.name : path.basename(rootPath),
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.id = `codeFolderSpaces.space:${rootPath}`;
    this.resourceUri = vscode.Uri.file(rootPath);
    this.contextValue = 'codeFolderSpaces.spaceRoot';
    this.tooltip = rootPath;
    this.iconPath = resolveIcon(definition.icon) ?? vscode.ThemeIcon.Folder;
  }

  /** Filesystem URI of this space root. */
  get uri(): vscode.Uri {
    return vscode.Uri.file(this.rootPath);
  }
}

/** Directory or file row inside a space. */
export class SpaceEntryNode extends vscode.TreeItem {
  /**
   * F-42 nested child rows (file nesting only; empty when nesting is inactive).
   * Collapsible parents get `ThemeIcon('file')` per D56 because a collapsible
   * file row would otherwise render with a folder twisty icon.
   */
  readonly nestedChildren: SpaceEntryNode[] = [];

  constructor(
    readonly uri: vscode.Uri,
    readonly isDirectory: boolean,
    readonly space: SpaceDefinition,
    readonly parent: SpaceRootNode | SpaceEntryNode,
    hasChildren = false
  ) {
    super(
      path.basename(uri.fsPath),
      isDirectory
        ? hasChildren
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.None
    );
    this.id = `${isDirectory ? 'codeFolderSpaces.dir' : 'codeFolderSpaces.file'}:${uri.fsPath}`;
    this.resourceUri = uri;
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
 * Tree data provider for `codeFolderSpaces.pane1`.
 *
 * Stage 1 scope: folder-scoped tree over `workspace.fs`, directories first,
 * optional files, per-space include/exclude globs. Native decorations,
 * git status and problems come for free through `resourceUri`.
 */
export interface PaneProviderScope {
  basePath: string;
  root: string | null;
}

/**
 * 依設計 spec §3.3 解析一個空間在目前 pane 應顯示的根：
 * `drillStack` 非空（已就地下鑽）→ 顯示下鑽根；否則顯示 pane 的鏈結根。
 * 鏈結根不適用（例：非此 pane 的空間）時回退為下鑽根或空間 basePath。
 */
export function resolveActiveRoot(
  state: { root?: string; drillStack?: readonly unknown[] } | undefined,
  basePath: string,
  paneRoot?: string | null,
): string {
  if ((state?.drillStack?.length ?? 0) === 0 && paneRoot) return paneRoot;
  return state?.root ?? basePath;
}

export class SpaceTreeDataProvider implements vscode.TreeDataProvider<SpaceNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SpaceNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SpaceNode | undefined | void> = this._onDidChangeTreeData.event;

  private readonly _storeListener: vscode.Disposable;
  private _definitions: SpaceDefinition[];
  private readonly _statCache = new StatCache();
  private _nestingRulesCache: { key: string; rules: FileNestingRule[] } | undefined;
  filterMessage = '';
  readonly staleRoots = new Set<string>();

  constructor(private readonly _store: SpaceStore, private readonly _viewState?: PaneStateStore, private readonly _paneScope?: PaneProviderScope) {
    this._definitions = _store.getDefinitions();
    this._storeListener = _store.onDidChange(() => this.refresh());
  }

  markStale(basePath: string): void { this.staleRoots.add(basePath); this.refresh(); }
  clearStale(basePath: string): void { this.staleRoots.delete(basePath); }

  refresh(): void {
    this._statCache.clear();
    this._nestingRulesCache = undefined;
    this.filterMessage = '';
    this._definitions = this._store.getDefinitions();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SpaceNode): vscode.TreeItem {
    return element;
  }

  getParent(element: SpaceNode): SpaceNode | undefined {
    return element.parent;
  }

  /** 目前 pane 應顯示的根（依 spec §3.3）；供 extension 組節點時重用同一解析。 */
  activeRootFor(definition: SpaceDefinition): string {
    return this._activeRoot(definition);
  }

  private _activeRoot(definition: SpaceDefinition): string {
    const state = this._viewState?.get(definition.basePath);
    const scopeMatchesDefinition = Boolean(this._paneScope && samePath(definition.basePath, this._paneScope.basePath));
    return resolveActiveRoot(state, definition.basePath, scopeMatchesDefinition ? this._paneScope!.root : null);
  }

  async getChildren(element?: SpaceNode): Promise<SpaceNode[]> {
    if (!element) {
      const definitions = this._paneScope
        ? this._definitions.filter(definition => samePath(definition.basePath, this._paneScope!.basePath))
        : this._definitions;
      return definitions.map((definition) => new SpaceRootNode(definition, undefined, this._activeRoot(definition)));
    }
    return this._listChildren(element);
  }

  /**
   * Resolves a filesystem path to a tree node (used by `TreeView.reveal`).
   * Returns `undefined` when the path is outside every space or hidden by filters.
   */
  async findNodeByPath(fsPath: string): Promise<SpaceNode | undefined> {
    const normalized = path.normalize(fsPath);
    const definition = [...this._definitions]
      .filter((candidate) => (!this._paneScope || samePath(candidate.basePath, this._paneScope.basePath)) && isInsideOrEqual(candidate.basePath, normalized))
      .sort((a, b) => b.basePath.length - a.basePath.length)[0];
    if (!definition) {
      return undefined;
    }
    const viewState = this._viewState?.get(definition.basePath);
    const activeRoot = this._activeRoot(definition);
    if (!isInsideOrEqual(activeRoot, normalized)) {
      return undefined;
    }
    if (samePath(activeRoot, normalized)) {
      return new SpaceRootNode(definition, undefined, activeRoot);
    }
    const settings = VIEW_PRESETS[viewState?.preset ?? 'Explorer'];
    const segments = path
      .relative(activeRoot, normalized)
      .split(/[\\/]+/)
      .filter(Boolean);
    if (settings.level !== 'all' && segments.length > settings.level) {
      return undefined;
    }
    let current: SpaceRootNode | SpaceEntryNode = new SpaceRootNode(definition, undefined, activeRoot);
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
      current = new SpaceEntryNode(uri, isDirectory, definition, current, isDirectory);
    }
    return current;
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
    // 由 childrenOf 反向找出父鏈（assignment 為forest，cycle 已在指派時截斷）。
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
      const parentNode = new SpaceEntryNode(parentUri, false, space, cursorNode);
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
    for (const [name, type] of await readDirectorySafe(dirUri)) {
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
    // F-42: file rows render their nested children; without nesting this stays empty
    // and the row keeps its existing CollapsibleState.None behaviour.
    if (element instanceof SpaceEntryNode && !element.isDirectory) {
      return element.nestedChildren;
    }
    const space = element instanceof SpaceRootNode ? element.definition : element.space;
    const viewState = this._viewState?.get(space.basePath);
    const settings = VIEW_PRESETS[viewState?.preset ?? 'Explorer'];
    if (element instanceof SpaceRootNode && settings.mode === 'flat') {
      const flat = await this._listFlat(space, element, settings.content, settings.level);
      return this._applyFilter(flat, element.rootPath, viewState?.filter ?? '');
    }
    if (settings.content === 'files' && element instanceof SpaceEntryNode && element.isDirectory) return [];
    if (settings.content === 'folders' && element instanceof SpaceEntryNode && !element.isDirectory) return [];
    const activeRoot = element instanceof SpaceRootNode ? element.rootPath : this._activeRoot(space);
    const elementDepth = element instanceof SpaceRootNode ? 0 : path.relative(activeRoot, element.uri.fsPath).split(/[\\/]+/).filter(Boolean).length;
    if (settings.level !== 'all' && elementDepth >= settings.level) return [];
    const entries = await readDirectorySafe(element.uri);
    const parentRelative = path.relative(activeRoot, element.uri.fsPath).replace(/\\/g, '/');
    const directories: { name: string; uri: vscode.Uri; relativePath: string }[] = [];
    const fileCandidates: { name: string; uri: vscode.Uri }[] = [];

    for (const [name, type] of entries) {
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      const uri = vscode.Uri.joinPath(element.uri, name);
      if (type & vscode.FileType.Directory) {
        if (!isVisibleDirectory(name, relativePath, space.exclude)) {
          continue;
        }
        directories.push({ name, uri, relativePath });
      } else if (type & vscode.FileType.File) {
        if (settings.content === 'folders' || !space.showFiles || !isVisibleFile(name, relativePath, space.include, space.exclude)) {
          continue;
        }
        fileCandidates.push({ name, uri });
      }
    }

    const directoryNodes = await mapWithConcurrency(directories, DIRECTORY_CHILD_CHECK_CONCURRENCY, async (directory) => {
      const atLevelLimit = settings.level !== 'all' && elementDepth + 1 >= settings.level;
      const hasChildren = !atLevelLimit && await this._directoryHasVisibleChildren(directory.uri, space, directory.relativePath);
      return new SpaceEntryNode(directory.uri, true, space, element, hasChildren);
    });
    const nesting = this._nestingContext(settings, viewState);
    let files: SpaceEntryNode[];
    if (nesting) {
      // F-42：把同層可見檔案交由純邏輯模組指派巢狀父項，子項自同層移除（D54/D55/D56）。
      const assignment = assignNestedChildren(fileCandidates.map(file => file.name), path.basename(element.uri.fsPath), nesting.rules, CASE_INSENSITIVE_PLATFORM);
      const byName = new Map(fileCandidates.map(file => [file.name, file]));
      const buildSubtree = async (name: string, parentNode: SpaceRootNode | SpaceEntryNode, ancestors: ReadonlySet<string>): Promise<SpaceEntryNode> => {
        const candidate = byName.get(name)!;
        const node = new SpaceEntryNode(candidate.uri, false, space, parentNode);
        const childNames = (assignment.childrenOf.get(name) ?? []).filter(child => child !== name && !ancestors.has(child) && byName.has(child));
        if (childNames.length > 0) {
          const nextAncestors = new Set(ancestors);
          nextAncestors.add(name);
          const children = await Promise.all(childNames.map(child => buildSubtree(child, node, nextAncestors)));
          node.nestedChildren.push(...await this._sortNodes(children, space.basePath));
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
      files = fileCandidates.map(candidate => new SpaceEntryNode(candidate.uri, false, space, element));
    }
    const candidates = [...directoryNodes, ...files];
    const sorted = await this._sortNodes(candidates, space.basePath);
    return this._applyFilter(sorted, activeRoot, viewState?.filter ?? '');
  }

  private async _listFlat(
    space: SpaceDefinition,
    root: SpaceRootNode,
    content: 'all' | 'folders' | 'files',
    level: 1 | 2 | 'all'
  ): Promise<SpaceEntryNode[]> {
    const listing = await buildFlatListing(async (parent: vscode.Uri | undefined) => {
      const parentUri = parent ?? root.uri;
      const parentRelative = path.relative(root.rootPath, parentUri.fsPath).replace(/\\/g, '/');
      const result: { value: vscode.Uri; isDirectory: boolean }[] = [];
      for (const [name, type] of await readDirectorySafe(parentUri)) {
        const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
        const uri = vscode.Uri.joinPath(parentUri, name);
        if (type & vscode.FileType.Directory) {
          if (isVisibleDirectory(name, relativePath, space.exclude)) result.push({ value: uri, isDirectory: true });
        } else if (type & vscode.FileType.File) {
          if (content !== 'folders' && space.showFiles && isVisibleFile(name, relativePath, space.include, space.exclude)) {
            result.push({ value: uri, isDirectory: false });
          }
        }
      }
      return result;
    }, undefined, level);
    const nodes = listing
      .filter(({ isDirectory }) => content === 'all' ? true : content === 'folders' ? isDirectory : !isDirectory)
      .map(({ value: uri, isDirectory }) => {
        const relative = path.relative(root.rootPath, uri.fsPath).replace(/\\/g, '/');
        const node = new SpaceEntryNode(uri, isDirectory, space, root, false);
        node.description = relative;
        if (isDirectory) node.iconPath = vscode.ThemeIcon.Folder;
        return node;
      });
    const sorted = await this._sortNodes(nodes, space.basePath);
    return content === 'all' ? sorted.sort((a, b) => path.posix.dirname(String(a.description)).localeCompare(path.posix.dirname(String(b.description)), undefined, { sensitivity: 'base' })) : sorted;
  }

  private _applyFilter(nodes: SpaceEntryNode[], rootPath: string, filter: string): SpaceEntryNode[] {
    const filtered = filter ? nodes.filter(node => matchesPathFilter(path.relative(rootPath, node.uri.fsPath).replace(/\\/g, '/'), filter)) : nodes;
    this.filterMessage = filter ? vscode.l10n.t('{0} / {1} matches', filtered.length, nodes.length) : '';
    return filtered;
  }

  private async _sortNodes(nodes: SpaceEntryNode[], basePath: string): Promise<SpaceEntryNode[]> {
    const sort = this._viewState?.get(basePath).sort ?? { key: 'name' as const, direction: 'asc' as const };
    const entries = nodes.map(node => ({ name: String(node.label ?? ''), uri: node.uri.toString(), node }));
    const statTimes = async (entry: SortableEntry) => this._statCache.get(entry.uri, async () => {
      try { const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(entry.uri)); return { mtime: stat.mtime, ctime: stat.ctime }; }
      catch { return undefined; }
    });
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
    parentRelative: string
  ): Promise<boolean> {
    const entries = await readDirectorySafe(uri);
    const preset = VIEW_PRESETS[this._viewState?.get(space.basePath).preset ?? 'Explorer'];
    return entries.some(([name, type]) => {
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      if (type & vscode.FileType.Directory) {
        return isVisibleDirectory(name, relativePath, space.exclude);
      }
      if (type & vscode.FileType.File) {
        return preset.content !== 'folders' && space.showFiles && isVisibleFile(name, relativePath, space.include, space.exclude);
      }
      return false;
    });
  }

  dispose(): void {
    this._storeListener.dispose();
    this._onDidChangeTreeData.dispose();
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
