import * as vscode from 'vscode';
import { SpaceRootNode, SpaceTreeDataProvider } from './spaces/spaceTreeDataProvider';
import { SpaceStore } from './spaces/spaceStore';
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
  const provider = new SpaceTreeDataProvider(store);
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
    await vscode.commands.executeCommand(
      'setContext',
      'codeFolderSpaces.hasSpaces',
      store.getDefinitions().length > 0
    );
  };

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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
      rebuildWatchers();
      void syncContext();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeFolderSpaces.refresh', () => provider.refresh()),
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
