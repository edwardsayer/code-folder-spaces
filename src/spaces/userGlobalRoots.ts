import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpaceConfigEntry } from '../types';

/**
 * 使用者層級（跨 profile／跨專案）的 global roots 儲存。
 *
 * v2.1（使用者需求）：`Mark as Global` 的根目錄必須「同一個 OS 使用者」在任何 VS Code
 * profile、任何專案都看得到。VS Code profile 會各自隔離 `settings.json` 與 extension
 * globalState，因此改存到使用者家目錄下的固定檔案：
 *   `~/.code-folder-spaces/global-roots.json`
 *
 * 檔案格式（寬鬆解析，向後相容）：
 *   `{ "version": 1, "roots": [ "D:/notes", { "path": "D:/work", "name": "Work" } ] }`
 * 也接受最外層直接是陣列。
 */
export const USER_GLOBAL_ROOTS_DIR = '.code-folder-spaces';
export const USER_GLOBAL_ROOTS_FILENAME = 'global-roots.json';
export const USER_GLOBAL_ROOTS_VERSION = 1;

export function resolveUserGlobalRootsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, USER_GLOBAL_ROOTS_DIR, USER_GLOBAL_ROOTS_FILENAME);
}

function isEntry(value: unknown): value is SpaceConfigEntry {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { path?: unknown };
  return typeof candidate.path === 'string' && candidate.path.trim().length > 0;
}

/** 解析檔案內容；任何格式問題都回空陣列（不讓壞檔壞掉啟動）。 */
export function parseUserGlobalRoots(text: string | undefined | null): SpaceConfigEntry[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const parsedRoots = parsed && typeof parsed === 'object' ? (parsed as { roots?: unknown }).roots : undefined;
  const raw: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsedRoots) ? parsedRoots : [];
  return raw.filter(isEntry);
}

export function serializeUserGlobalRoots(entries: readonly SpaceConfigEntry[]): string {
  return `${JSON.stringify({ version: USER_GLOBAL_ROOTS_VERSION, roots: [...entries] }, null, 2)}\n`;
}

const entryKey = (entry: SpaceConfigEntry): string => {
  const raw = typeof entry === 'string' ? entry : (entry.path ?? '');
  const normalized = path.normalize(raw);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/**
 * 合併「舊設定 `codeFolderSpaces.spaces.global`」與使用者層級檔案：
 * 設定先、檔案後，同一路徑只留第一筆（設定值可覆蓋檔案內同名項目的顯示屬性）。
 */
export function mergeUserGlobalRoots(settingEntries: readonly SpaceConfigEntry[], fileEntries: readonly SpaceConfigEntry[]): SpaceConfigEntry[] {
  const result: SpaceConfigEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...settingEntries, ...fileEntries]) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/** 檔案讀寫介面（測試可注入替身）。 */
export interface UserGlobalRootsIO {
  readonly filePath: string;
  read(): SpaceConfigEntry[];
  write(entries: readonly SpaceConfigEntry[]): void;
}

export function createUserGlobalRootsIO(filePath: string = process.env.CODEFOLDERSPACES_GLOBAL_ROOTS_FILE ?? resolveUserGlobalRootsPath()): UserGlobalRootsIO {
  return {
    filePath,
    read() {
      try {
        return parseUserGlobalRoots(fs.readFileSync(filePath, 'utf8'));
      } catch {
        return [];
      }
    },
    write(entries) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 先寫暫存檔再 rename，避免中途失敗留下半個 JSON。
      const temp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, serializeUserGlobalRoots(entries), 'utf8');
      fs.renameSync(temp, filePath);
    },
  };
}
