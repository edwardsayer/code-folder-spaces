export interface StableQuickPickItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  /** S4.1R20：顯示在右側的值（QuickPick 的 description，等同 hotkey 的視覺位置）。 */
  readonly description?: string;
  /** 是否為目前選取值（QuickPick 會顯示打勾）。 */
  readonly picked?: boolean;
}

/** 選取的命令值與本地化顯示標籤分離，避免翻譯影響路由。 */
export function stableQuickPickItems<Id extends string>(
  items: readonly StableQuickPickItem<Id>[]
): StableQuickPickItem<Id>[] {
  return items.map(({ id, label, description, picked }) => ({ id, label, description, picked }));
}

export function selectedQuickPickId<Id extends string>(
  item: StableQuickPickItem<Id> | undefined
): Id | undefined {
  return item?.id;
}

/**
 * S4.1R20（使用者）：選單標題以「維度: 選定值」呈現，例如 `Preset: List`。
 * 無匹配值時顯示 `Preset: N/A`（例如 Level/Content/Mode 組成的自訂組合不屬於任何預設集）。
 */
export function labelledValue(dimension: string, value: string | undefined, notApplicable: string): string {
  return `${dimension}: ${value && value.length > 0 ? value : notApplicable}`;
}
