export type ActiveTabInput<T extends { scheme: string }> =
  | { kind: 'text' | 'custom' | 'notebook'; uri: T }
  | { kind: 'text-diff' | 'notebook-diff'; modified: T }
  | { kind: 'other' };

/** Returns the active document URI, preferring the modified side of diff tabs. */
export function resolveActiveTabUri<T extends { scheme: string }>(input: ActiveTabInput<T> | undefined): T | undefined {
  if (!input || input.kind === 'other') return undefined;
  const uri = 'uri' in input ? input.uri : input.modified;
  return uri.scheme === 'file' ? uri : undefined;
}

export function shouldFollowActiveFile(state: {
  enabled: boolean;
  generation: number;
  currentGeneration: number;
  visible: boolean;
}): boolean {
  return state.enabled && state.generation === state.currentGeneration && state.visible;
}
