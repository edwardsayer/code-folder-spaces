import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpaceConfigEntry } from '../types';

/**
 * 舊版（v21-R2／R3）的 global roots 鏡像檔：一次性遷移後即退役。
 *
 * v21-R4（使用者決策）：**只留標準 user settings**（`codeFolderSpaces.spaces.global`，
 * `ConfigurationTarget.Global`），不再維護自訂檔案。為避免既有使用者資料遺失，啟動時
 * 若偵測到舊檔，會把內容併入 settings，然後把檔案改名為 `global-roots.migrated.json`；
 * 之後完全不再讀寫它。
 */
export const LEGACY_GLOBAL_ROOTS_DIR = '.code-folder-spaces';
export const LEGACY_GLOBAL_ROOTS_FILENAME = 'global-roots.json';
export const LEGACY_GLOBAL_ROOTS_RETIRED_SUFFIX = '.migrated.json';

export function resolveLegacyGlobalRootsPath(homeDir: string = os.homedir()): string {
  const override = process.env.CODEFOLDERSPACES_LEGACY_GLOBAL_ROOTS;
  if (override && homeDir === os.homedir()) return path.resolve(override);
  return path.join(homeDir, LEGACY_GLOBAL_ROOTS_DIR, LEGACY_GLOBAL_ROOTS_FILENAME);
}

function isEntry(value: unknown): value is SpaceConfigEntry {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { path?: unknown };
  return typeof candidate.path === 'string' && candidate.path.trim().length > 0;
}

/** 解析舊檔內容；任何格式問題都回空陣列（壞檔不得影響啟動）。 */
export function parseLegacyGlobalRoots(text: string | undefined | null): SpaceConfigEntry[] {
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

/** 讀取舊檔（不存在或壞檔 → 空陣列）。 */
export function readLegacyGlobalRoots(filePath: string = resolveLegacyGlobalRootsPath()): SpaceConfigEntry[] {
  try {
    return parseLegacyGlobalRoots(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 退役舊檔：改名為 `global-roots.migrated.json`（保留內容供人工檢查，不再被讀取）。
 * 回傳退役後的路徑；檔案不存在或改名失敗時回 undefined。
 */
export function retireLegacyGlobalRoots(filePath: string = resolveLegacyGlobalRootsPath()): string | undefined {
  const retired = filePath.replace(/\.json$/i, LEGACY_GLOBAL_ROOTS_RETIRED_SUFFIX);
  try {
    fs.renameSync(filePath, retired);
    return retired;
  } catch {
    return undefined;
  }
}
