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
 *  - 再放**全域 roots**（標準 user settings 的 `codeFolderSpaces.spaces.global`，含 Mark as Global）
 *    ——即使目前 pane 還沒有它（切換到別的專案時仍應出現）；
 *  - 丟掉其餘 roots（例如前一個專案自動帶入、既非工作區根也非全域 roots 的目錄）。
 *
 * 注意：`spaces.workspace`（或 .code-workspace 設定）的 roots 以 `workspaceScoped` 傳入並一併併入——
 * 它們是「非 global」的持久化位置，Unmark Global 後必須能在切回專案時 restore。
 */
export function mergeFollowedWorkspaceRoots(
  current: string[],
  visible: string[],
  configured: string[],
  workspaceScoped: string[] = [],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (root: string): void => {
    const key = rootKey(root);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(root);
  };
  visible.forEach(push);
  // v21-R6：本專案 `spaces.workspace`（或 .code-workspace 設定）的 roots 也要出現在 pane——
  // 這是 Unmark Global 之後「切回專案要能 restore」的關鍵（root 存在專案／workspace 設定裡）。
  workspaceScoped.forEach(push);
  const visibleKeys = new Set(visible.map(rootKey));
  const configuredKeys = new Set([...configured, ...workspaceScoped].map(rootKey));
  // 既有設定根維持使用者目前的相對順序（避免每次同步重新洗牌）……
  for (const root of current) {
    const key = rootKey(root);
    if (!configuredKeys.has(key) || visibleKeys.has(key)) continue;
    push(root);
  }
  // ……其餘全域根（例如剛 Mark as Global、或別的專案設定的）接在後面，依設定順序。
  for (const root of configured) push(root);
  return result;
}
