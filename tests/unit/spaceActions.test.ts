import { describe, expect, it } from 'vitest';
import { isCrossSpaceMove, isSafeMove, isSamePath, isValidEntryName, resolveDropTarget, resolveOpenBeside, resolvePasteTarget, SpaceClipboard, UndoStack, uniqueEntryName } from '../../src/spaces/spaceActions';

describe('spaceActions file operations', () => {
  it('validates single-segment names', () => {
    expect(isValidEntryName('ok.txt')).toBe(true);
    for (const name of ['', '.', '..', 'a/b', 'a\\b', ' padded ']) expect(isValidEntryName(name)).toBe(false);
  });

  it('rejects Windows-invalid and reserved names only on Windows', () => {
    for (const name of ['a*.txt', 'a?.txt', 'a".txt', 'a<.txt', 'a>.txt', 'a|.txt', 'a:.txt', 'name.', 'CON', 'con.txt', 'PRN.log', 'AUX', 'NUL', 'COM1.txt', 'com9', 'LPT1', 'lpt9.txt']) {
      expect(isValidEntryName(name, 'win32'), name).toBe(false);
      expect(isValidEntryName(name, 'linux'), name).toBe(true);
    }
  });

  it('resolves root and folder drop targets but ignores files and blank space', () => {
    expect(resolveDropTarget({ path: '/space', isDirectory: true, isRoot: true })).toBe('/space');
    expect(resolveDropTarget({ path: '/space/folder', isDirectory: true })).toBe('/space/folder');
    expect(resolveDropTarget({ path: '/space/file.txt', isDirectory: false })).toBeUndefined();
    expect(resolveDropTarget(undefined)).toBeUndefined();
  });

  it('resolves paste destinations from roots, folders, and files', () => {
    expect(resolvePasteTarget({ path: '/space', isDirectory: true, isRoot: true })).toBe('/space');
    expect(resolvePasteTarget({ path: '/space/folder', isDirectory: true })).toBe('/space/folder');
    expect(resolvePasteTarget({ path: '/space/folder/file.txt', isDirectory: false })).toBe('/space/folder');
    expect(resolvePasteTarget(undefined)).toBeUndefined();
  });

  it('allows moves across distinct configured space roots', () => {
    expect(isCrossSpaceMove('/space/a', '/space/b')).toBe(true);
    expect(isCrossSpaceMove('/space/a', '/space/a')).toBe(false);
  });

  it('finds a unique suffixed name without losing extension', () => {
    const taken = new Set(['note.md', 'note 1.md']);
    expect(uniqueEntryName('note.md', name => taken.has(name))).toBe('note 2.md');
    expect(uniqueEntryName('fresh', name => taken.has(name))).toBe('fresh');
  });

  it('compares Windows paths case-insensitively for rename collision checks', () => {
    expect(isSamePath('C:\\Space\\Dir', 'c:\\space\\dir', 'win32')).toBe(true);
    expect(isSamePath('C:\\Space\\Dir', 'C:\\Space\\Other', 'win32')).toBe(false);
    expect(isSamePath('/space/Dir', '/space/dir', 'linux')).toBe(false);
  });

  it('rejects directory moves into itself or descendants', () => {
    expect(isSafeMove('/space/dir', '/space', true)).toBe(true);
    expect(isSafeMove('/space/dir', '/space/dir', true)).toBe(false);
    expect(isSafeMove('/space/dir', '/space/dir/child', true)).toBe(false);
    expect(isSafeMove('/space/dir/file', '/space/dir/child', false)).toBe(true);
  });

  it('keeps copy and cut clipboard state in memory and consumes successful cuts individually', () => {
    const clipboard = new SpaceClipboard();
    clipboard.set(['file:///a', 'file:///b', 'file:///a'], 'cut');
    expect(clipboard.get()).toEqual({ uris: ['file:///a', 'file:///b'], mode: 'cut' });
    clipboard.consume('file:///a');
    expect(clipboard.get()).toEqual({ uris: ['file:///b'], mode: 'cut' });
    clipboard.set(['file:///copy'], 'copy');
    clipboard.consume('file:///copy');
    expect(clipboard.get()).toEqual({ uris: ['file:///copy'], mode: 'copy' });
    clipboard.set([], 'cut');
    expect(clipboard.get()).toBeUndefined();
  });

  it('defaults file opening to the current editor group and selects beside only explicitly', () => {
    expect(resolveOpenBeside(undefined)).toBe(false);
    expect(resolveOpenBeside('current')).toBe(false);
    expect(resolveOpenBeside('beside')).toBe(true);
  });

  it('bounds undo history and pops newest move/rename records', () => {
    const stack = new UndoStack();
    for (let index = 0; index < 22; index++) stack.push({ kind: index % 2 ? 'move' : 'rename', from: `s${index}`, to: `t${index}` });
    expect(stack.size).toBe(20);
    expect(stack.peek()?.to).toBe('t21');
    expect(stack.pop()?.from).toBe('s21');
    expect(stack.size).toBe(19);
  });

});
