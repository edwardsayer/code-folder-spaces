import * as path from 'node:path';

/** 驗證候選根目錄位於空間原始根內（同時拒絕字串前綴造成的兄弟路徑誤判）。 */
export function isAllowedSpaceRoot(basePath: string, candidate: string): boolean {
  const base = path.resolve(basePath);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  const prefix = process.platform === 'win32' ? base.toLowerCase() : base;
  const targetPrefix = process.platform === 'win32' ? target.toLowerCase() : target;
  return (targetPrefix === prefix || targetPrefix.startsWith(prefix + path.sep)) &&
    (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)));
}

/** 範圍與 stat 均通過才是有效根；stat callback 讓不存在／非目錄邊界可單元測試。 */
export async function isValidSpaceRoot(
  basePath: string,
  candidate: string,
  isDirectory: (candidate: string) => Promise<boolean>
): Promise<boolean> {
  if (!isAllowedSpaceRoot(basePath, candidate)) return false;
  try { return await isDirectory(candidate); } catch { return false; }
}

/** 空白或未變更的名稱不應寫回設定。 */
export function validateSpaceName(currentName: string, proposedName: string): string | undefined {
  const name = proposedName.trim();
  return name && name !== currentName ? name : undefined;
}
