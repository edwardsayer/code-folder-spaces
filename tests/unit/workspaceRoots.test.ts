import { describe, expect, it } from 'vitest';
import { mergeFollowedWorkspaceRoots, visibleWorkspaceRoots } from '../../src/spaces/workspaceRoots';

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

describe('mergeFollowedWorkspaceRoots（OP-15 Follow Workspace Directory，v2.1 修正）', () => {
  it('keeps a configured root (e.g. Mark as Global) when the workspace switches', () => {
    expect(mergeFollowedWorkspaceRoots(['C:\work\a', 'C:\notes'], ['C:\work\b'], ['C:\notes']))
      .toEqual(['C:\work\b', 'C:\notes']);
  });

  it('drops a stale workspace root that is no longer configured nor visible', () => {
    expect(mergeFollowedWorkspaceRoots(['C:\work\a', 'C:\notes'], ['C:\work\b'], ['C:\notes']))
      .not.toContain('C:\work\a');
  });

  it('does not duplicate a configured root that is also a visible workspace root', () => {
    expect(mergeFollowedWorkspaceRoots(['C:\work\a'], ['C:\work\a'], ['C:\work\a']))
      .toEqual(['C:\work\a']);
  });

  it('orders visible roots first, then keeps existing configured roots in their current order', () => {
    expect(mergeFollowedWorkspaceRoots(['C:\notes2', 'C:\notes1'], ['C:\work'], ['C:\notes1', 'C:\notes2']))
      .toEqual(['C:\work', 'C:\notes2', 'C:\notes1']);
  });

  it('adds a configured root that the current pane does not have yet (other project)', () => {
    expect(mergeFollowedWorkspaceRoots(['C:\work\a'], ['C:\work\b'], ['C:\notes']))
      .toEqual(['C:\work\b', 'C:\notes']);
  });

  it('appends newly configured roots in configuration order', () => {
    expect(mergeFollowedWorkspaceRoots([], ['C:\work'], ['C:\notes2', 'C:\notes1']))
      .toEqual(['C:\work', 'C:\notes2', 'C:\notes1']);
  });

  it('drops roots when the workspace has no configured roots left', () => {
    expect(mergeFollowedWorkspaceRoots(['C:\work\a'], ['C:\work\b'], []))
      .toEqual(['C:\work\b']);
  });
});
