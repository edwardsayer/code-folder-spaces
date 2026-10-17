/**
 * 檔案監看器計畫（S4.1R12b MR-I5 的可測性抽取）。
 *
 * 原實作位於 `extension.ts` 的 `activate()` 閉包內，直接操作
 * `vscode.workspace.createFileSystemWatcher`，因此無法以單元測試斷言
 * 「逐 root 建立」與「同 root 跨窗格去重」。這裡只抽出去重計算本身
 * （純邏輯、無 `vscode` 相依），實際 watcher 的建立／dispose 仍由
 * `extension.ts` 負責。語意與原實作等價（D68），唯一差異是額外收斂「同一目錄的尾端分隔符寫法」
 * （原實作會為 `dir` 與 `dir/` 各建一個 watcher，現只建一個）。
 */
import path from 'node:path';
import { normalizeSpaceKey } from './viewState';

/** watcher 計畫輸入：每個窗格目前的 root 清單。 */
export interface WatcherPaneDefinitions {
  paneId: string;
  roots: readonly string[];
}

/**
 * 收斂同一目錄的不同寫法：`path.normalize` 後移除尾端分隔符，但保留磁碟根
 * （`C:\`）與 POSIX 根（`/`），避免 `dir` 與 `dir/` 被當成兩個 root。
 */
function canonicalRoot(root: string): string {
  const normalized = path.normalize(root);
  const rootPrefix = path.parse(normalized).root;
  if (normalized.length > rootPrefix.length && normalized.endsWith(path.sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * 計算「應該存在哪些監看器」。
 *
 * 回傳 key 為 `normalizeSpaceKey(root)`、value 為**正規化後**的 root 路徑。
 * 同一個 root 被多個窗格共用時只保留一筆（跨窗格去重，D68）；
 * 大小寫（Windows）與尾端分隔符差異亦視為同一 root。
 */
export function planWatchers(panes: readonly WatcherPaneDefinitions[]): Map<string, string> {
  const desired = new Map<string, string>();
  for (const pane of panes) {
    for (const root of pane.roots) {
      const canonical = canonicalRoot(root);
      const key = normalizeSpaceKey(canonical);
      if (desired.has(key)) continue;
      desired.set(key, canonical);
    }
  }
  return desired;
}

/**
 * 比對既有與期望的 watcher key，決定要 dispose 與要新建的項目。
 *
 * `existing` 為目前持有的 key 集合（可為任意 iterable）。
 * 回傳的 `dispose` 為「已存在但不再需要」的 key；`create` 為
 * 「需要但尚未建立」的 root（以正規化路徑字串表示）。
 */
export function diffWatchers(
  existing: Iterable<string>,
  desired: ReadonlyMap<string, string>
): { dispose: string[]; create: string[] } {
  const current = new Set(existing);
  const dispose: string[] = [];
  for (const key of current) if (!desired.has(key)) dispose.push(key);
  const create: string[] = [];
  for (const [key, root] of desired) if (!current.has(key)) create.push(root);
  return { dispose, create };
}
