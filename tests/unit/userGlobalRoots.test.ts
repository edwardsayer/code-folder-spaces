import { describe, expect, it } from 'vitest';
import { mergeUserGlobalRoots, parseUserGlobalRoots, resolveUserGlobalRootsPath, serializeUserGlobalRoots } from '../../src/spaces/userGlobalRoots';

describe('使用者層級 global roots（跨 profile／跨專案）', () => {
  it('檔案位於使用者家目錄下的固定路徑', () => {
    const filePath = resolveUserGlobalRootsPath('C:/Users/me');
    expect(filePath.endsWith('global-roots.json')).toBe(true);
    expect(filePath).toContain('.code-folder-spaces');
  });

  it('寬鬆解析：接受 {version, roots} 或最外層陣列', () => {
    expect(parseUserGlobalRoots('{"version":1,"roots":["D:/notes",{"path":"D:/work","name":"Work"}]}'))
      .toEqual(['D:/notes', { path: 'D:/work', name: 'Work' }]);
    expect(parseUserGlobalRoots('["D:/a"]')).toEqual(['D:/a']);
  });

  it('壞檔／空檔／非陣列一律回空清單（不讓壞檔壞掉啟動）', () => {
    expect(parseUserGlobalRoots(undefined)).toEqual([]);
    expect(parseUserGlobalRoots('')).toEqual([]);
    expect(parseUserGlobalRoots('{oops')).toEqual([]);
    expect(parseUserGlobalRoots('{"roots":"nope"}')).toEqual([]);
    expect(parseUserGlobalRoots('[{"name":"no-path"}, 42, ""]')).toEqual([]);
  });

  it('序列化後可被解析回相同內容，且帶 version', () => {
    const entries = ['D:/notes', { path: 'D:/work' }] as const;
    const text = serializeUserGlobalRoots(entries);
    expect(JSON.parse(text).version).toBe(1);
    expect(parseUserGlobalRoots(text)).toEqual([...entries]);
  });

  it('合併舊設定與檔案：設定優先、同一路徑只留一筆（Windows 不分大小寫）', () => {
    const merged = mergeUserGlobalRoots(
      ['C:/Notes'],
      ['c:/notes', 'D:/work', 'D:/work'],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe('C:/Notes');
    expect(merged[1]).toBe('D:/work');
  });

  it('兩邊都空時回空清單', () => {
    expect(mergeUserGlobalRoots([], [])).toEqual([]);
  });
});
