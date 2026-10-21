import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceConfigEntry, SpaceDefinition, SpaceOrigin } from '../types';
import { mergeSpaceDefinitions, normalizeSpaceEntries, originOf } from './spaceConfig';

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

  constructor(private readonly shim?: SpaceStoreConfigurationShim) {
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
   * 只讀 VS Code 設定（不含跨 profile 鏡像檔）。
   *
   * global 一律取 **globalValue**（`configuration.inspect`），避免把 workspace／資料夾層覆寫
   * 當成全域值讀進來——否則 Mark as Global 會把低層設定「提升」寫進 user settings。
   * （manifest 亦把 `spaces.global` 宣告為 `scope: application`，從源頭禁止低層覆寫。）
   */
  private getSettingEntries(origin: SpaceOrigin): SpaceConfigEntry[] {
    if (this.shim) {
      const value = this.shim.get(origin);
      return Array.isArray(value) ? [...value] : [];
    }
    const configuration = vscode.workspace.getConfiguration(SECTION);
    const inspected = configuration.inspect<SpaceConfigEntry[]>(`spaces.${origin}`);
    const value = origin === 'global'
      ? inspected?.globalValue ?? []
      : inspected?.workspaceValue ?? inspected?.globalValue ?? configuration.get<SpaceConfigEntry[]>(`spaces.${origin}`, []);
    return Array.isArray(value) ? [...value] : [];
  }

  /**
   * 讀取指定來源的原始設定（sourceIndex 僅對應此陣列）。
   *
   * v21-R4：global 來源＝標準 user settings 的 `spaces.global`（唯一正本）。
   * 舊的自訂鏡像檔已退役，由 `importGlobalEntries()` 一次性併入。
   */
  getRawEntries(origin: SpaceOrigin): SpaceConfigEntry[] {
    return this.getSettingEntries(origin);
  }

  /** 一次性遷移用：把舊來源的 global roots 併入 settings（同路徑去重，既有設定優先）。 */
  async importGlobalEntries(entries: readonly SpaceConfigEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const current = this.getSettingEntries('global');
    const key = (entry: SpaceConfigEntry): string => {
      const raw = typeof entry === 'string' ? entry : (entry.path ?? '');
      const normalized = path.normalize(raw);
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    const seen = new Set(current.map(key));
    const merged = [...current];
    let imported = 0;
    for (const entry of entries) {
      const entryKey = key(entry);
      if (seen.has(entryKey)) continue;
      seen.add(entryKey);
      merged.push(entry);
      imported += 1;
    }
    if (imported > 0) await this.writeEntries('global', merged);
    return imported;
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
      // v21-R4：global 的唯一正本＝標準 user settings（Default profile 即
      // %APPDATA%/Code/User/settings.json）。manifest 宣告 scope: application，
      // 讀取一律取 inspect().globalValue，不會把其他層級的覆寫「提升」上來。
      const target = vscode.ConfigurationTarget.Global;
      if (this.shim) await this.shim.update('global', entries, target);
      else await vscode.workspace.getConfiguration(SECTION).update('spaces.global', entries, target);
      return;
    }
    const target = vscode.ConfigurationTarget.Workspace;
    if (this.shim) {
      await this.shim.update(origin, entries, target);
    } else {
      await vscode.workspace.getConfiguration(SECTION).update(`spaces.${origin}`, entries, target);
    }
  }

  dispose(): void {
    this._configurationListener.dispose();
    this._onDidChange.dispose();
  }
}
