import * as path from 'node:path';

/** 驗證候選根目錄位於空間原始根內（同時拒絕字串前綴造成的兄弟路徑誤判）。 */
export function isAllowedSpaceRoot(basePath: string, candidate: string): boolean {
  const base = path.resolve(basePath);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  const prefix = process.platform === 'win32' ? base.toLowerCase() : base;
  const targetPrefix = process.platform === 'win32' ? target.toLowerCase() : target;
  const descendantPrefix = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
  return (targetPrefix === prefix || targetPrefix.startsWith(descendantPrefix)) &&
    (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)));
}

/** 範圍與 stat 均通過才是有效根；stat callback 讓不存在／非目錄邊界可單元測試。 */
export async function isValidSpaceRoot(
  basePath: string,
  candidate: string,
  isDirectory: (candidate: string) => Promise<boolean>
): Promise<boolean> {
  if (!isAllowedSpaceRoot(basePath, candidate)) return false;
  try { return await isDirectory(candidate); } catch { return false; }
}

/** 空白或未變更的名稱不應寫回設定。 */
export function validateSpaceName(currentName: string, proposedName: string): string | undefined {
  const name = proposedName.trim();
  return name && name !== currentName ? name : undefined;
}

/** File-operation names must be a single non-special path segment. */
export function isValidEntryName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!(name.trim() && name === name.trim() && name !== '.' && name !== '..' && !/[\\/\\0]/.test(name))) return false;
  if (platform !== 'win32') return true;
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) return false;
  const deviceName = name.split('.')[0].replace(/[. ]+$/, '').toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName);
}

/** Compare paths using the host platform's case rules (Windows paths are case-insensitive). */
export function isSamePath(source: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const normalizedSource = pathApi.normalize(source);
  const normalizedTarget = pathApi.normalize(target);
  return platform === 'win32'
    ? normalizedSource.toLowerCase() === normalizedTarget.toLowerCase()
    : normalizedSource === normalizedTarget;
}

/** Prevent moving a directory into itself or any descendant. */
export function isSafeMove(source: string, target: string, isDirectory: boolean): boolean {
  if (!isDirectory) return true;
  const sourcePath = path.resolve(source);
  const targetPath = path.resolve(target);
  const relative = path.relative(sourcePath, targetPath);
  return relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

export interface DropTargetCandidate { path: string; isDirectory: boolean; isRoot?: boolean; }

/** Resolve supported TreeView drop targets; blank space and file rows are intentionally no-ops. */
export function resolveDropTarget(target: DropTargetCandidate | undefined): string | undefined {
  return target && (target.isRoot || target.isDirectory) ? target.path : undefined;
}

/** Paste accepts a space root or folder; selecting a file resolves to its parent folder. */
export function resolvePasteTarget(target: DropTargetCandidate | undefined): string | undefined {
  if (!target) return undefined;
  return target.isRoot || target.isDirectory ? target.path : path.dirname(target.path);
}

/** A moved path invalidates a pane root when it is that path or a descendant. */
export function hasDrillStateWithinMovedSources(stateRoots: string[], sources: string[]): boolean {
  return stateRoots.some(candidate => sources.some(source => isSamePath(candidate, source) || isAllowedSpaceRoot(source, candidate)));
}

export function uniqueEntryName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; ; index++) {
    const candidate = `${stem} ${index}${extension}`;
    if (!exists(candidate)) return candidate;
  }
}

export interface ClipboardEntry { uris: string[]; mode: 'cut' | 'copy'; }

/** Session-only internal clipboard; cut entries are consumed individually after successful moves. */
export class SpaceClipboard {
  private value: ClipboardEntry | undefined;
  set(uris: string[], mode: 'cut' | 'copy'): void { this.value = uris.length ? { uris: [...new Set(uris)], mode } : undefined; }
  get(): ClipboardEntry | undefined { return this.value && { uris: [...this.value.uris], mode: this.value.mode }; }
  consume(uri: string): void {
    if (this.value?.mode !== 'cut') return;
    this.value.uris = this.value.uris.filter(candidate => candidate !== uri);
    if (!this.value.uris.length) this.value = undefined;
  }
}

/** VS Code opens Beside in the adjacent editor group, reusing it when present. */
export function resolveOpenBeside(value: string | undefined): boolean { return value === 'beside'; }

export interface UndoEntry { from: string; to: string; kind: 'move' | 'rename'; }
export const UNDO_STACK_LIMIT = 20;

/** Bounded operation history; deliberately independent of VS Code's editor undo stack. */
export class UndoStack {
  private entries: UndoEntry[] = [];
  push(entry: UndoEntry): void {
    this.entries.push(entry);
    if (this.entries.length > UNDO_STACK_LIMIT) this.entries.shift();
  }
  peek(): UndoEntry | undefined { return this.entries[this.entries.length - 1]; }
  pop(): UndoEntry | undefined { return this.entries.pop(); }
  get size(): number { return this.entries.length; }
}

/** Trust is the sole authorization gate for extension-owned disk mutations. */
export function canModifyFiles(isTrusted: boolean): boolean { return isTrusted; }
