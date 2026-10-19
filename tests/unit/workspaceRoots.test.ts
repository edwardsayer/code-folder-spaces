import { describe, expect, it } from 'vitest';
import { visibleWorkspaceRoots } from '../../src/spaces/workspaceRoots';

describe('visibleWorkspaceRoots', () => {
  it('returns all roots when none are hidden', () => {
    expect(visibleWorkspaceRoots(['/one', '/two'], [])).toEqual(['/one', '/two']);
  });

  it('filters partially hidden roots', () => {
    expect(visibleWorkspaceRoots(['/one', '/two'], ['/one'])).toEqual(['/two']);
  });

  it('returns an empty list when all roots are hidden', () => {
    expect(visibleWorkspaceRoots(['/one'], ['/one'])).toEqual([]);
  });

  it('ignores hidden paths absent from all roots', () => {
    expect(visibleWorkspaceRoots(['/one'], ['/missing'])).toEqual(['/one']);
  });

  it('compares Windows paths without case sensitivity', () => {
    const actual = visibleWorkspaceRoots(['C:\\Work\\Project'], ['c:\\work\\project']);
    expect(actual).toEqual(process.platform === 'win32' ? [] : ['C:\\Work\\Project']);
  });
});
