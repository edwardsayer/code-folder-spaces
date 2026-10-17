export type ExpandModeTarget = 'workspace' | 'global';

export interface ExpandModeProvenanceEntry {
  target: ExpandModeTarget;
  previous: unknown;
  workspaceKey?: string | null;
}

export type ExpandModeProvenance = Partial<Record<ExpandModeTarget, { previous: unknown; workspaceKey?: string | null }>>;

export function resolveExpandModeTarget(hasWorkspace: boolean): ExpandModeTarget {
  return hasWorkspace ? 'workspace' : 'global';
}

export function resolveWorkspaceIdentity(workspaceFileUri: string | null | undefined, firstFolderUri: string | null | undefined): string | null {
  return workspaceFileUri ?? firstFolderUri ?? null;
}

export function shouldWriteExpandModeRestore(currentValue: unknown, restoreValue: unknown): boolean {
  return currentValue !== restoreValue;
}

export function shouldRecordProvenance(targetValueBefore: unknown): boolean {
  return targetValueBefore !== 'doubleClick';
}

export function resolveExpandModeRestore(provenance: ExpandModeProvenanceEntry): { target: ExpandModeTarget; value: unknown } {
  return { target: provenance.target, value: provenance.previous };
}

/** 舊格式未帶 workspaceKey 時視為目前工作區，維持既有記錄相容性。 */
export function belongsToWorkspace(entry: { previous?: unknown; workspaceKey?: string | null }, workspaceKey: string | null): boolean {
  return entry.workspaceKey === undefined || entry.workspaceKey === workspaceKey;
}

/** 決定本次 align 是否寫入 provenance，並保留同工作區的首次原值。 */
export function resolveAlignedProvenance(
  existing: { previous: unknown; workspaceKey?: string | null } | undefined,
  previous: unknown,
  workspaceKey: string | null,
): { previous: unknown; workspaceKey?: string | null } | undefined {
  if (existing && belongsToWorkspace(existing, workspaceKey)) return existing;
  if (existing || shouldRecordProvenance(previous)) return { previous, workspaceKey };
  return undefined;
}

/** 將舊版單一 target 記錄轉成依 target 索引的格式。 */
export function normalizeExpandModeProvenance(value: unknown): ExpandModeProvenance {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  if (record.target === 'workspace' || record.target === 'global') {
    return { [record.target]: { previous: record.previous } };
  }
  const result: ExpandModeProvenance = {};
  for (const target of ['workspace', 'global'] as const) {
    const entry = record[target];
    if (entry && typeof entry === 'object') {
      const normalized = entry as { previous?: unknown; workspaceKey?: unknown };
      result[target] = {
        previous: normalized.previous,
        ...(typeof normalized.workspaceKey === 'string' || normalized.workspaceKey === null ? { workspaceKey: normalized.workspaceKey } : {}),
      };
    }
  }
  return result;
}
