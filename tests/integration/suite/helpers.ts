import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceConfigEntry } from '../../../src/types';

export const fixtureWorkspace = path.resolve(__dirname, '../../../tests/integration/fixtures/workspace');

export function assertFixtureWorkspace(): void {
  if (!fs.existsSync(fixtureWorkspace)) {
    throw new Error(`找不到整合測試 fixture 工作區：${fixtureWorkspace}`);
  }
}

/** 僅操作 Global 設定，完成後逐項還原，不寫入工作區設定。 */
export async function withGlobalSettings<T>(
  values: { spaces?: SpaceConfigEntry[]; showFiles?: boolean },
  run: () => Promise<T>
): Promise<T> {
  const config = vscode.workspace.getConfiguration('codeFolderSpaces');
  const previousSpaces = config.inspect<SpaceConfigEntry[]>('spaces')?.globalValue;
  const previousShowFiles = config.inspect<boolean>('view.showFiles')?.globalValue;
  try {
    if (values.spaces !== undefined) {
      await config.update('spaces', values.spaces, vscode.ConfigurationTarget.Global);
    }
    if (values.showFiles !== undefined) {
      await config.update('view.showFiles', values.showFiles, vscode.ConfigurationTarget.Global);
    }
    return await run();
  } finally {
    await config.update('spaces', previousSpaces, vscode.ConfigurationTarget.Global);
    await config.update('view.showFiles', previousShowFiles, vscode.ConfigurationTarget.Global);
  }
}
