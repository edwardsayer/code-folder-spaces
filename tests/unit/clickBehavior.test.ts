import { describe, expect, it } from 'vitest';
import {
  normalizeExpandModeProvenance,
  resolveExpandModeRestore,
  resolveExpandModeTarget,
  shouldRecordProvenance,
  belongsToWorkspace,
  resolveAlignedProvenance,
  resolveWorkspaceIdentity,
  shouldWriteExpandModeRestore,
} from '../../src/spaces/clickBehavior';

describe('expandMode click behavior', () => {
  it('chooses workspace or global target from workspace presence', () => {
    expect(resolveExpandModeTarget(true)).toBe('workspace');
    expect(resolveExpandModeTarget(false)).toBe('global');
  });

  it('identifies a workspace by workspace file before its first folder', () => {
    const workspaceFile = 'file:///work/project.code-workspace';
    const firstFolder = 'file:///work/alpha';
    expect(resolveWorkspaceIdentity(workspaceFile, firstFolder)).toBe(workspaceFile);
    expect(resolveWorkspaceIdentity(undefined, firstFolder)).toBe(firstFolder);
    expect(resolveWorkspaceIdentity(null, undefined)).toBeNull();
    expect(resolveWorkspaceIdentity(workspaceFile, firstFolder)).not.toBe(firstFolder);
  });

  it('writes a restore only when the current target value differs', () => {
    expect(shouldWriteExpandModeRestore(undefined, undefined)).toBe(false);
    expect(shouldWriteExpandModeRestore('singleClick', 'singleClick')).toBe(false);
    expect(shouldWriteExpandModeRestore('doubleClick', 'singleClick')).toBe(true);
    expect(shouldWriteExpandModeRestore(undefined, 'singleClick')).toBe(true);
  });

  it.each([
    [undefined, true],
    ['doubleClick', false],
    ['singleClick', true],
  ])('records prior value %s only when it differs from doubleClick', (value, expected) => {
    expect(shouldRecordProvenance(value)).toBe(expected);
  });

  it('scopes provenance to a workspace while preserving same-workspace originals', () => {
    expect(resolveAlignedProvenance(undefined, 'singleClick', 'A')).toEqual({ previous: 'singleClick', workspaceKey: 'A' });
    expect(resolveAlignedProvenance({ previous: 'singleClick', workspaceKey: 'A' }, 'doubleClick', 'A')).toEqual({ previous: 'singleClick', workspaceKey: 'A' });
    expect(resolveAlignedProvenance({ previous: 'singleClick', workspaceKey: 'A' }, 'singleClick', 'B')).toEqual({ previous: 'singleClick', workspaceKey: 'B' });
    expect(resolveAlignedProvenance(undefined, 'doubleClick', 'A')).toBeUndefined();
  });

  it('restores only current workspace records and treats legacy records as current', () => {
    expect(belongsToWorkspace({ workspaceKey: 'A' }, 'B')).toBe(false);
    expect(belongsToWorkspace({ workspaceKey: 'A' }, 'A')).toBe(true);
    expect(belongsToWorkspace({ previous: 'singleClick' }, 'B')).toBe(true);
    expect(belongsToWorkspace({ workspaceKey: null }, null)).toBe(true);
  });

  it('records both targets independently and reads the legacy single-target format', () => {
    const provenance = normalizeExpandModeProvenance({ global: {} });
    // 第二個 target 尚無 provenance 時仍可記錄；既有 global 記錄不會阻止 workspace 記錄。
    expect(provenance.global).toEqual({ previous: undefined });
    expect(provenance.workspace).toBeUndefined();
    if (shouldRecordProvenance('singleClick') && provenance.workspace === undefined) {
      provenance.workspace = { previous: 'singleClick' };
    }
    expect(resolveExpandModeRestore({ target: 'global', previous: provenance.global!.previous })).toEqual({ target: 'global', value: undefined });
    expect(resolveExpandModeRestore({ target: 'workspace', previous: provenance.workspace!.previous })).toEqual({ target: 'workspace', value: 'singleClick' });
    expect(normalizeExpandModeProvenance({ target: 'workspace', previous: 'singleClick' })).toEqual({ workspace: { previous: 'singleClick' } });
  });
});
