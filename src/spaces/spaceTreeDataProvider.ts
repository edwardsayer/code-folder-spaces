import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceDefinition } from '../types';
import { mapWithConcurrency } from '../util/concurrency';
import { isVisibleDirectory, isVisibleFile } from './spaceConfig';
import type { SpaceStore } from './spaceStore';

export type SpaceNode = SpaceRootNode | SpaceEntryNode;

const DIRECTORY_CHILD_CHECK_CONCURRENCY = 16;

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
    readonly parent: undefined
  ) {
    super(definition.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `codeFolderSpaces.space:${definition.basePath}`;
    this.resourceUri = vscode.Uri.file(definition.basePath);
    this.contextValue = 'codeFolderSpaces.spaceRoot';
    this.tooltip = definition.basePath;
    this.iconPath = resolveIcon(definition.icon) ?? vscode.ThemeIcon.Folder;
  }

  /** Filesystem URI of this space root. */
  get uri(): vscode.Uri {
    return vscode.Uri.file(this.definition.basePath);
  }
}

/** Directory or file row inside a space. */
export class SpaceEntryNode extends vscode.TreeItem {
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
        command: 'vscode.open',
        title: vscode.l10n.t('Open File'),
        arguments: [uri],
      };
    }
  }
}

/**
 * Tree data provider for `codeFolderSpaces.explorer`.
 *
 * Stage 1 scope: folder-scoped tree over `workspace.fs`, directories first,
 * optional files, per-space include/exclude globs. Native decorations,
 * git status and problems come for free through `resourceUri`.
 */
export class SpaceTreeDataProvider implements vscode.TreeDataProvider<SpaceNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SpaceNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SpaceNode | undefined | void> = this._onDidChangeTreeData.event;

  private readonly _storeListener: vscode.Disposable;
  private _definitions: SpaceDefinition[];

  constructor(private readonly _store: SpaceStore) {
    this._definitions = _store.getDefinitions();
    this._storeListener = _store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._definitions = this._store.getDefinitions();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SpaceNode): vscode.TreeItem {
    return element;
  }

  getParent(element: SpaceNode): SpaceNode | undefined {
    return element.parent;
  }

  async getChildren(element?: SpaceNode): Promise<SpaceNode[]> {
    if (!element) {
      return this._definitions.map((definition) => new SpaceRootNode(definition, undefined));
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
      .filter((candidate) => isInsideOrEqual(candidate.basePath, normalized))
      .sort((a, b) => b.basePath.length - a.basePath.length)[0];
    if (!definition) {
      return undefined;
    }
    if (samePath(definition.basePath, normalized)) {
      return new SpaceRootNode(definition, undefined);
    }
    const segments = path
      .relative(definition.basePath, normalized)
      .split(/[\\/]+/)
      .filter(Boolean);
    let current: SpaceRootNode | SpaceEntryNode = new SpaceRootNode(definition, undefined);
    let relativePath = '';
    for (const segment of segments) {
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
      current = new SpaceEntryNode(uri, isDirectory, definition, current, isDirectory);
    }
    return current;
  }

  private async _listChildren(element: SpaceRootNode | SpaceEntryNode): Promise<SpaceNode[]> {
    const space = element instanceof SpaceRootNode ? element.definition : element.space;
    const entries = await readDirectorySafe(element.uri);
    const parentRelative = path.relative(space.basePath, element.uri.fsPath).replace(/\\/g, '/');
    const directories: { name: string; uri: vscode.Uri; relativePath: string }[] = [];
    const files: SpaceNode[] = [];

    for (const [name, type] of entries) {
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      const uri = vscode.Uri.joinPath(element.uri, name);
      if (type & vscode.FileType.Directory) {
        if (!isVisibleDirectory(name, relativePath, space.exclude)) {
          continue;
        }
        directories.push({ name, uri, relativePath });
      } else if (type & vscode.FileType.File) {
        if (!space.showFiles || !isVisibleFile(name, relativePath, space.include, space.exclude)) {
          continue;
        }
        files.push(new SpaceEntryNode(uri, false, space, element));
      }
    }

    const directoryNodes = await mapWithConcurrency(directories, DIRECTORY_CHILD_CHECK_CONCURRENCY, async (directory) => {
      const hasChildren = await this._directoryHasVisibleChildren(directory.uri, space, directory.relativePath);
      return new SpaceEntryNode(directory.uri, true, space, element, hasChildren);
    });
    const byLabel = (a: SpaceNode, b: SpaceNode): number =>
      String(a.label ?? '').localeCompare(String(b.label ?? ''), undefined, { sensitivity: 'base' });
    directoryNodes.sort(byLabel);
    files.sort(byLabel);
    return [...directoryNodes, ...files];
  }

  private async _directoryHasVisibleChildren(
    uri: vscode.Uri,
    space: SpaceDefinition,
    parentRelative: string
  ): Promise<boolean> {
    const entries = await readDirectorySafe(uri);
    return entries.some(([name, type]) => {
      const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
      if (type & vscode.FileType.Directory) {
        return isVisibleDirectory(name, relativePath, space.exclude);
      }
      if (type & vscode.FileType.File) {
        return space.showFiles && isVisibleFile(name, relativePath, space.include, space.exclude);
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
