import { describe, expect, it } from 'vitest';
import type { SpaceDefinition } from '../../src/types';
import { mergeSpaceDefinitions } from '../../src/spaces/spaceConfig';

function definition(basePath: string, name: string, origin: 'workspace' | 'global' = 'workspace'): SpaceDefinition {
  return { basePath, name, showFiles: true, include: [], exclude: [], sourceIndex: 0, origin };
}

describe('mergeSpaceDefinitions', () => {
  it('returns an empty array when both sources are empty', () => {
    expect(mergeSpaceDefinitions([], [])).toEqual([]);
  });

  it('keeps workspace entries first and preserves each source order', () => {
    const ws1 = definition('/ws/one', 'ws1');
    const ws2 = definition('/ws/two', 'ws2');
    const g1 = definition('/global/one', 'g1', 'global');
    const g2 = definition('/global/two', 'g2', 'global');
    expect(mergeSpaceDefinitions([ws1, ws2], [g1, g2])).toEqual([ws1, ws2, g1, g2]);
  });

  it('prefers workspace when both sources contain the same normalized path', () => {
    const workspace = definition('/shared/path', 'workspace copy', 'workspace');
    const global = definition('/shared/./path', 'global copy', 'global');
    expect(mergeSpaceDefinitions([workspace], [global])).toEqual([workspace]);
    expect(mergeSpaceDefinitions([workspace], [global])[0].origin).toBe('workspace');
  });

  it('compares Windows paths case-insensitively', () => {
    const upper = definition('C:\\A', 'upper', 'workspace');
    const lower = definition('c:\\a', 'lower', 'global');
    const merged = mergeSpaceDefinitions([upper], [lower]);
    expect(merged).toHaveLength(process.platform === 'win32' ? 1 : 2);
    if (process.platform === 'win32') {
      expect(merged[0].origin).toBe('workspace');
    }
  });

  it('keeps different paths even when their basenames match', () => {
    const first = definition('/first/shared', 'shared');
    const second = definition('/second/shared', 'shared', 'global');
    expect(mergeSpaceDefinitions([first], [second])).toEqual([first, second]);
  });
});
