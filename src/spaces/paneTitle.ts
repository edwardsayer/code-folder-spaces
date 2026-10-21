/**
 * pane1 的標題文字（v21-R6，使用者設計）。
 *
 * 只有單一 pane（tree 模式）時，標題要有意義：
 *  - 位於 workspace（含 .code-workspace）→ 以 workspace 名稱為名
 *  - 位於一般資料夾專案 → 以該資料夾名稱為名
 *  - 兩者皆無 → `Global`（此時 pane 只顯示 global roots）
 *  - 有多個 root 時，以 `名稱 + n`（n＝root 數）表示，例如 `projA 2`
 */
export const GLOBAL_PANE_TITLE = 'Global';

export interface PaneTitleInput {
  /** `vscode.workspace.name`：workspace 檔名或單一資料夾名稱；沒有工作區時為 undefined。 */
  workspaceName?: string;
  /** 目前 pane 的 roots（用來判斷是否需要 `名稱 + n`）。 */
  rootCount: number;
}

export function paneTitleFor({ workspaceName, rootCount }: PaneTitleInput): string {
  const base = workspaceName && workspaceName.trim().length > 0 ? workspaceName.trim() : GLOBAL_PANE_TITLE;
  return rootCount > 1 ? `${base} ${rootCount}` : base;
}
