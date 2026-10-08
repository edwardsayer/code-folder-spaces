import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceConfigEntry, SpaceDefinition } from '../types';
import { normalizeSpaceEntries } from './spaceConfig';

const SECTION = 'codeFolderSpaces';
const SPACES_KEY = 'spaces';
const SHOW_FILES_KEY = 'view.showFiles';

function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Reads and writes the `codeFolderSpaces.spaces` setting and exposes resolved
 * space definitions. Fires `onDidChange` when the configuration changes.
 */
export class SpaceStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private readonly _configurationListener: vscode.Disposable;

  constructor() {
    this._configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${SECTION}.${SPACES_KEY}`) ||
        event.affectsConfiguration(`${SECTION}.${SHOW_FILES_KEY}`)
      ) {
        this._onDidChange.fire();
      }
    });
  }

  /** Raw entries exactly as stored in settings (used for edits). */
  getRawEntries(): SpaceConfigEntry[] {
    const value = vscode.workspace.getConfiguration(SECTION).get<SpaceConfigEntry[]>(SPACES_KEY, []);
    return Array.isArray(value) ? [...value] : [];
  }

  /** Resolved, validated definitions ready for the tree. */
  getDefinitions(): SpaceDefinition[] {
    const configuration = vscode.workspace.getConfiguration(SECTION);
    const entries = configuration.get<SpaceConfigEntry[]>(SPACES_KEY, []);
    const showFiles = configuration.get<boolean>(SHOW_FILES_KEY, true);
    return normalizeSpaceEntries(
      entries,
      {
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        userHome: os.homedir(),
      },
      showFiles
    );
  }

  /** Adds a folder; no-op when the path is already present. */
  async addSpace(basePath: string, name?: string): Promise<boolean> {
    if (this.getDefinitions().some((definition) => samePath(definition.basePath, basePath))) {
      return false;
    }
    const entry: SpaceConfigEntry = name ? { path: basePath, name } : basePath;
    await this._writeEntries([...this.getRawEntries(), entry]);
    return true;
  }

  /** Removes a folder by resolved path; returns whether an entry was removed. */
  async removeSpace(basePath: string): Promise<boolean> {
    const entries = this.getRawEntries();
    const target = this.getDefinitions().find((definition) => samePath(definition.basePath, basePath));
    if (!target) {
      return false;
    }
    await this._writeEntries(entries.filter((_, index) => index !== target.sourceIndex));
    return true;
  }

  private async _writeEntries(entries: SpaceConfigEntry[]): Promise<void> {
    const hasWorkspace = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
    const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration(SECTION).update(SPACES_KEY, entries, target);
  }

  dispose(): void {
    this._configurationListener.dispose();
    this._onDidChange.dispose();
  }
}
