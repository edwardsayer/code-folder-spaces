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
    this.item.text = vscodeApi.l10n.t('$({0}) {1}', icon, summary.text);
    this.item.tooltip = summary.tooltip;
    this.item.command = this.focusMainPaneCommandId;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
