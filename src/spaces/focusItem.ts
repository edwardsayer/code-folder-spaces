/**
 * 快捷鍵 `when` 用的「目前選取項目種類」純邏輯（keys/R2）。
 *
 * 背景：`viewItem` 只存在於 `view/item/context` 選單求值用的 overlay context，
 * **在 keybinding 的 `when` 恆為 false**（實機證實，見
 * `dev/code-colorful-recent-files/tests/feat/R3/fod-01-viewitem-keybinding.md`），
 * 因此本產品改以自有 context key `codeFolderSpaces.<pane>.focusItem` 取代。
 *
 * 本模組**不依賴 `vscode`**，可單元測試。
 */

/** 節點 `contextValue` → 快捷鍵條件用的種類值。 */
export type FocusItemKind =
  | 'file'
  | 'folder'
  | 'code-workspace'
  | 'spaceRoot'
  | 'spaceRootGlobal'
  | 'flatRootGroup'
  | 'none';

const CONTEXT_TO_KIND: Readonly<Record<string, FocusItemKind>> = {
  'codeFolderSpaces.file': 'file',
  'codeFolderSpaces.file.code-workspace': 'code-workspace',
  'codeFolderSpaces.folder': 'folder',
  'codeFolderSpaces.spaceRoot': 'spaceRoot',
  'codeFolderSpaces.spaceRoot.global': 'spaceRootGlobal',
  'codeFolderSpaces.flatRootGroup': 'flatRootGroup',
};

/**
 * 由 `TreeItem.contextValue` 推出 context key 的值。
 * 未知或缺少 `contextValue`（含「無選取」）一律回 `none`，確保 `when` 條件不會誤觸發。
 */
export function focusItemKindOf(contextValue: string | undefined): FocusItemKind {
  if (!contextValue) return 'none';
  return CONTEXT_TO_KIND[contextValue] ?? 'none';
}

/** 快捷鍵 `when` 中允許檔案操作的種類（與既有 keybinding 意圖一致：僅檔案與資料夾）。 */
export const FILE_ACTION_KINDS = '^(file|folder)$';
