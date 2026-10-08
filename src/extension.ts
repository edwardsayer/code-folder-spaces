import * as vscode from 'vscode';
import * as path from 'node:path';
import { SpaceRootNode, SpaceTreeDataProvider } from './spaces/spaceTreeDataProvider';
import { SpaceStore } from './spaces/spaceStore';
import { DEFAULT_VIEW_PRESET, VIEW_PRESETS, isViewPresetName } from './spaces/viewPresets';
import { classifySpaceRename, PaneStateStore } from './spaces/viewState';
import { isAllowedSpaceRoot, isValidSpaceRoot, validateSpaceName } from './spaces/spaceActions';
import { disposeLogChannel, getLogChannel } from './util/log';

const VIEW_ID = 'codeFolderSpaces.explorer';
const REFRESH_DEBOUNCE_MS = 200;

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

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      provider.refresh();
      treeView.message = provider.filterMessage;
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

  context.subscriptions.push(
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
    vscode.commands.registerCommand('codeFolderSpaces.revealActiveFile', async () => {
      const uri = getActiveFileUri();
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
  await syncContext();
  treeView.message = provider.filterMessage;
  log.info('Folder Spaces activated');

  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  return {
    version,
    getSpaces: () => store.getDefinitions().map((definition) => ({ name: definition.name, basePath: definition.basePath })),
  };
}

function getActiveFileUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri;
  }
  return undefined;
}

export function deactivate(): void {
  disposeLogChannel();
}
