import * as path from 'node:path';

export interface PaneTitleAndHintInput {
  mode: 'tree' | 'dual';
  roots: readonly string[];
  drillRoot: string | null;
  hasDrillStack: boolean;
  definitionName?: string;
}

export interface PaneTitleAndHintResult {
  /** 供 `treeView.title` 使用：單一 pane（tree）時為 undefined，使 container 標題維持 "Folder Spaces"；Dual 模式時為最後一段或 "Spaces" */
  viewTitle: string | undefined;
  /** 該 pane 的顯示名稱（例如供 API 或檢視使用） */
  displayName: string;
  /** 完整路徑或描述 */
  hint: string;
}

/**
 * 依據使用者設計（v22-R1 最新回饋）：
 * 1. 不要特意把 title name 首字大寫（維持原生目錄大小寫）。
 * 2. 不管 Tree 還是 Dual，都不要有 description。
 * 3. Dual 模式下：
 *    - pane1 若 root folder 個數大於 1（未下鑽），pane name 簡化為 "Spaces"。
 *    - 若下鑽或單 root，只取路徑最後一段（原生大小寫）。
 * 4. Tree 模式下：
 *    - container 的 title name 維持 "Folder Spaces"（viewTitle 設為 undefined）。
 * 5. Hint 規則：設為完整路徑；Container hint 永遠與 pane 1 的 hint 保持一致。
 *    若 drilldown/drillup，hint 也隨之更新。
 */
export function computePaneTitleAndHint({
  mode,
  roots,
  drillRoot,
  hasDrillStack,
  definitionName,
}: PaneTitleAndHintInput): PaneTitleAndHintResult {
  const isDrilling = Boolean(drillRoot && hasDrillStack);
  let nameSegment: string;
  let fullHint: string;

  if (isDrilling && drillRoot) {
    nameSegment = path.basename(drillRoot) || drillRoot;
    fullHint = drillRoot;
  } else if (roots.length === 1) {
    const rootPath = roots[0];
    nameSegment = definitionName || path.basename(rootPath) || rootPath;
    fullHint = rootPath;
  } else if (roots.length > 1) {
    nameSegment = 'Spaces';
    fullHint = roots.join('\n');
  } else {
    nameSegment = 'Spaces';
    fullHint = '';
  }

  if (mode === 'tree') {
    return {
      viewTitle: undefined,
      displayName: 'Folder Spaces',
      hint: fullHint,
    };
  } else {
    return {
      viewTitle: nameSegment,
      displayName: nameSegment,
      hint: fullHint,
    };
  }
}
