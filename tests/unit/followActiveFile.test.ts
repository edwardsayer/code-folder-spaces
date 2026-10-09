import { describe, expect, it } from 'vitest';
import { resolveActiveTabUri, shouldFollowActiveFile } from '../../src/spaces/followActiveFile';

describe('follow active file', () => {
  it.each([
    ['text', { scheme: 'file', path: '/a' }],
    ['custom', { scheme: 'file', path: '/b' }],
    ['notebook', { scheme: 'file', path: '/c' }],
  ] as const)('resolves %s tab URI', (kind, uri) => {
    expect(resolveActiveTabUri({ kind, uri })).toBe(uri);
  });

  it.each(['text-diff', 'notebook-diff'] as const)('resolves the modified URI for %s', (kind) => {
    const original = { scheme: 'file', path: '/original' };
    const modified = { scheme: 'file', path: '/modified' };
    expect(resolveActiveTabUri({ kind, modified })).toBe(modified);
    expect(resolveActiveTabUri({ kind, modified: { scheme: 'untitled', path: '/modified' } })).toBeUndefined();
    expect(original.path).not.toBe(modified.path);
  });

  it('rejects non-file and unsupported tabs', () => {
    expect(resolveActiveTabUri({ kind: 'text', uri: { scheme: 'untitled' } })).toBeUndefined();
    expect(resolveActiveTabUri({ kind: 'other' })).toBeUndefined();
    expect(resolveActiveTabUri(undefined)).toBeUndefined();
  });

  it('follows only when enabled, visible, and the generation is current', () => {
    const ready = { enabled: true, visible: true, generation: 3, currentGeneration: 3 };
    expect(shouldFollowActiveFile(ready)).toBe(true);
    expect(shouldFollowActiveFile({ ...ready, generation: 2 })).toBe(false);
    expect(shouldFollowActiveFile({ ...ready, visible: false })).toBe(false);
    expect(shouldFollowActiveFile({ ...ready, enabled: false })).toBe(false);
  });
});
