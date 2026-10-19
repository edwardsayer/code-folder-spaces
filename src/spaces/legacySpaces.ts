/**
 * v2-R2（使用者 2026-10-19 決策 c'）：舊的 `codeFolderSpaces.spaces` 已從 manifest 移除。
 *
 * **為什麼必須主動清除而不能只是忽略**：VS Code 的設定 key 有父子關係語意——
 * `codeFolderSpaces.spaces` 是 `codeFolderSpaces.spaces.workspace` 的父路徑。
 * 只要使用者的 `settings.json` 仍留著 `"codeFolderSpaces.spaces": []`（舊版預設寫入），
 * 它就會**遮蔽**兩個新 key 的讀取，導致 `spaces.workspace`／`spaces.global` 永遠讀到空值。
 * 實測（2026-10-19，隔離 profile）：
 *   - 留著 `"spaces": []` ＋ `"spaces.global": [Docs]` → `getSpaces()` 回 `[]`
 *   - 移除 `"spaces"` 後 → 正確回 `[{ origin: 'global' }]`
 *   - 把它加回去再 reload → 又回 `[]`
 *
 * 因此每次 activate 時把舊 key 從 Workspace 與 Global 兩層**移除**（設為 undefined）。
 * 舊值不遷移（使用者明示開發階段不需搬移），只清除以免遮蔽。
 */
export const LEGACY_SPACES_KEY = 'spaces';

/** 可注入的最小介面，供單元測試替換。 */
export interface LegacySpacesConfiguration {
  inspect<T>(section: string): { workspaceValue?: T; globalValue?: T } | undefined;
  update(section: string, value: unknown, target: unknown): Thenable<void>;
}

export interface LegacySpacesTargets {
  workspace: unknown;
  global: unknown;
}

/**
 * 清除舊 `spaces` 設定（若存在）。兩層都嘗試，個別失敗只記 log、不中斷啟動
 * （設定可能被 Organisation policy 鎖定為唯讀）。
 * 回傳是否有任一層實際被清除。
 */
export async function clearLegacySpacesSetting(
  configuration: LegacySpacesConfiguration,
  targets: LegacySpacesTargets,
  log?: { warn(message: string): void },
): Promise<boolean> {
  const inspected = configuration.inspect<unknown>(LEGACY_SPACES_KEY);
  const present: Array<{ target: unknown; label: string }> = [];
  if (inspected?.workspaceValue !== undefined) present.push({ target: targets.workspace, label: 'Workspace' });
  if (inspected?.globalValue !== undefined) present.push({ target: targets.global, label: 'Global' });
  if (!present.length) return false;

  let cleared = false;
  for (const { target, label } of present) {
    try {
      await configuration.update(LEGACY_SPACES_KEY, undefined, target);
      cleared = true;
    } catch (error) {
      log?.warn(`Could not remove legacy setting codeFolderSpaces.${LEGACY_SPACES_KEY} from ${label}: ${String(error)}`);
    }
  }
  return cleared;
}
