export interface StableQuickPickItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

/** 選取的命令值與本地化顯示標籤分離，避免翻譯影響路由。 */
export function stableQuickPickItems<Id extends string>(
  items: readonly StableQuickPickItem<Id>[]
): StableQuickPickItem<Id>[] {
  return items.map(({ id, label }) => ({ id, label }));
}

export function selectedQuickPickId<Id extends string>(
  item: StableQuickPickItem<Id> | undefined
): Id | undefined {
  return item?.id;
}
