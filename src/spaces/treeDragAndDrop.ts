import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceDefinition } from '../types';
import { isAllowedSpaceRoot, isSafeMove, isSamePath, resolveDropTarget, uniqueEntryName, UndoStack } from './spaceActions';
import { SpaceEntryNode, SpaceRootNode, type SpaceNode } from './spaceTreeDataProvider';

const URI_LIST_MIME = 'text/uri-list';
const TREE_MIME_PREFIX = 'application/vnd.code.tree.codeFolderSpaces.';

export interface TreeDragAndDropOptions {
  getDefinitions(): SpaceDefinition[];
  undoStack: UndoStack;
  requireTrust(): boolean;
  clearDrillStateForMovedSources(sources: vscode.Uri[]): Promise<void>;
  onChanged(): void;
  onError(error: unknown): void;
}

/** 複製整個檔案樹；供拖放外部來源與剪貼簿複製共用。 */
export async function copyTreeEntry(source: vscode.Uri, destination: vscode.Uri): Promise<void> {
  const stat = await vscode.workspace.fs.stat(source);
  if (stat.type & vscode.FileType.Directory) {
    await vscode.workspace.fs.createDirectory(destination);
    for (const [name] of await vscode.workspace.fs.readDirectory(source)) {
      await copyTreeEntry(vscode.Uri.joinPath(source, name), vscode.Uri.joinPath(destination, name));
    }
  } else {
    await vscode.workspace.fs.writeFile(destination, await vscode.workspace.fs.readFile(source));
  }
}

/** 建立所有 pane 共用、以空間定義歸屬決定 move/copy 的原生 TreeView 拖放 controller。 */
export function createTreeDragAndDropController(
  paneId: string,
  options: TreeDragAndDropOptions
): vscode.TreeDragAndDropController<SpaceNode> {
  const treeMime = `${TREE_MIME_PREFIX}${paneId}`;
  return {
    dragMimeTypes: [URI_LIST_MIME, treeMime],
    dropMimeTypes: [URI_LIST_MIME, treeMime],
    handleDrag: async (source, transfer) => {
      const uris = source
        .filter((node): node is SpaceEntryNode => node instanceof SpaceEntryNode && node.uri.scheme === 'file')
        .map(node => node.uri);
      if (!uris.length) return;
      const serialized = uris.map(uri => uri.toString()).join('\r\n');
      transfer.set(URI_LIST_MIME, new vscode.DataTransferItem(serialized));
      transfer.set(treeMime, new vscode.DataTransferItem(serialized));
    },
    handleDrop: async (target, transfer) => {
      if (!target) return;
      const targetUri = target.uri;
      if (!targetUri || targetUri.scheme !== 'file') return;
      const destinationPath = resolveDropTarget(target instanceof SpaceRootNode
        ? { path: targetUri.fsPath, isDirectory: true, isRoot: true }
        : { path: targetUri.fsPath, isDirectory: Boolean((target as { isDirectory?: boolean }).isDirectory) });
      if (!destinationPath) return;
      const destination = vscode.Uri.file(destinationPath);
      let destinationStat: vscode.FileStat;
      try { destinationStat = await vscode.workspace.fs.stat(destination); }
      catch { return; }
      if (!(destinationStat.type & vscode.FileType.Directory)) return;
      const item = transfer.get(treeMime) ?? transfer.get(URI_LIST_MIME);
      if (!item || !options.requireTrust()) return;
      try {
        const raw = await item.asString();
        const sources = raw.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => vscode.Uri.parse(line));
        await processDroppedEntries(sources, destination, options);
      } catch (error) {
        options.onError(error);
      }
    },
  };
}

async function processDroppedEntries(sources: vscode.Uri[], destination: vscode.Uri, options: TreeDragAndDropOptions): Promise<void> {
  const destinationStat = await vscode.workspace.fs.stat(destination);
  if (!(destinationStat.type & vscode.FileType.Directory)) return;
  const entries = await vscode.workspace.fs.readDirectory(destination);
  const occupied = new Set(entries.map(([name]) => nameKey(name)));
  let copiedCount = 0;
  let changed = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Processing dropped items'), cancellable: false }, async progress => {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (source.scheme !== 'file' || source.authority !== destination.authority) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Cannot transfer items between different file system providers.'));
        continue;
      }
      let stat: vscode.FileStat;
      try { stat = await vscode.workspace.fs.stat(source); }
      catch { void vscode.window.showErrorMessage(vscode.l10n.t('The source no longer exists: {0}', source.fsPath)); continue; }
      const name = path.basename(source.fsPath);
      const external = !options.getDefinitions().some(definition => isAllowedSpaceRoot(definition.basePath, source.fsPath));
      const sourceTargetPath = path.join(destination.fsPath, name);
      if (!isSafeMove(source.fsPath, sourceTargetPath, Boolean(stat.type & vscode.FileType.Directory))) {
        void vscode.window.showErrorMessage(vscode.l10n.t('A folder cannot be moved into itself or one of its subfolders.'));
        continue;
      }
      if (!external && isSamePath(source.fsPath, sourceTargetPath)) continue;
      const uniqueName = uniqueEntryName(name, candidate => occupied.has(nameKey(candidate)));
      const targetUri = vscode.Uri.joinPath(destination, uniqueName);
      progress.report({ message: `${index + 1}/${sources.length}: ${name}` });
      try {
        if (external) {
          try { await copyTreeEntry(source, targetUri); }
          catch (error) {
            try { await vscode.workspace.fs.delete(targetUri, { recursive: true, useTrash: false }); } catch { /* 保留原始複製錯誤。 */ }
            throw error;
          }
          copiedCount++;
        } else {
          await vscode.workspace.fs.rename(source, targetUri, { overwrite: false });
          options.undoStack.push({ kind: 'move', from: source.fsPath, to: targetUri.fsPath });
          changed = true;
          await options.clearDrillStateForMovedSources([source]);
        }
        occupied.add(nameKey(uniqueName));
        changed = true;
      } catch (error) { options.onError(error); }
    }
  });
  if (copiedCount) void vscode.window.showInformationMessage(vscode.l10n.t('Copied {0} item(s). Copies cannot be undone.', copiedCount));
  if (changed) options.onChanged();
}

function nameKey(name: string): string { return process.platform === 'win32' ? name.toLowerCase() : name; }
