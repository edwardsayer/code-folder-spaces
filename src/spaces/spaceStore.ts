import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceConfigEntry, SpaceDefinition, SpaceOrigin } from '../types';
import { mergeSpaceDefinitions, normalizeSpaceEntries, originOf } from './spaceConfig';
import { createUserGlobalRootsIO, mergeUserGlobalRoots, type UserGlobalRootsIO } from './userGlobalRoots';

const SECTION = 'codeFolderSpaces';

type StoreTarget = vscode.ConfigurationTarget;

/** 測試用設定介面；正式執行仍使用 VS Code configuration。 */
export interface SpaceStoreConfigurationShim {
  get(origin: SpaceOrigin): SpaceConfigEntry[];
  update(origin: SpaceOrigin, entries: SpaceConfigEntry[], target: StoreTarget): Promise<void>;
  hasWorkspace(): boolean;
}

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Reads and writes the workspace/global space settings and exposes resolved
 * definitions. Fires `onDidChange` when either source changes.
 */
export class SpaceStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private readonly _configurationListener: vscode.Disposable;
  private readonly userGlobalRoots: UserGlobalRootsIO;
  private userGlobalRootsCache: SpaceConfigEntry[];

  constructor(private readonly shim?: SpaceStoreConfigurationShim, userGlobalRoots?: UserGlobalRootsIO) {
    this.userGlobalRoots = userGlobalRoots ?? createUserGlobalRootsIO();
    this.userGlobalRootsCache = this.userGlobalRoots.read();
    this._configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${SECTION}.spaces.workspace`) ||
        event.affectsConfiguration(`${SECTION}.spaces.global`)
      ) {
        this._onDidChange.fire();
      }
    });
  }

  /**
   * 讀取指定來源的原始設定（sourceIndex 僅對應此陣列）。
   * v2.1：global 來源＝舊設定 `spaces.global` ∪ 使用者層級檔案（跨 profile／跨專案）。
   */
  getRawEntries(origin: SpaceOrigin): SpaceConfigEntry[] {
    const value = this.shim
      ? this.shim.get(origin)
      : vscode.workspace.getConfiguration(SECTION).get<SpaceConfigEntry[]>(`spaces.${origin}`, []);
    const entries = Array.isArray(value) ? [...value] : [];
    if (origin !== 'global') return entries;
    return mergeUserGlobalRoots(entries, this.userGlobalRootsCache);
  }

  /** 取得單一來源的正規化定義。 */
  getDefinitionsByOrigin(origin: SpaceOrigin): SpaceDefinition[] {
    return normalizeSpaceEntries(
      this.getRawEntries(origin),
      {
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        userHome: os.homedir(),
      },
      true,
      origin,
    );
  }

  /** 解析後依 workspace、global 順序合併定義。 */
  getDefinitions(): SpaceDefinition[] {
    return mergeSpaceDefinitions(this.getDefinitionsByOrigin('workspace'), this.getDefinitionsByOrigin('global'));
  }

  /** 新增資料夾；未指定來源時，有 workspace 寫入 workspace，否則寫入 global。 */
  async addSpace(basePath: string, name?: string, origin?: SpaceOrigin): Promise<boolean> {
    if (this.getDefinitions().some((definition) => samePath(definition.basePath, basePath))) return false;
    const targetOrigin = origin ?? (this.hasWorkspace() ? 'workspace' : 'global');
    const entry: SpaceConfigEntry = name ? { path: basePath, name } : basePath;
    await this.writeEntries(targetOrigin, [...this.getRawEntries(targetOrigin), entry]);
    return true;
  }

  /** Explicitly updates a renamed space root after user confirmation. */
  async updateSpacePath(oldPath: string, newPath: string): Promise<boolean> {
    const target = this.getDefinitions().find((definition) => samePath(definition.basePath, oldPath));
    if (!target) return false;
    const origin = originOf(target);
    const entries = this.getRawEntries(origin);
    const entry = entries[target.sourceIndex];
    entries[target.sourceIndex] = typeof entry === 'string' ? newPath : { ...entry, path: newPath };
    await this.writeEntries(origin, entries);
    return true;
  }

  /** Updates only the configured display name, preserving the path and other entry fields. */
  async renameSpace(basePath: string, name: string): Promise<boolean> {
    const target = this.getDefinitions().find((definition) => samePath(definition.basePath, basePath));
    if (!target) return false;
    const origin = originOf(target);
    const entries = this.getRawEntries(origin);
    const entry = entries[target.sourceIndex];
    entries[target.sourceIndex] = typeof entry === 'string' ? { path: entry, name } : { ...entry, name };
    await this.writeEntries(origin, entries);
    return true;
  }

  /** 移除定義所屬來源中的資料夾。 */
  async removeSpace(basePath: string): Promise<boolean> {
    const target = this.getDefinitions().find((definition) => samePath(definition.basePath, basePath));
    if (!target) return false;
    const origin = originOf(target);
    const entries = this.getRawEntries(origin);
    await this.writeEntries(origin, entries.filter((_, index) => index !== target.sourceIndex));
    return true;
  }

  /** 將 workspace 定義搬至 global 設定。 */
  async markAsGlobal(basePath: string): Promise<boolean> {
    return this.moveSpace(basePath, 'workspace', 'global');
  }

  /** 將 global 定義搬回 workspace 設定。 */
  async unmarkGlobal(basePath: string): Promise<boolean> {
    return this.moveSpace(basePath, 'global', 'workspace');
  }

  isGlobal(basePath: string): boolean {
    const definition = this.getDefinitions().find((item) => samePath(item.basePath, basePath));
    return definition ? originOf(definition) === 'global' : false;
  }

  private async moveSpace(basePath: string, from: SpaceOrigin, to: SpaceOrigin): Promise<boolean> {
    const definition = this.getDefinitionsByOrigin(from).find((item) => samePath(item.basePath, basePath));
    if (!definition) return false;
    const snapshots = { [from]: this.getRawEntries(from), [to]: this.getRawEntries(to) } as Record<SpaceOrigin, SpaceConfigEntry[]>;
    const source = [...snapshots[from]];
    const destination = [...snapshots[to]];
    const moved = source.splice(definition.sourceIndex, 1)[0];
    if (moved === undefined) return false;
    destination.push(moved);
    const completed: SpaceOrigin[] = [];
    try {
      await this.writeEntries(from, source);
      completed.push(from);
      await this.writeEntries(to, destination);
      completed.push(to);
    } catch (error) {
      for (const origin of completed.reverse()) {
        try { await this.writeEntries(origin, snapshots[origin]); } catch { /* 保留原始失敗並繼續回復其他來源。 */ }
      }
      throw error;
    }
    return true;
  }

  private hasWorkspace(): boolean {
    return this.shim
      ? this.shim.hasWorkspace()
      : Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  }

  private async writeEntries(origin: SpaceOrigin, entries: SpaceConfigEntry[]): Promise<void> {
    if (origin === 'global') {
      // v2.1：global 寫入使用者層級檔案（跨 profile／跨專案可見），並把舊設定清空避免雙來源復活。
      this.userGlobalRoots.write(entries);
      this.userGlobalRootsCache = [...entries];
      const legacy = this.shim
        ? this.shim.get('global')
        : vscode.workspace.getConfiguration(SECTION).get<SpaceConfigEntry[]>('spaces.global', []);
      if (Array.isArray(legacy) && legacy.length > 0) {
        const target = vscode.ConfigurationTarget.Global;
        if (this.shim) await this.shim.update('global', [], target);
        else await vscode.workspace.getConfiguration(SECTION).update('spaces.global', [], target);
      }
      return;
    }
    const target = vscode.ConfigurationTarget.Workspace;
    if (this.shim) {
      await this.shim.update(origin, entries, target);
    } else {
      await vscode.workspace.getConfiguration(SECTION).update(`spaces.${origin}`, entries, target);
    }
  }

  /** 重新載入使用者層級 global roots（例如另一個 profile 剛改過檔案）。 */
  reloadUserGlobalRoots(): void {
    this.userGlobalRootsCache = this.userGlobalRoots.read();
    this._onDidChange.fire();
  }

  /** 使用者層級 global roots 檔案位置（供診斷／文件）。 */
  get userGlobalRootsPath(): string {
    return this.userGlobalRoots.filePath;
  }

  dispose(): void {
    this._configurationListener.dispose();
    this._onDidChange.dispose();
  }
}
