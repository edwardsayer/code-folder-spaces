import path from 'path';
import { isSamePath } from './spaceActions';

export interface CollectCandidatesOptions {
  readonly currentRoots: readonly string[];
  readonly globalRoots: readonly string[];
  readonly workspaceFolders: readonly string[];
  readonly recentFolders?: readonly string[];
}

/**
 * 判斷 `child` 是否為 `parent` 的嚴格子目錄（不含自身）。
 */
export function isStrictSubdirectory(child: string, parent: string): boolean {
  if (isSamePath(child, parent)) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 為「Add Folder to Space...」收集候選路徑：
 * 1. 除了 global root folder 外，當前所有 root path 的父層路徑
 * 2. 最近開啟的 folder
 * 3. 不秀當前 project 或 workspace 目錄的子目錄（使用者若有需要直接 drilldown）
 * 4. 去重（dedup）且排除已在 currentRoots 的路徑
 */
export function collectCandidateFolders(options: CollectCandidatesOptions): string[] {
  const { currentRoots, globalRoots, workspaceFolders, recentFolders = [] } = options;
  const rawCandidates: string[] = [];

  // 1. 除了 global root folder 外，當前所有 root path 的父層路徑
  for (const root of currentRoots) {
    const isGlobal = globalRoots.some(g => isSamePath(g, root));
    if (isGlobal) continue;
    const parent = path.dirname(root);
    // 若已是磁碟根目錄（如 C:\ 或 /），dirname 與自身相同，略過
    if (isSamePath(parent, root)) continue;
    rawCandidates.push(parent);
  }

  // 2. 最近開啟的 folder
  for (const recent of recentFolders) {
    if (recent && typeof recent === 'string') {
      rawCandidates.push(recent);
    }
  }

  // 3. 過濾與去重
  const result: string[] = [];
  for (const candidate of rawCandidates) {
    const resolved = path.resolve(candidate);
    // 排除已存在於 currentRoots
    if (currentRoots.some(r => isSamePath(r, resolved))) continue;
    // 不秀當前 project 或 workspace 目錄的子目錄
    const isSubOfWs = workspaceFolders.some(ws => isStrictSubdirectory(resolved, ws));
    if (isSubOfWs) continue;
    // 去重
    if (result.some(existing => isSamePath(existing, resolved))) continue;
    result.push(resolved);
  }

  return result;
}
