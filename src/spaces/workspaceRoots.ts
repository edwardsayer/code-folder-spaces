import * as path from 'node:path';

/** 回傳未隱藏的工作區根目錄；Windows 路徑比較不區分大小寫。 */
export function visibleWorkspaceRoots(allRoots: string[], hidden: string[]): string[] {
  const hiddenKeys = new Set(hidden.map(root => path.normalize(root)));
  const normalizedHidden = process.platform === 'win32'
    ? new Set([...hiddenKeys].map(root => root.toLowerCase()))
    : hiddenKeys;
  return allRoots.filter(root => {
    const key = path.normalize(root);
    return !normalizedHidden.has(process.platform === 'win32' ? key.toLowerCase() : key);
  });
}

const rootKey = (root: string): string => {
  const normalized = path.normalize(root);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/**
 * OP-15 Follow Workspace Directory 的合併規則（v2.1 UI 修正）。
 *
 * 舊行為把 pane roots **整個取代** 成可見工作區根，會讓使用者設定（含 Mark as Global
 * 的 profile 層 root）在切換專案後遺失且不再回來。新規則：
 *  - 先放可見工作區根（順序依工作區）；
 *  - 再放**使用者設定**的 roots（`spaces.workspace`／`spaces.global`，含 Mark as Global 的 profile 層 root）
 *    ——即使目前 pane 還沒有它（切換到別的專案時 global root 仍應出現）；
 *  - 丟掉其餘 roots（例如前一個專案自動帶入、既非工作區根也非設定值的目錄）。
 *
 * 這讓「三種來源（工作區根／spaces.workspace／spaces.global）都是 pane 的根」與文件語意一致。
 */
export function mergeFollowedWorkspaceRoots(current: string[], visible: string[], configured: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (root: string): void => {
    const key = rootKey(root);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(root);
  };
  visible.forEach(push);
  configured.forEach(push);
  // 設定值已被涵蓋；current 僅用來保留「設定順序之外」的既有設定根（維持使用者當下順序）。
  const visibleKeys = new Set(visible.map(rootKey));
  const configuredKeys = new Set(configured.map(rootKey));
  for (const root of current) {
    const key = rootKey(root);
    if (!configuredKeys.has(key) || visibleKeys.has(key)) continue;
    push(root);
  }
  return result;
}
