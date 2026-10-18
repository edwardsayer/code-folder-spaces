import type * as vscode from 'vscode';

export interface LinkStatusSummary {
  visible: boolean;
  text: string;
  tooltip: string;
  follow: boolean[];
}

/** Select the status icon from the follow state of the chain's links. */
export function linkStatusIcon(follow: readonly boolean[]): 'link' | 'debug-disconnect' {
  return follow.every(Boolean) ? 'link' : 'debug-disconnect';
}

/**
 * S4.1R17（OP-22）：組出 `1→2/3, 2→4` 形式的邊列表文字。
 * 每個邊組只呈現「父→其直接子」兩層；所有父子關係都會出現。
 * `formatPane` 由呼叫端提供，以便走 l10n（純函式不產生翻譯字面值）。
 */
export function createLinkEdgesText(
  groups: readonly { parentPaneIndex: number; childPaneIndexes: readonly number[] }[],
  formatPane: (index: number) => string,
  separator: string,
  childJoiner: string,
  arrow: string,
): string {
  return groups
    .filter(group => group.childPaneIndexes.length > 0)
    .map(group => `${formatPane(group.parentPaneIndex)}${arrow}${group.childPaneIndexes.map(formatPane).join(childJoiner)}`)
    .join(separator);
}

/**
 * 由邊組摘要建立狀態列內容。
 * 沒有任何父子邊時 `visible: false`（狀態列應完全隱藏）。
 */
export function createLinkStatusSummaryFromEdges(
  groups: readonly { parentPaneIndex: number; childPaneIndexes: readonly number[]; allFollow: boolean }[],
  formatPane: (index: number) => string,
  labels: { prefix: string; separator: string; childJoiner: string; arrow: string; followOff: (label: string) => string },
): LinkStatusSummary {
  const withChildren = groups.filter(group => group.childPaneIndexes.length > 0);
  if (!withChildren.length) return { visible: false, text: '', tooltip: '', follow: [] };

  const text = createLinkEdgesText(withChildren, formatPane, labels.separator, labels.childJoiner, labels.arrow);
  // tooltip：逐組標示 follow 關閉的環節，方便判斷哪條連動被停用。
  const tooltip = withChildren
    .map(group => {
      const parent = formatPane(group.parentPaneIndex);
      const children = group.childPaneIndexes.map(formatPane).join(labels.childJoiner);
      const line = `${parent}${labels.arrow}${children}`;
      return group.allFollow ? line : labels.followOff(line);
    })
    .join(labels.separator);

  return {
    visible: true,
    text: `${labels.prefix} ${text}`,
    tooltip,
    follow: withChildren.map(group => group.allFollow),
  };
}

/** Compose the localized status text for a pane chain. `follow` contains each chain link's state. */
export function createLinkStatusSummary(
  labels: readonly string[],
  tooltip: string,
  follow: readonly boolean[],
): LinkStatusSummary {
  if (labels.length < 2) return { visible: false, text: '', tooltip: '', follow: [...follow] };
  return {
    visible: true,
    text: labels.join(' → '),
    tooltip,
    follow: [...follow],
  };
}

export class LinkStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly getSummary: () => LinkStatusSummary,
    private readonly focusMainPaneCommandId: string,
  ) {
    const vscodeApi = require('vscode') as typeof vscode;
    this.item = vscodeApi.window.createStatusBarItem(vscodeApi.StatusBarAlignment.Left);
  }

  update(): void {
    const vscodeApi = require('vscode') as typeof vscode;
    const summary = this.getSummary();
    if (!summary.visible) {
      this.item.hide();
      return;
    }

    const icon = linkStatusIcon(summary.follow);
    // 狀態列文字已含前綴（`Folder Spaces: …`），圖示只反映是否有連動被關閉。
    this.item.text = vscodeApi.l10n.t('$({0}) {1}', icon, summary.text);
    this.item.tooltip = summary.tooltip;
    this.item.command = this.focusMainPaneCommandId;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
