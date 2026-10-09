import { describe, expect, it } from 'vitest';
import { canModifyFiles, isSafeMove, isValidEntryName, UndoStack, uniqueEntryName } from '../../src/spaces/spaceActions';

describe('spaceActions file operations', () => {
  it('validates single-segment names', () => {
    expect(isValidEntryName('ok.txt')).toBe(true);
    for (const name of ['', '.', '..', 'a/b', 'a\\b', ' padded ']) expect(isValidEntryName(name)).toBe(false);
  });

  it('finds a unique suffixed name without losing extension', () => {
    const taken = new Set(['note.md', 'note 1.md']);
    expect(uniqueEntryName('note.md', name => taken.has(name))).toBe('note 2.md');
    expect(uniqueEntryName('fresh', name => taken.has(name))).toBe('fresh');
  });

  it('rejects directory moves into itself or descendants', () => {
    expect(isSafeMove('/space/dir', '/space', true)).toBe(true);
    expect(isSafeMove('/space/dir', '/space/dir', true)).toBe(false);
    expect(isSafeMove('/space/dir', '/space/dir/child', true)).toBe(false);
    expect(isSafeMove('/space/dir/file', '/space/dir/child', false)).toBe(true);
  });

  it('bounds undo history and pops newest move/rename records', () => {
    const stack = new UndoStack();
    for (let index = 0; index < 22; index++) stack.push({ kind: index % 2 ? 'move' : 'rename', from: `s${index}`, to: `t${index}` });
    expect(stack.size).toBe(20);
    expect(stack.peek()?.to).toBe('t21');
    expect(stack.pop()?.from).toBe('s21');
    expect(stack.size).toBe(19);
  });

  it('allows disk mutations only when trusted', () => {
    expect(canModifyFiles(true)).toBe(true);
    expect(canModifyFiles(false)).toBe(false);
  });
});
