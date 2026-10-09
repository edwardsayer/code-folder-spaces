import * as vscode from 'vscode';
import * as path from 'node:path';
import { SpaceRootNode, SpaceTreeDataProvider } from './spaces/spaceTreeDataProvider';
import { SpaceStore } from './spaces/spaceStore';
import { DEFAULT_VIEW_PRESET, VIEW_PRESETS, isViewPresetName } from './spaces/viewPresets';
import { classifySpaceRename, PaneStateStore } from './spaces/viewState';
import { canModifyFiles, isAllowedSpaceRoot, isSafeMove, isSamePath, isValidEntryName, isValidSpaceRoot, UndoStack, validateSpaceName } from './spaces/spaceActions';
import { disposeLogChannel, getLogChannel } from './util/log';
import { resolveActiveTabUri, shouldFollowActiveFile } from './spaces/followActiveFile';

const VIEW_ID = 'codeFolderSpaces.explorer';
const REFRESH_DEBOUNCE_MS = 200;
const FOLLOW_DEBOUNCE_MS = 250;

/** Public surface returned from `activate()` for other extensions. */
export interface FolderSpacesApi {
  readonly version: string;
  getSpaces(): Array<{ name: string; basePath: string }>;
}

export async function activate(context: vscode.ExtensionContext): Promise<FolderSpacesApi> {
  const log = getLogChannel();
  log.info('Activating Folder Spaces');

  const store = new SpaceStore();
  const viewState = new PaneStateStore(context.workspaceState);
  const provider = new SpaceTreeDataProvider(store, viewState);
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(store, provider, treeView);

  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let followGeneration = 0;
  const followActiveFile = async (generation: number, uri: vscode.Uri | undefined): Promise<void> => {
    const canFollow = (): boolean => shouldFollowActiveFile({
      enabled: vscode.workspace.getConfiguration('codeFolderSpaces').get<boolean>('followActiveFile', false),
      generation,
      currentGeneration: followGeneration,
      visible: treeView.visible,
    });
    if (!uri || !canFollow()) return;
    const node = await provider.findNodeByPath(uri.fsPath);
    if (!canFollow() || !sameUri(uri, getActiveTabUri())) return;
    if (node) await treeView.reveal(node, { select: true, focus: false, expand: true });
  };
  const scheduleFollow = (): void => {
    followGeneration++;
    if (followTimer) clearTimeout(followTimer);
    if (!vscode.workspace.getConfiguration('codeFolderSpaces').get<boolean>('followActiveFile', false)) return;
    const generation = followGeneration;
    followTimer = setTimeout(() => {
      followTimer = undefined;
      void followActiveFile(generation, getActiveTabUri());
    }, FOLLOW_DEBOUNCE_MS);
  };
  const followConfiguration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codeFolderSpaces.followActiveFile')) {
      void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', vscode.workspace.getConfiguration('codeFolderSpaces').get<boolean>('followActiveFile', false));
      scheduleFollow();
    }
  });
  context.subscriptions.push(
    followConfiguration,
    vscode.window.tabGroups.onDidChangeTabs(scheduleFollow),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleFollow),
    vscode.window.onDidChangeVisibleTextEditors(scheduleFollow),
    treeView.onDidChangeVisibility(scheduleFollow),
    new vscode.Disposable(() => { if (followTimer) clearTimeout(followTimer); followGeneration++; })
  );
  void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', vscode.workspace.getConfiguration('codeFolderSpaces').get<boolean>('followActiveFile', false));

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      provider.refresh();
      treeView.message = provider.filterMessage;
      scheduleFollow();
    }, REFRESH_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
    })
  );

  // One recursive watcher per configured space. Watchers follow the space root,
  // which may live outside the workspace.
  let watchers: vscode.FileSystemWatcher[] = [];
  const rebuildWatchers = (): void => {
    for (const watcher of watchers) {
      watcher.dispose();
    }
    watchers = [];
    for (const definition of store.getDefinitions()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(definition.basePath), '**/*')
      );
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidDelete(scheduleRefresh);
      watcher.onDidChange(scheduleRefresh);
      watchers.push(watcher);
    }
  };
  context.subscriptions.push(
    new vscode.Disposable(() => {
      for (const watcher of watchers) {
        watcher.dispose();
      }
      watchers = [];
    })
  );

  const syncContext = async (): Promise<void> => {
    const definitions = store.getDefinitions();
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasSpaces', definitions.length > 0);
    const selected = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
    const definition = selected instanceof SpaceRootNode ? selected.definition : selected && 'space' in selected ? selected.space : definitions[0];
    const state = definition ? viewState.get(definition.basePath) : undefined;
    const preset = state?.preset ?? DEFAULT_VIEW_PRESET;
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', Boolean(state?.filter));
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canDrillUp', Boolean(state?.drillStack?.length));
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.preset', preset);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', VIEW_PRESETS[preset].mode);
  };

  context.subscriptions.push(treeView.onDidChangeSelection(() => { void syncContext(); }));
  context.subscriptions.push(provider.onDidChangeTreeData(() => {
    const selected = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
    const definition = selected instanceof SpaceRootNode ? selected.definition : selected && 'space' in selected ? selected.space : store.getDefinitions()[0];
    if (definition) void provider.getChildren(new SpaceRootNode(definition, undefined)).then(() => {
      const stalePath = provider.staleRoots.values().next().value as string | undefined;
      treeView.message = stalePath ? vscode.l10n.t('Space path is stale: {0}. Update the space path to restore it.', stalePath) : provider.filterMessage;
    });
  }));
  store.onDidChange(
    () => {
      provider.refresh();
      rebuildWatchers();
      void syncContext();
    },
    undefined,
    context.subscriptions
  );
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async event => {
      for (const file of event.files) {
        for (const definition of store.getDefinitions()) {
          const impact = classifySpaceRename([definition.basePath], file.oldUri.fsPath);
          if (impact.kind === 'space-root') {
            await viewState.migrateRename(file.oldUri.fsPath, file.newUri.fsPath);
            provider.markStale(definition.basePath);
            treeView.message = vscode.l10n.t('Space path is stale: {0}. Update the space path to restore it.', file.oldUri.fsPath);
            const action = vscode.l10n.t('Update space path');
            void vscode.window.showInformationMessage(treeView.message, action).then(async selected => {
              if (selected !== action) return;
              try {
                await store.updateSpacePath(file.oldUri.fsPath, file.newUri.fsPath);
                provider.clearStale(definition.basePath);
                treeView.message = '';
                provider.refresh();
              } catch (error) {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not update space path: {0}', String(error)));
              }
            });
          } else if (impact.kind === 'inside-space') {
            await viewState.rewriteRename(definition.basePath, file.oldUri.fsPath, file.newUri.fsPath);
            provider.refresh();
          }
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
      rebuildWatchers();
      void syncContext();
    })
  );

  // Session-only history; undo records are intentionally cleared on extension reload and never persisted to mementos.
  const undoStack = new UndoStack();
  const selectedUri = (node: unknown): vscode.Uri | undefined => {
    if (node instanceof SpaceRootNode) return node.uri;
    if (node && typeof node === 'object' && 'uri' in node && (node as { uri?: unknown }).uri instanceof vscode.Uri) return (node as { uri: vscode.Uri }).uri;
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
  const getEntry = (node: unknown): { uri: vscode.Uri; isDirectory: boolean; basePath: string } | undefined => {
    if (node instanceof SpaceRootNode) return { uri: node.uri, isDirectory: true, basePath: node.definition.basePath };
    if (node && typeof node === 'object' && 'uri' in node && 'space' in node && 'isDirectory' in node) {
      const item = node as { uri: vscode.Uri; isDirectory: boolean; space: import('./types').SpaceDefinition };
      return { uri: item.uri, isDirectory: item.isDirectory, basePath: item.space.basePath };
    }
    return undefined;
  };
  const exists = async (uri: vscode.Uri): Promise<boolean> => { try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; } };
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
      provider.refresh();
    } catch (error) { operationError(error); }
  };
  const renameEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject space roots as defense in depth.
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
      undoStack.push({ kind: 'rename', from: entry.uri.fsPath, to: target.fsPath }); provider.refresh();
    } catch (error) { operationError(error); }
  };
  const moveEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject space roots as defense in depth.
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
      undoStack.push({ kind: 'move', from: entry.uri.fsPath, to: target.fsPath }); provider.refresh();
    } catch (error) { operationError(error); }
  };
  const deleteEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject space roots as defense in depth.
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
      await vscode.workspace.fs.delete(entry.uri, { recursive: entry.isDirectory, useTrash });
      provider.refresh();
    } catch (error) { operationError(error); }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeFolderSpaces.revealInExplorer', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('revealInExplorer', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.revealFileInOS', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('revealFileInOS', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.copyFilePath', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('copyFilePath', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.copyRelativeFilePath', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('copyRelativeFilePath', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.openInTerminal', async (node?: unknown) => { const uri = selectedUri(node); if (uri) await vscode.commands.executeCommand('openInIntegratedTerminal', { cwd: uri.fsPath }); }),
    vscode.commands.registerCommand('codeFolderSpaces.findInFolder', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('filesExplorer.findInFolder', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.newFile', (node?: unknown) => createEntry(node, false)),
    vscode.commands.registerCommand('codeFolderSpaces.newFolder', (node?: unknown) => createEntry(node, true)),
    vscode.commands.registerCommand('codeFolderSpaces.renameEntry', (node?: unknown) => renameEntry(node)),
    vscode.commands.registerCommand('codeFolderSpaces.moveTo', (node?: unknown) => moveEntry(node)),
    vscode.commands.registerCommand('codeFolderSpaces.deleteEntry', (node?: unknown) => deleteEntry(node)),
    vscode.commands.registerCommand('codeFolderSpaces.undoFileOperation', async () => {
      if (!requireTrust()) return;
      const entry = undoStack.peek();
      if (!entry) { void vscode.window.showInformationMessage(vscode.l10n.t('There is no file operation to undo.')); return; }
      const source = vscode.Uri.file(entry.from); const target = vscode.Uri.file(entry.to);
      try {
        await vscode.workspace.fs.stat(target);
        try { await vscode.workspace.fs.stat(source); void vscode.window.showErrorMessage(vscode.l10n.t('Cannot undo: the original path already exists: {0}', entry.from)); return; } catch { /* source is available */ }
        await vscode.workspace.fs.rename(target, source, { overwrite: false });
        undoStack.pop(); provider.refresh();
      } catch (error) { operationError(error); }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('codeFolderSpaces.drillDown', async (node?: unknown) => {
      const target = node && typeof node === 'object' && 'space' in node ? node as { space: import('./types').SpaceDefinition; uri: vscode.Uri; isDirectory: boolean } : undefined;
      if (!target?.isDirectory) return;
      const state = viewState.get(target.space.basePath);
      const activeRoot = state.root ?? target.space.basePath;
      const relative = path.relative(activeRoot, target.uri.fsPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
      await viewState.drillDown(target.space.basePath, target.uri.fsPath);
      provider.refresh();
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.drillUp', async () => {
      const target = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
      const definition = target instanceof SpaceRootNode ? target.definition : target && 'space' in target ? target.space : store.getDefinitions()[0];
      if (!definition || !(await viewState.drillUp(definition.basePath))) return;
      provider.refresh();
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.switchRoot', async (node?: SpaceRootNode) => {
      const target = node instanceof SpaceRootNode ? node : treeView.selection.find((item) => item instanceof SpaceRootNode);
      const definition = target?.definition ?? store.getDefinitions()[0];
      if (!definition) return;
      const currentRoot = viewState.get(definition.basePath).root ?? definition.basePath;
      const items: Array<vscode.QuickPickItem & { rootPath: string }> = [];
      if (path.resolve(currentRoot) !== path.resolve(definition.basePath)) {
        const parent = path.dirname(currentRoot);
        if (isAllowedSpaceRoot(definition.basePath, parent)) items.push({ label: '..', description: parent, rootPath: parent });
      }
      try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(currentRoot))) {
          if (type & vscode.FileType.Directory) {
            const rootPath = path.resolve(currentRoot, name);
            if (isAllowedSpaceRoot(definition.basePath, rootPath)) items.push({ label: name, description: rootPath, rootPath });
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not read folders: {0}', String(error)));
        return;
      }
      const selected = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a new space root') });
      if (!selected) return;
      if (!isAllowedSpaceRoot(definition.basePath, selected.rootPath)) {
        void vscode.window.showErrorMessage(vscode.l10n.t('The selected folder is outside the space root.'));
        return;
      }
      let selectedStat: vscode.FileStat | undefined;
      try { selectedStat = await vscode.workspace.fs.stat(vscode.Uri.file(selected.rootPath)); } catch { /* missing paths are rejected below */ }
      const validRoot = await isValidSpaceRoot(definition.basePath, selected.rootPath, async () => Boolean(selectedStat && (selectedStat.type & vscode.FileType.Directory)));
      if (!selectedStat) {
        void vscode.window.showErrorMessage(vscode.l10n.t('The selected folder does not exist.'));
        return;
      }
      if (!validRoot) {
        void vscode.window.showErrorMessage(vscode.l10n.t('The selected path is not a folder.'));
        return;
      }
      // 切換根＝重置 stack；drillDown／drillUp＝堆疊操作，避免混淆兩種 root 語意。
      await viewState.switchRoot(definition.basePath, selected.rootPath);
      provider.refresh();
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.renameSpace', async (node?: SpaceRootNode) => {
      const target = node instanceof SpaceRootNode ? node : treeView.selection.find((item): item is SpaceRootNode => item instanceof SpaceRootNode);
      if (!target) return;
      const proposed = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter a new space name'), value: target.definition.name });
      if (proposed === undefined) return;
      const name = validateSpaceName(target.definition.name, proposed);
      if (!name) return;
      try {
        if (!(await store.renameSpace(target.definition.basePath, name))) return;
        void vscode.window.showInformationMessage(vscode.l10n.t('Renamed space to: {0}', name));
      } catch (error) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not rename space: {0}', String(error)));
      }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.setPreset', async (preset?: unknown) => {
      const target = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
      const definition = target instanceof SpaceRootNode ? target.definition : target && 'space' in target ? target.space : store.getDefinitions()[0];
      if (!definition) return;
      let selected = preset;
      if (!isViewPresetName(selected)) {
        selected = await vscode.window.showQuickPick(Object.keys(VIEW_PRESETS), { placeHolder: vscode.l10n.t('Choose a view preset') });
      }
      if (!isViewPresetName(selected)) return;
      await viewState.setPreset(definition.basePath, selected);
      provider.refresh();
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.preset', selected);
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', VIEW_PRESETS[selected].mode);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.filter', async () => {
      const target = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
      const definition = target instanceof SpaceRootNode ? target.definition : target && 'space' in target ? target.space : store.getDefinitions()[0];
      if (!definition) return;
      const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Filter by path substring'), value: viewState.get(definition.basePath).filter });
      if (value === undefined) return;
      await viewState.setFilter(definition.basePath, value.trim());
      provider.refresh();
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', Boolean(value.trim()));
      treeView.message = '';
    }),
    vscode.commands.registerCommand('codeFolderSpaces.clearFilter', async () => {
      const target = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
      const definition = target instanceof SpaceRootNode ? target.definition : target && 'space' in target ? target.space : store.getDefinitions()[0];
      if (!definition) return;
      await viewState.clearFilter(definition.basePath);
      provider.refresh();
      treeView.message = '';
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', false);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.setSort', async (key?: unknown, direction?: unknown) => {
      const target = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
      const definition = target instanceof SpaceRootNode ? target.definition : target && 'space' in target ? target.space : store.getDefinitions()[0];
      if (!definition) return;
      const options = ['name', 'mtime', 'ctime'];
      const selectedKey = options.includes(String(key)) ? String(key) : await vscode.window.showQuickPick(options, { placeHolder: vscode.l10n.t('Choose sort field') });
      if (!selectedKey) return;
      const selectedDirection = direction === 'desc' || direction === 'asc' ? direction : await vscode.window.showQuickPick(['asc', 'desc'], { placeHolder: vscode.l10n.t('Choose sort direction') });
      if (selectedDirection !== 'asc' && selectedDirection !== 'desc') return;
      await viewState.setSort(definition.basePath, selectedKey as 'name' | 'mtime' | 'ctime', selectedDirection);
      provider.refresh();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.toggleMode', async () => {
      const target = treeView.selection.find((item) => item instanceof SpaceRootNode || 'space' in item);
      const definition = target instanceof SpaceRootNode ? target.definition : target && 'space' in target ? target.space : store.getDefinitions()[0];
      if (!definition) return;
      const current = viewState.get(definition.basePath).preset;
      const currentSettings = VIEW_PRESETS[current];
      const next = Object.entries(VIEW_PRESETS).find(([, value]) => value.mode !== currentSettings.mode && value.content === currentSettings.content && value.level === currentSettings.level)?.[0]
        ?? (currentSettings.mode === 'tree' ? 'Contents' : DEFAULT_VIEW_PRESET);
      await viewState.setPreset(definition.basePath, next as keyof typeof VIEW_PRESETS);
      provider.refresh();
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', VIEW_PRESETS[next as keyof typeof VIEW_PRESETS].mode);
    }),
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
    vscode.commands.registerCommand('codeFolderSpaces.removeSpace', async (node?: SpaceRootNode) => {
      const target =
        node instanceof SpaceRootNode
          ? node
          : treeView.selection.find((item): item is SpaceRootNode => item instanceof SpaceRootNode);
      if (!target) {
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
      const config = vscode.workspace.getConfiguration('codeFolderSpaces');
      const enabled = !config.get<boolean>('followActiveFile', false);
      await config.update('followActiveFile', enabled, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', enabled);
      scheduleFollow();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.expandLevel', async () => {
      // TreeView has no expandAll API. Expand only the selected directory (or space roots) one level;
      // this avoids recursively materializing an unbounded filesystem tree.
      const selection = treeView.selection[0];
      const parents = selection instanceof SpaceRootNode || (selection && 'isDirectory' in selection && selection.isDirectory)
        ? [selection as SpaceRootNode | import('./spaces/spaceTreeDataProvider').SpaceEntryNode]
        : await provider.getChildren();
      for (const parent of parents) {
        const children = await provider.getChildren(parent);
        for (const child of children) {
          if (child.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
            await treeView.reveal(child, { select: false, focus: false, expand: true });
          }
        }
      }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.revealActiveFile', async () => {
      const uri = getActiveTabUri();
      if (!uri) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No active file to reveal.'));
        return;
      }
      const node = await provider.findNodeByPath(uri.fsPath);
      if (!node) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No folder space contains the active file: {0}', uri.fsPath)
        );
        return;
      }
      await treeView.reveal(node, { select: true, focus: true, expand: true });
    })
  );

  rebuildWatchers();
  scheduleFollow();
  await syncContext();
  treeView.message = provider.filterMessage;
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
