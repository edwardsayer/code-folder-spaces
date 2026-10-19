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
