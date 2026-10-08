import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** Lazily creates the shared `Folder Spaces` output channel. */
export function getLogChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Folder Spaces', { log: true });
  }
  return channel;
}

/** Releases the shared output channel (called on deactivate). */
export function disposeLogChannel(): void {
  channel?.dispose();
  channel = undefined;
}
