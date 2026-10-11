import * as vscode from 'vscode';
import * as path from 'node:path';
import type { SpaceDefinition } from './types';
import { SpaceEntryNode, SpaceRootNode, SpaceTreeDataProvider } from './spaces/spaceTreeDataProvider';
import type { SpaceNode } from './spaces/spaceTreeDataProvider';
import { SpaceStore } from './spaces/spaceStore';
import { DEFAULT_VIEW_PRESET, VIEW_PRESETS, isViewPresetName } from './spaces/viewPresets';
import { classifySpaceRename, normalizeSpaceKey, PaneStateStore, resolvePaneDefinition } from './spaces/viewState';
import { isPaneRootDirectory } from './spaces/paneLinks';
import { PaneCascadeController } from './spaces/paneCascade';
import { copyTreeEntry, createTreeDragAndDropController } from './spaces/treeDragAndDrop';
import { canModifyFiles, isAllowedSpaceRoot, isSafeMove, isSamePath, isValidEntryName, resolvePasteTarget, resolveOpenBeside, hasDrillStateWithinMovedSources, SpaceClipboard, UndoStack, validateSpaceName } from './spaces/spaceActions';
import { disposeLogChannel, getLogChannel } from './util/log';
import { resolveActiveTabUri, shouldFollowActiveFile } from './spaces/followActiveFile';

const MAX_PANE_INDEX = 8;
const REFRESH_DEBOUNCE_MS = 200;
const FOLLOW_DEBOUNCE_MS = 250;

/** Public surface returned from `activate()` for other extensions. */
export interface FolderSpacesApi {
  readonly version: string;
  getSpaces(): Array<{ name: string; basePath: string }>;
}

/** Runtime of one enabled pane: provider + TreeView + cascade scope (paneId-keyed, S4R6). */
interface PaneRuntime {
  id: string;
  provider: SpaceTreeDataProvider;
  treeView: vscode.TreeView<SpaceNode>;
  scope?: { paneId: string; root: string | null };
  staleRoot?: string;
  disposables: vscode.Disposable[];
}

interface NodeInfo {
  paneId: string;
  uri: vscode.Uri;
  isDirectory: boolean;
  definition: SpaceDefinition;
}

function paneIndexOf(paneId: string): number {
  const match = /^pane([1-8])$/.exec(paneId);
  return match ? Number(match[1]) : 0;
}

export async function activate(context: vscode.ExtensionContext): Promise<FolderSpacesApi> {
  const log = getLogChannel();
  log.info('Activating Folder Spaces');

  const store = new SpaceStore();
  const viewState = new PaneStateStore(context.workspaceState);
  const settings = () => vscode.workspace.getConfiguration('codeFolderSpaces');
  const paneInitContext = () => ({
    spaces: store.getDefinitions(),
    showFilesDefault: settings().get<boolean>('view.showFiles', true),
    configuredCount: settings().get<number>('panes.count', 2),
  });
  const layout = await viewState.initialize(paneInitContext());
  if (layout.kind === 'rebuilt') {
    log.warn(`Rebuilt default pane layout: ${layout.reason}`);
  } else {
    log.info(`Pane layout ${layout.kind}; ${'enabled' in layout ? layout.enabled : 0} pane(s)`);
  }

  // 所有 pane 與命令共用 session-only undo；回呼延後取用後方建立的服務。
  const undoStack = new UndoStack();
  const clipboard = new SpaceClipboard();

  const paneRuntime = new Map<string, PaneRuntime>();
  const cascadeDisposables = new Map<string, vscode.Disposable>();
  const cascadeController = new PaneCascadeController({
    state: {
      getPaneLinks: () => viewState.getPaneLinks(),
      // D74：父 pane 每次選取不同資料夾時寫入子 root（手動值自然被取代），不關閉 follow。
      setPaneRoot: async (paneId, root) => {
        await viewState.setPaneRoot(paneId, root);
        applyPaneScope(paneId);
        rebuildWatchers();
        await syncPaneContexts();
      },
    },
    getRuntime: paneId => paneRuntime.get(paneId),
    // D67：選取項必須位於父 pane 自己的 root 之內（防禦性；不再要求位於子 pane 舊 root 內）。
    isAllowedRoot: (paneRoot, candidate) => isAllowedSpaceRoot(paneRoot, candidate),
    stat: async uri => await vscode.workspace.fs.stat(uri),
    directoryType: vscode.FileType.Directory,
    onError: error => { void vscode.window.showErrorMessage(vscode.l10n.t('Invalid pane link: {0}', String(error))); },
  });
  context.subscriptions.push(cascadeController);

  const nodeInfo = (node: unknown): NodeInfo | undefined => {
    if (node instanceof SpaceRootNode) return { paneId: node.paneId, uri: node.uri, isDirectory: true, definition: node.definition };
    if (node instanceof SpaceEntryNode) return { paneId: node.paneId, uri: node.uri, isDirectory: node.isDirectory, definition: node.space };
    return undefined;
  };

  const requireTrust = (): boolean => {
    if (canModifyFiles(vscode.workspace.isTrusted)) return true;
    void vscode.window.showWarningMessage(vscode.l10n.t('Trust the workspace before modifying files.'));
    return false;
  };
  const operationError = (error: unknown): void => {
    log.error(`File operation failed: ${String(error)}`);
    void vscode.window.showErrorMessage(vscode.l10n.t('File operation failed: {0}', String(error)));
  };

  // --- pane runtimes ------------------------------------------------------

  const paneDefinitionFor = (paneId: string): SpaceDefinition | null => resolvePaneDefinition(viewState.get(paneId), store.getDefinitions());

  const applyPaneScope = (paneId: string): void => {
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    const pane = viewState.get(paneId);
    const definition = paneDefinitionFor(paneId);
    runtime.scope = pane.root ? { paneId, root: pane.root } : undefined;
    runtime.provider.setScope(definition ? { paneId, definition } : undefined);
    const rootName = pane.root ? path.basename(pane.root) : '';
    runtime.treeView.title = paneRuntime.size === 1 && rootName ? rootName : `Folder Spaces ${paneIndexOf(paneId)}`;
    runtime.treeView.description = pane.root ?? '';
  };

  const createPaneDragAndDrop = (paneId: string) => createTreeDragAndDropController(paneId, {
    // 拖放內部／外部判斷以目前所有 pane 的 root 為界（D67/D68：pane 即獨立空間）。
    getDefinitions: () => [...paneRuntime.values()].flatMap(runtime => runtime.provider.scope ? [runtime.provider.scope.definition] : []),
    undoStack,
    requireTrust: () => requireTrust(),
    clearDrillStateForMovedSources: sources => clearDrillStateForMovedSources(sources),
    onChanged: () => { for (const runtime of paneRuntime.values()) runtime.provider.refresh(); rebuildWatchers(); },
    onError: error => operationError(error),
  });

  const createPane = (paneId: string): PaneRuntime => {
    const provider = new SpaceTreeDataProvider(store, viewState);
    const treeView = vscode.window.createTreeView(`codeFolderSpaces.${paneId}`, {
      treeDataProvider: provider,
      showCollapseAll: true,
      dragAndDropController: createPaneDragAndDrop(paneId),
    });
    const runtime: PaneRuntime = { id: paneId, provider, treeView, disposables: [] };
    runtime.disposables.push(
      provider,
      treeView,
      provider.onDidChangeTreeData(() => {
        if (!runtime.staleRoot) treeView.message = provider.filterMessage;
      }),
    );
    // active-file follow 沿用既有行為：只跟 pane1（可見性條件需要 pane1 的 TreeView）。
    if (paneId === 'pane1') runtime.disposables.push(treeView.onDidChangeVisibility(scheduleFollow));
    context.subscriptions.push(new vscode.Disposable(() => { for (const disposable of runtime.disposables) disposable.dispose(); }));
    paneRuntime.set(paneId, runtime);
    return runtime;
  };

  const disposePane = (paneId: string): void => {
    cascadeDisposables.get(paneId)?.dispose();
    cascadeDisposables.delete(paneId);
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    for (const disposable of runtime.disposables.reverse()) disposable.dispose();
    paneRuntime.delete(paneId);
  };

  const attachPaneCascade = (runtime: PaneRuntime): void => {
    if (cascadeDisposables.has(runtime.id)) return;
    const disposable = cascadeController.attach(runtime.id, listener => runtime.treeView.onDidChangeSelection(event => {
      const info = nodeInfo(event.selection[0]);
      listener(info ? { uri: info.uri, isDirectory: info.isDirectory } : undefined);
    }));
    cascadeDisposables.set(runtime.id, disposable);
  };

  const syncPaneViews = (): void => {
    const enabled = new Set(viewState.getEnabledPaneIds());
    for (const paneId of [...paneRuntime.keys()]) {
      if (!enabled.has(paneId)) disposePane(paneId);
    }
    for (const paneId of enabled) {
      if (!paneRuntime.has(paneId)) createPane(paneId);
    }
    for (const paneId of enabled) applyPaneScope(paneId);
    for (const runtime of paneRuntime.values()) attachPaneCascade(runtime);
    rebuildWatchers();
  };

  const syncPaneContexts = async (): Promise<void> => {
    const links = viewState.getPaneLinks();
    const enabled = viewState.getEnabledPaneIds();
    for (let index = 1; index <= MAX_PANE_INDEX; index++) {
      const id = `pane${index}`;
      const pane = links[id];
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.enabled`, Boolean(pane));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasRoot`, Boolean(pane?.root));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasParent`, Boolean(pane?.parentPaneId));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.follow`, Boolean(pane?.follow));
    }
    // D65/D71：上下限只看 pane 狀態，不再看 spaces 數量。
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canAddPane', enabled.length < MAX_PANE_INDEX);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canRemovePane', enabled.length > 1);
  };

  const reconcilePaneRoots = async (): Promise<void> => {
    for (const runtime of paneRuntime.values()) {
      const root = runtime.scope?.root;
      if (!root) {
        if (runtime.staleRoot) {
          runtime.staleRoot = undefined;
          runtime.treeView.message = '';
        }
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(root));
        if (!isPaneRootDirectory(stat.type, vscode.FileType.Directory)) throw new Error('not a directory');
        if (runtime.staleRoot) {
          runtime.staleRoot = undefined;
          runtime.treeView.message = '';
          runtime.provider.refresh();
        }
      } catch {
        runtime.treeView.message = vscode.l10n.t('Pane root is stale: {0}. Select a folder in its parent pane or reset the layout.', root);
        if (runtime.staleRoot !== root) void vscode.window.showWarningMessage(runtime.treeView.message);
        runtime.staleRoot = root;
      }
    }
  };

  const paneChanged = async (paneId: string): Promise<void> => {
    applyPaneScope(paneId);
    rebuildWatchers();
    await syncPaneContexts();
    await reconcilePaneRoots();
    await syncContext();
  };

  const repaintPane = (paneId: string): void => {
    paneRuntime.get(paneId)?.provider.refresh();
    void syncContext();
  };

  const repaintAllPanes = (): void => {
    for (const runtime of paneRuntime.values()) runtime.provider.refresh();
    void syncContext();
  };

  // --- watchers (D68: per pane root, deduplicated) ------------------------

  let watchers = new Map<string, vscode.FileSystemWatcher>();
  const rebuildWatchers = (): void => {
    const desired = new Map<string, string>();
    for (const runtime of paneRuntime.values()) {
      const root = runtime.scope?.root;
      if (root) desired.set(normalizeSpaceKey(root), root);
    }
    for (const [key, watcher] of watchers) {
      if (!desired.has(key)) {
        watcher.dispose();
        watchers.delete(key);
      }
    }
    for (const [key, root] of desired) {
      if (watchers.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidDelete(scheduleRefresh);
      watcher.onDidChange(scheduleRefresh);
      watchers.set(key, watcher);
    }
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    for (const watcher of watchers.values()) watcher.dispose();
    watchers = new Map();
  }));

  // --- follow active file (與鏈結 follow 是不同概念，維持既有行為) ----------

  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let followGeneration = 0;
  const pane1 = (): PaneRuntime | undefined => paneRuntime.get('pane1');

  const followActiveFile = async (generation: number, uri: vscode.Uri | undefined): Promise<void> => {
    const runtime = pane1();
    const canFollow = (): boolean => shouldFollowActiveFile({
      enabled: settings().get<boolean>('followActiveFile', false),
      generation,
      currentGeneration: followGeneration,
      visible: runtime?.treeView.visible ?? false,
    });
    if (!uri || !runtime || !canFollow()) return;
    const node = await runtime.provider.findNodeByPath(uri.fsPath);
    if (!canFollow() || !sameUri(uri, getActiveTabUri())) return;
    if (node) await runtime.treeView.reveal(node, { select: true, focus: false, expand: true });
  };
  const scheduleFollow = (): void => {
    followGeneration++;
    if (followTimer) clearTimeout(followTimer);
    if (!settings().get<boolean>('followActiveFile', false)) return;
    const generation = followGeneration;
    followTimer = setTimeout(() => {
      followTimer = undefined;
      void followActiveFile(generation, getActiveTabUri());
    }, FOLLOW_DEBOUNCE_MS);
  };
  const followConfiguration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codeFolderSpaces.followActiveFile')) {
      void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', settings().get<boolean>('followActiveFile', false));
      scheduleFollow();
    }
  });
  context.subscriptions.push(
    followConfiguration,
    vscode.window.tabGroups.onDidChangeTabs(scheduleFollow),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleFollow),
    vscode.window.onDidChangeVisibleTextEditors(scheduleFollow),
    new vscode.Disposable(() => { if (followTimer) clearTimeout(followTimer); followGeneration++; })
  );
  void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', settings().get<boolean>('followActiveFile', false));

  // --- refresh debounce ----------------------------------------------------

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      for (const runtime of paneRuntime.values()) {
        runtime.provider.refresh();
        if (!runtime.staleRoot) runtime.treeView.message = runtime.provider.filterMessage;
      }
      void reconcilePaneRoots();
      scheduleFollow();
    }, REFRESH_DEBOUNCE_MS);
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
  }));

  // --- context keys（pane1 的 view/title 按鈕狀態） -------------------------

  const syncContext = async (): Promise<void> => {
    const definitions = store.getDefinitions();
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasSpaces', definitions.length > 0);
    const pane = viewState.get('pane1');
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', Boolean(pane.filter));
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canDrillUp', pane.drillStack.length > 0);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.preset', pane.preset);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', VIEW_PRESETS[pane.preset]?.mode ?? 'tree');
  };

  // --- file operations ------------------------------------------------------

  const getEntry = (node: unknown): { paneId: string; uri: vscode.Uri; isDirectory: boolean; basePath: string } | undefined => {
    const info = nodeInfo(node);
    return info && { paneId: info.paneId, uri: info.uri, isDirectory: info.isDirectory, basePath: info.definition.basePath };
  };
  const exists = async (uri: vscode.Uri): Promise<boolean> => { try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; } };
  const clearDrillStateForMovedSources = async (sources: vscode.Uri[]): Promise<void> => {
    const sourcePaths = sources.map(source => path.resolve(source.fsPath));
    for (const paneId of viewState.getEnabledPaneIds()) {
      const pane = viewState.get(paneId);
      const paths = [pane.root, ...pane.drillStack.map(snapshot => snapshot.root)].filter((value): value is string => Boolean(value)).map(value => path.resolve(value));
      if (hasDrillStateWithinMovedSources(paths, sourcePaths)) {
        await viewState.resetRoot(paneId);
        applyPaneScope(paneId);
      }
    }
  };
  const selectionTarget = (node?: unknown): unknown => node ?? pane1()?.treeView.selection[0];
  const pasteEntries = async (node?: unknown): Promise<void> => {
    const payload = clipboard.get();
    const target = selectionTarget(node);
    const destinationEntry = getEntry(target);
    if (!payload || !destinationEntry) return;
    const destinationPath = resolvePasteTarget({ path: destinationEntry.uri.fsPath, isDirectory: destinationEntry.isDirectory, isRoot: target instanceof SpaceRootNode });
    // D67：允許根＝該 pane 自己的 root。
    if (!destinationPath || !isAllowedSpaceRoot(destinationEntry.basePath, destinationPath)) return;
    const destination = vscode.Uri.file(destinationPath);
    try {
      const destinationStat = await vscode.workspace.fs.stat(destination);
      if (!(destinationStat.type & vscode.FileType.Directory)) return;
      if (!requireTrust()) return;
      for (const sourcePath of payload.uris) {
        const source = vscode.Uri.parse(sourcePath);
        if (source.scheme !== destination.scheme || source.authority !== destination.authority) { void vscode.window.showErrorMessage(vscode.l10n.t('Cannot paste between different file system providers.')); continue; }
        const stat = await vscode.workspace.fs.stat(source);
        const target = vscode.Uri.joinPath(destination, path.basename(source.fsPath));
        if (!isSafeMove(source.fsPath, target.fsPath, Boolean(stat.type & vscode.FileType.Directory))) { void vscode.window.showErrorMessage(vscode.l10n.t('A folder cannot be pasted into itself or one of its subfolders.')); continue; }
        if (isSamePath(source.fsPath, target.fsPath)) continue;
        if (await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); continue; }
        if (payload.mode === 'cut') {
          await vscode.workspace.fs.rename(source, target, { overwrite: false });
          undoStack.push({ kind: 'move', from: source.fsPath, to: target.fsPath });
          clipboard.consume(sourcePath);
          await clearDrillStateForMovedSources([source]);
        } else {
          await copyTreeEntry(source, target);
        }
      }
      repaintAllPanes();
      rebuildWatchers();
    } catch (error) { operationError(error); }
  };
  const createEntry = async (node: unknown, directory: boolean): Promise<void> => {
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    const destination = entry.isDirectory ? entry.uri : vscode.Uri.file(path.dirname(entry.uri.fsPath));
    const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t(directory ? 'Enter folder name' : 'Enter file name') });
    if (name === undefined) return;
    if (!isValidEntryName(name)) { void vscode.window.showErrorMessage(vscode.l10n.t('Enter a valid single file or folder name.')); return; }
    const target = vscode.Uri.joinPath(destination, name);
    if (!isAllowedSpaceRoot(entry.basePath, target.fsPath)) { void vscode.window.showErrorMessage(vscode.l10n.t('The destination is outside the folder space.')); return; }
    try {
      if (await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); return; }
      if (directory) await vscode.workspace.fs.createDirectory(target);
      else await vscode.workspace.fs.writeFile(target, new Uint8Array());
      repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };
  const renameEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject pane roots as defense in depth.
    if (node instanceof SpaceRootNode) return;
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter a new name'), value: path.basename(entry.uri.fsPath) });
    if (name === undefined) return;
    if (!isValidEntryName(name)) { void vscode.window.showErrorMessage(vscode.l10n.t('Enter a valid single file or folder name.')); return; }
    const target = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(entry.uri.fsPath)), name);
    if (!isAllowedSpaceRoot(entry.basePath, target.fsPath)) { void vscode.window.showErrorMessage(vscode.l10n.t('The destination is outside the folder space.')); return; }
    try {
      await vscode.workspace.fs.stat(entry.uri);
      if (!isSamePath(entry.uri.fsPath, target.fsPath) && await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); return; }
      await vscode.workspace.fs.rename(entry.uri, target, { overwrite: false });
      undoStack.push({ kind: 'rename', from: entry.uri.fsPath, to: target.fsPath }); repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };
  const moveEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject pane roots as defense in depth.
    if (node instanceof SpaceRootNode) return;
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    const folders: Array<vscode.QuickPickItem & { uri: vscode.Uri }> = [];
    const pending = [vscode.Uri.file(entry.basePath)];
    try {
      while (pending.length) {
        const folder = pending.pop()!;
        const stat = await vscode.workspace.fs.stat(folder);
        if (!(stat.type & vscode.FileType.Directory)) continue;
        folders.push({ label: folder.fsPath === entry.basePath ? path.basename(entry.basePath) : path.relative(entry.basePath, folder.fsPath), description: folder.fsPath, uri: folder });
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
          if (type & vscode.FileType.Directory) pending.push(vscode.Uri.joinPath(folder, name));
        }
      }
    } catch (error) { operationError(error); return; }
    const selected = await vscode.window.showQuickPick(folders, { placeHolder: vscode.l10n.t('Choose a destination folder within this space') });
    if (!selected) return;
    if (!isSafeMove(entry.uri.fsPath, selected.uri.fsPath, entry.isDirectory)) {
      void vscode.window.showErrorMessage(vscode.l10n.t('A folder cannot be moved into itself or one of its subfolders.')); return;
    }
    const target = vscode.Uri.joinPath(selected.uri, path.basename(entry.uri.fsPath));
    if (await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); return; }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Moving {0}', path.basename(entry.uri.fsPath)), cancellable: false }, async () => {
        await vscode.workspace.fs.stat(entry.uri);
        await vscode.workspace.fs.rename(entry.uri, target, { overwrite: false });
      });
      undoStack.push({ kind: 'move', from: entry.uri.fsPath, to: target.fsPath }); repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };
  const deleteEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject pane roots as defense in depth.
    if (node instanceof SpaceRootNode) return;
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    try {
      await vscode.workspace.fs.stat(entry.uri);
      const confirmDelete = vscode.workspace.getConfiguration('explorer').get<boolean>('confirmDelete', true);
      if (confirmDelete) {
        const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Delete "{0}"?', path.basename(entry.uri.fsPath)), { modal: true }, vscode.l10n.t('Delete'));
        if (answer !== vscode.l10n.t('Delete')) return;
      }
      const useTrash = vscode.workspace.getConfiguration('files').get<boolean>('enableTrash', true);
      if (useTrash && entry.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage(vscode.l10n.t('This file system provider does not expose trash support; the item was not deleted.'));
        return;
      }
      await vscode.workspace.fs.delete(entry.uri, { recursive: entry.isDirectory, useTrash });
      repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };

  // --- pane-scoped view actions（供 paneN.menu 與 pane1 命令共用） ----------

  const rootOf = (paneId: string): string | null => paneRuntime.get(paneId)?.scope?.root ?? viewState.get(paneId).root;

  const pickPaneRoot = async (): Promise<string | undefined> => {
    type RootItem = vscode.QuickPickItem & { rootPath?: string; browse?: boolean };
    const items: RootItem[] = store.getDefinitions().map(space => ({ label: space.name, description: space.basePath, rootPath: space.basePath }));
    items.push({ label: vscode.l10n.t('Browse for folder…'), browse: true });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a pane root') });
    if (!picked) return undefined;
    if (picked.rootPath) return picked.rootPath;
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t('Choose a pane root'),
    });
    return folder?.[0]?.fsPath;
  };

  const browsePaneRoot = async (paneId: string): Promise<string | undefined> => {
    const current = rootOf(paneId);
    if (!current) return pickPaneRoot();
    const items: Array<vscode.QuickPickItem & { rootPath: string }> = store.getDefinitions()
      .filter(space => !isSamePath(space.basePath, current))
      .map(space => ({ label: space.name, description: space.basePath, rootPath: space.basePath }));
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(current))) {
        if (type & vscode.FileType.Directory) items.push({ label: name, description: path.join(current, name), rootPath: path.join(current, name) });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not read folders: {0}', String(error)));
      return undefined;
    }
    items.push({ label: vscode.l10n.t('Browse for folder…'), rootPath: current });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a pane root') });
    if (!picked) return undefined;
    if (picked.rootPath === current) return pickPaneRoot();
    let stat: vscode.FileStat | undefined;
    try { stat = await vscode.workspace.fs.stat(vscode.Uri.file(picked.rootPath)); } catch { /* missing paths are rejected below */ }
    if (!stat) {
      void vscode.window.showErrorMessage(vscode.l10n.t('The selected folder does not exist.'));
      return undefined;
    }
    if (!(stat.type & vscode.FileType.Directory)) {
      void vscode.window.showErrorMessage(vscode.l10n.t('The selected path is not a folder.'));
      return undefined;
    }
    return picked.rootPath;
  };

  const setPresetForPane = async (paneId: string, preset?: unknown): Promise<void> => {
    let selected = preset;
    if (!isViewPresetName(selected)) {
      selected = await vscode.window.showQuickPick(Object.keys(VIEW_PRESETS), { placeHolder: vscode.l10n.t('Choose a view preset') });
    }
    if (!isViewPresetName(selected)) return;
    await viewState.setPreset(paneId, selected);
    repaintPane(paneId);
    await syncContext();
  };

  const setSortForPane = async (paneId: string, key?: unknown, direction?: unknown): Promise<void> => {
    const options = ['name', 'mtime', 'ctime'];
    const selectedKey = options.includes(String(key)) ? String(key) : await vscode.window.showQuickPick(options, { placeHolder: vscode.l10n.t('Choose sort field') });
    if (!selectedKey) return;
    const selectedDirection = direction === 'desc' || direction === 'asc' ? direction : await vscode.window.showQuickPick(['asc', 'desc'], { placeHolder: vscode.l10n.t('Choose sort direction') });
    if (selectedDirection !== 'asc' && selectedDirection !== 'desc') return;
    await viewState.setSort(paneId, selectedKey as 'name' | 'mtime' | 'ctime', selectedDirection);
    repaintPane(paneId);
  };

  const filterForPane = async (paneId: string): Promise<void> => {
    const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Filter by path substring'), value: viewState.get(paneId).filter });
    if (value === undefined) return;
    await viewState.setFilter(paneId, value.trim());
    repaintPane(paneId);
    await syncContext();
    const runtime = paneRuntime.get(paneId);
    if (runtime) runtime.treeView.message = '';
  };

  const toggleModeForPane = async (paneId: string): Promise<void> => {
    const current = viewState.get(paneId).preset;
    const currentSettings = VIEW_PRESETS[current];
    const next = Object.entries(VIEW_PRESETS).find(([, value]) => value.mode !== currentSettings.mode && value.content === currentSettings.content && value.level === currentSettings.level)?.[0]
      ?? (currentSettings.mode === 'tree' ? 'Contents' : DEFAULT_VIEW_PRESET);
    await viewState.setPreset(paneId, next as keyof typeof VIEW_PRESETS);
    repaintPane(paneId);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', VIEW_PRESETS[next as keyof typeof VIEW_PRESETS].mode);
  };

  const drillUpForPane = async (paneId: string): Promise<void> => {
    if (!await viewState.drillUp(paneId)) return;
    await paneChanged(paneId);
  };

  const switchRootForPane = async (paneId: string): Promise<void> => {
    const chosen = await browsePaneRoot(paneId);
    if (!chosen) return;
    await viewState.switchRoot(paneId, chosen);
    await paneChanged(paneId);
  };

  const setRootForPane = async (paneId: string): Promise<void> => {
    const chosen = await pickPaneRoot();
    if (!chosen) return;
    // D61：手動換根不關閉 follow（暫時覆寫，父焦點事件仍是最終權威）。
    await viewState.switchRoot(paneId, chosen);
    await paneChanged(paneId);
  };

  const setFollowForPane = async (paneId: string, follow: boolean): Promise<void> => {
    const pane = viewState.get(paneId);
    if (!pane.parentPaneId || pane.follow === follow) return;
    await viewState.setPaneParent(paneId, pane.parentPaneId, follow);
    await syncPaneContexts();
  };

  const toggleFollowForPane = async (paneId: string): Promise<void> => {
    const pane = viewState.get(paneId);
    if (!pane.parentPaneId) return;
    await viewState.setPaneParent(paneId, pane.parentPaneId, !pane.follow);
    await syncPaneContexts();
  };

  const expandLevelForPane = async (paneId: string): Promise<void> => {
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    const selection = runtime.treeView.selection[0];
    const info = nodeInfo(selection);
    const parents = selection && info?.isDirectory ? [selection as SpaceRootNode | SpaceEntryNode] : await runtime.provider.getChildren();
    for (const parent of parents) {
      for (const child of await runtime.provider.getChildren(parent)) {
        if (child.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
          await runtime.treeView.reveal(child, { select: false, focus: false, expand: true });
        }
      }
    }
  };

  const revealActiveFileForPane = async (paneId: string): Promise<void> => {
    const runtime = paneRuntime.get(paneId);
    const uri = getActiveTabUri();
    if (!runtime || !uri) return;
    const node = await runtime.provider.findNodeByPath(uri.fsPath);
    if (node) await runtime.treeView.reveal(node, { select: true, focus: false, expand: true });
  };

  /** 「在此開子 pane」（D62/D64）：插槽取最低編號空閒且大於來源編號，維持 parentIndex < childIndex。 */
  const addChildPane = async (node: unknown): Promise<void> => {
    const info = nodeInfo(node);
    if (!info?.isDirectory) return;
    const sourcePane = viewState.get(info.paneId);
    const childId = viewState.allocatePaneId(paneIndexOf(info.paneId) + 1);
    if (!childId) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Folder Spaces supports at most 8 panes.'));
      return;
    }
    try {
      await viewState.enablePane(childId, {
        root: info.uri.fsPath,
        parentPaneId: info.paneId,
        follow: true,
        showFiles: sourcePane.showFiles,
        include: [...sourcePane.include],
        exclude: [...sourcePane.exclude],
      });
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Invalid pane link: {0}', String(error)));
      return;
    }
    syncPaneViews();
    await syncPaneContexts();
    await reconcilePaneRoots();
  };

  /** 關閉 pane（D71：pane1 不可關閉；子 pane 重掛到被關閉 pane 的父）。 */
  const closePane = async (paneId?: string): Promise<void> => {
    const enabled = viewState.getEnabledPaneIds();
    const target = paneId ?? enabled[enabled.length - 1];
    if (!target || target === 'pane1' || enabled.length <= 1 || !enabled.includes(target)) return;
    await viewState.disablePane(target);
    syncPaneViews();
    await syncPaneContexts();
    await reconcilePaneRoots();
  };

  const addPane = async (): Promise<void> => {
    const paneId = viewState.allocatePaneId();
    if (!paneId) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Folder Spaces supports at most 8 panes.'));
      return;
    }
    const root = await pickPaneRoot();
    if (!root) return;
    const source = viewState.get('pane1');
    // D64：頂層新 pane 的顯示設定繼承 pane1。
    await viewState.enablePane(paneId, {
      root,
      showFiles: source.showFiles,
      include: [...source.include],
      exclude: [...source.exclude],
    });
    syncPaneViews();
    await syncPaneContexts();
    await reconcilePaneRoots();
  };

  const paneMenu = async (paneId: string): Promise<void> => {
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    const actions = [
      'Preset', 'Mode', 'Level', 'Content', 'Filter', 'Clear filter', 'Sort',
      'Drill up', 'Switch root', 'Set root', 'Add child pane', 'Close pane',
      'Expand level', 'Reveal active file', 'Refresh',
      'New file', 'New folder', 'Rename', 'Delete', 'Copy', 'Cut', 'Paste',
      'Undo', 'Reveal in Explorer', 'Reveal in OS', 'Toggle follow',
    ];
    const action = await vscode.window.showQuickPick(actions, { placeHolder: vscode.l10n.t('Choose a pane action') });
    if (!action) return;
    const target = runtime.treeView.selection[0];
    const refresh = (): void => repaintPane(paneId);
    if (action === 'Refresh') { refresh(); return; }
    if (action === 'Toggle follow') { await toggleFollowForPane(paneId); return; }
    if (action === 'Set root') { await setRootForPane(paneId); return; }
    if (action === 'Add child pane') { await addChildPane(target ?? (runtime.provider.scope ? new SpaceRootNode(runtime.provider.scope.definition, paneId) : undefined)); return; }
    if (action === 'Close pane') { await closePane(paneId); return; }
    if (action === 'Reveal in Explorer' || action === 'Reveal in OS') {
      const uri = selectedUri(target); if (uri) await vscode.commands.executeCommand(action === 'Reveal in Explorer' ? 'revealInExplorer' : 'revealFileInOS', uri); return;
    }
    if (action === 'Copy' || action === 'Cut') { const entry = getEntry(target); if (entry && !(target instanceof SpaceRootNode)) clipboard.set([entry.uri.toString()], action === 'Copy' ? 'copy' : 'cut'); return; }
    if (action === 'Paste') { await pasteEntries(target); refresh(); return; }
    if (action === 'New file' || action === 'New folder') { await createEntry(target ?? (await runtime.provider.getChildren())[0], action === 'New folder'); refresh(); return; }
    if (action === 'Rename') { await renameEntry(target); refresh(); return; }
    if (action === 'Delete') { await deleteEntry(target); refresh(); return; }
    if (action === 'Undo') { await vscode.commands.executeCommand('codeFolderSpaces.undoFileOperation'); refresh(); return; }
    if (action === 'Preset') { await setPresetForPane(paneId); return; }
    if (action === 'Mode') { await toggleModeForPane(paneId); return; }
    if (action === 'Level' || action === 'Content') {
      const state = viewState.get(paneId);
      const candidates = Object.entries(VIEW_PRESETS).filter(([, preset]) => action === 'Level' ? preset.level !== VIEW_PRESETS[state.preset].level : preset.content !== VIEW_PRESETS[state.preset].content);
      const selected = await vscode.window.showQuickPick(candidates.map(([name]) => name));
      if (isViewPresetName(selected)) { await viewState.setPreset(paneId, selected); refresh(); }
      return;
    }
    if (action === 'Filter') { await filterForPane(paneId); return; }
    if (action === 'Clear filter') { await viewState.clearFilter(paneId); refresh(); return; }
    if (action === 'Sort') { await setSortForPane(paneId); return; }
    if (action === 'Drill up') { await drillUpForPane(paneId); return; }
    if (action === 'Switch root') { await switchRootForPane(paneId); return; }
    if (action === 'Expand level') { await expandLevelForPane(paneId); return; }
    if (action === 'Reveal active file') { await revealActiveFileForPane(paneId); return; }
  };

  const selectedUri = (node: unknown): vscode.Uri | undefined => nodeInfo(node)?.uri;
  const targetPaneId = (node?: unknown): string => nodeInfo(node)?.paneId ?? 'pane1';

  // --- wiring ---------------------------------------------------------------

  store.onDidChange(
    () => {
      // D70：spaces 設定變更不回寫既有 pane，只刷新 pane 定義解析與视图。
      for (const paneId of paneRuntime.keys()) applyPaneScope(paneId);
      void syncContext();
    },
    undefined,
    context.subscriptions
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      // F-42：explorer.fileNesting.* 是嵌套設定的唯一來源（D53），變更時刷新所有 pane。
      if (event.affectsConfiguration('explorer.fileNesting')) scheduleRefresh();
    }),
    vscode.workspace.onDidRenameFiles(async event => {
      for (const file of event.files) {
        // pane 為單位改寫 root 與 drillStack（S4R6：更名處理改以 pane 為界）。
        await viewState.rewriteRoots(file.oldUri.fsPath, file.newUri.fsPath);
        for (const definition of store.getDefinitions()) {
          const impact = classifySpaceRename([definition.basePath], file.oldUri.fsPath);
          if (impact.kind === 'space-root') {
            const message = vscode.l10n.t('Space path is stale: {0}. Update the space path to restore it.', file.oldUri.fsPath);
            const action = vscode.l10n.t('Update space path');
            void vscode.window.showInformationMessage(message, action).then(async selected => {
              if (selected !== action) return;
              try {
                await store.updateSpacePath(file.oldUri.fsPath, file.newUri.fsPath);
                for (const paneId of paneRuntime.keys()) applyPaneScope(paneId);
              } catch (error) {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not update space path: {0}', String(error)));
              }
            });
          }
        }
      }
      for (const paneId of paneRuntime.keys()) applyPaneScope(paneId);
      rebuildWatchers();
      await reconcilePaneRoots();
      await syncPaneContexts();
    })
  );

  syncPaneViews();
  await syncPaneContexts();
  await reconcilePaneRoots();
  await syncContext();

  // --- commands --------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('codeFolderSpaces.revealInExplorer', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('revealInExplorer', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.revealFileInOS', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('revealFileInOS', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.copyFilePath', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('copyFilePath', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.copyRelativeFilePath', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('copyRelativeFilePath', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.openInTerminal', async (node?: unknown) => { const uri = selectedUri(node); if (uri) await vscode.commands.executeCommand('openInIntegratedTerminal', { cwd: uri.fsPath }); }),
    vscode.commands.registerCommand('codeFolderSpaces.findInFolder', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('filesExplorer.findInFolder', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.openEntry', async (node?: unknown) => {
      const uri = node instanceof vscode.Uri ? node : selectedUri(node);
      if (!uri) return;
      const beside = resolveOpenBeside(settings().get<string>('openFilesIn', 'current'));
      await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active });
    }),
    vscode.commands.registerCommand('codeFolderSpaces.copyEntry', (node?: unknown) => { const targetNode = selectionTarget(node); const entry = getEntry(targetNode); if (entry && !(targetNode instanceof SpaceRootNode)) clipboard.set([entry.uri.toString()], 'copy'); }),
    vscode.commands.registerCommand('codeFolderSpaces.cutEntry', (node?: unknown) => { const targetNode = selectionTarget(node); const entry = getEntry(targetNode); if (entry && !(targetNode instanceof SpaceRootNode)) clipboard.set([entry.uri.toString()], 'cut'); }),
    vscode.commands.registerCommand('codeFolderSpaces.pasteEntries', (node?: unknown) => pasteEntries(node)),
    vscode.commands.registerCommand('codeFolderSpaces.newFile', (node?: unknown) => createEntry(selectionTarget(node), false)),
    vscode.commands.registerCommand('codeFolderSpaces.newFolder', (node?: unknown) => createEntry(selectionTarget(node), true)),
    vscode.commands.registerCommand('codeFolderSpaces.renameEntry', (node?: unknown) => renameEntry(selectionTarget(node))),
    vscode.commands.registerCommand('codeFolderSpaces.moveTo', (node?: unknown) => moveEntry(node)),
    vscode.commands.registerCommand('codeFolderSpaces.deleteEntry', (node?: unknown) => deleteEntry(selectionTarget(node))),
    vscode.commands.registerCommand('codeFolderSpaces.undoFileOperation', async () => {
      if (!requireTrust()) return;
      const entry = undoStack.peek();
      if (!entry) { void vscode.window.showInformationMessage(vscode.l10n.t('There is no file operation to undo.')); return; }
      const source = vscode.Uri.file(entry.from); const target = vscode.Uri.file(entry.to);
      try {
        await vscode.workspace.fs.stat(target);
        try { await vscode.workspace.fs.stat(source); void vscode.window.showErrorMessage(vscode.l10n.t('Cannot undo: the original path already exists: {0}', entry.from)); return; } catch { /* source is available */ }
        await vscode.workspace.fs.rename(target, source, { overwrite: false });
        undoStack.pop(); repaintAllPanes();
      } catch (error) { operationError(error); }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.refresh', () => repaintAllPanes()),
    vscode.commands.registerCommand('codeFolderSpaces.pane.add', () => addPane()),
    vscode.commands.registerCommand('codeFolderSpaces.pane.remove', (paneId?: unknown) => closePane(typeof paneId === 'string' ? paneId : undefined)),
    vscode.commands.registerCommand('codeFolderSpaces.pane.addChild', (node?: unknown) => addChildPane(node ?? pane1()?.treeView.selection[0])),
    vscode.commands.registerCommand('codeFolderSpaces.pane.setRoot', (node?: unknown) => setRootForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.pane.resetLayout', async () => {
      await viewState.resetToDefaults(paneInitContext());
      syncPaneViews();
      await syncPaneContexts();
      await reconcilePaneRoots();
    }),
    ...Array.from({ length: MAX_PANE_INDEX }, (_, index) => {
      const id = `pane${index + 1}`;
      return [
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.toggleFollow`, () => toggleFollowForPane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.menu`, () => paneMenu(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.followOn`, () => setFollowForPane(id, false)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.followOff`, () => setFollowForPane(id, true)),
      ];
    }).flat(),
    vscode.commands.registerCommand('codeFolderSpaces.drillDown', async (node?: unknown) => {
      const info = nodeInfo(node ?? pane1()?.treeView.selection[0]);
      if (!info?.isDirectory || !info.paneId) return;
      // D67：下鑽以該 pane 自己的 root 為界（節點本質上在 pane root 內）。
      if (!isAllowedSpaceRoot(info.definition.basePath, info.uri.fsPath)) return;
      await viewState.drillDown(info.paneId, info.uri.fsPath);
      await paneChanged(info.paneId);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.drillUp', (node?: unknown) => drillUpForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.switchRoot', (node?: unknown) => switchRootForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.renameSpace', async (node?: unknown) => {
      const runtime = pane1();
      const target = node instanceof SpaceRootNode ? node : runtime?.treeView.selection.find((item): item is SpaceRootNode => item instanceof SpaceRootNode);
      if (!runtime || !target) return;
      const proposed = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter a new space name'), value: target.definition.name });
      if (proposed === undefined) return;
      const name = validateSpaceName(target.definition.name, proposed);
      if (!name) return;
      try {
        // 只有 pane root 恰好是已配置 space 時才可改名；否則拒絕以免誤改其他 space。
        if (!(await store.renameSpace(target.definition.basePath, name))) return;
        void vscode.window.showInformationMessage(vscode.l10n.t('Renamed space to: {0}', name));
        applyPaneScope(target.paneId);
      } catch (error) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not rename space: {0}', String(error)));
      }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.setPreset', (preset?: unknown) => setPresetForPane('pane1', preset)),
    vscode.commands.registerCommand('codeFolderSpaces.filter', () => filterForPane('pane1')),
    vscode.commands.registerCommand('codeFolderSpaces.clearFilter', async () => {
      await viewState.clearFilter('pane1');
      repaintPane('pane1');
      const runtime = pane1();
      if (runtime) runtime.treeView.message = '';
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', false);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.setSort', (key?: unknown, direction?: unknown) => setSortForPane('pane1', key, direction)),
    vscode.commands.registerCommand('codeFolderSpaces.toggleMode', () => toggleModeForPane('pane1')),
    vscode.commands.registerCommand('codeFolderSpaces.addSpace', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Select a folder to add as a folder space'),
      });
      const uri = picked?.[0];
      if (!uri) {
        return;
      }
      const added = await store.addSpace(uri.fsPath);
      if (added) {
        log.info(`Added folder space: ${uri.fsPath}`);
        void vscode.window.showInformationMessage(vscode.l10n.t('Added folder space: {0}', uri.fsPath));
      }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.removeSpace', async (node?: unknown) => {
      const runtime = pane1();
      const target = node instanceof SpaceRootNode ? node : runtime?.treeView.selection.find((item): item is SpaceRootNode => item instanceof SpaceRootNode);
      if (!runtime || !target) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t('Remove folder space "{0}"?', target.definition.name),
        { modal: true },
        vscode.l10n.t('Remove')
      );
      if (confirmed !== vscode.l10n.t('Remove')) {
        return;
      }
      await store.removeSpace(target.definition.basePath);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.toggleFollowActiveFile', async () => {
      const config = settings();
      const enabled = !config.get<boolean>('followActiveFile', false);
      await config.update('followActiveFile', enabled, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', enabled);
      scheduleFollow();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.expandLevel', () => expandLevelForPane('pane1')),
    vscode.commands.registerCommand('codeFolderSpaces.revealActiveFile', async () => {
      const uri = getActiveTabUri();
      const runtime = pane1();
      if (!uri || !runtime) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No active file to reveal.'));
        return;
      }
      const node = await runtime.provider.findNodeByPath(uri.fsPath);
      if (!node) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No folder space contains the active file: {0}', uri.fsPath)
        );
        return;
      }
      await runtime.treeView.reveal(node, { select: true, focus: true, expand: true });
    })
  );

  scheduleFollow();
  log.info('Folder Spaces activated');

  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  return {
    version,
    getSpaces: () => store.getDefinitions().map((definition) => ({ name: definition.name, basePath: definition.basePath })),
  };
}

function getActiveTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return resolveActiveTabUri({ kind: 'text', uri: input.uri });
  if (input instanceof vscode.TabInputCustom) return resolveActiveTabUri({ kind: 'custom', uri: input.uri });
  if (input instanceof vscode.TabInputNotebook) return resolveActiveTabUri({ kind: 'notebook', uri: input.uri });
  if (input instanceof vscode.TabInputTextDiff) return resolveActiveTabUri({ kind: 'text-diff', modified: input.modified });
  if (input instanceof vscode.TabInputNotebookDiff) return resolveActiveTabUri({ kind: 'notebook-diff', modified: input.modified });
  return undefined;
}

function sameUri(left: vscode.Uri, right: vscode.Uri | undefined): boolean {
  return Boolean(right && left.toString() === right.toString());
}

export function deactivate(): void {
  disposeLogChannel();
}
