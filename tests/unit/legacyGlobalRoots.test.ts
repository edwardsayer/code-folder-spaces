import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  legacyGlobalRootsExists,
  parseLegacyGlobalRoots,
  readLegacyGlobalRoots,
  resolveLegacyGlobalRootsPath,
  retireLegacyGlobalRoots,
} from '../../src/spaces/legacyGlobalRoots';

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-legacy-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('舊 global roots 檔案（一次性遷移後退役）', () => {
  it('路徑固定在家目錄下，可用環境變數覆寫', () => {
    const fallback = resolveLegacyGlobalRootsPath('C:/Users/me');
    expect(fallback.endsWith('global-roots.json')).toBe(true);
    process.env.CODEFOLDERSPACES_LEGACY_GLOBAL_ROOTS = 'D:/tmp/custom.json';
    expect(resolveLegacyGlobalRootsPath()).toBe(path.resolve('D:/tmp/custom.json'));
    delete process.env.CODEFOLDERSPACES_LEGACY_GLOBAL_ROOTS;
  });

  it('寬鬆解析：接受 {version, roots} 或最外層陣列', () => {
    expect(parseLegacyGlobalRoots('{"version":1,"roots":["D:/notes",{"path":"D:/work","name":"Work"}]}'))
      .toEqual(['D:/notes', { path: 'D:/work', name: 'Work' }]);
    expect(parseLegacyGlobalRoots('["D:/a"]')).toEqual(['D:/a']);
  });

  it('壞檔／空檔／非陣列一律回空清單，不得讓壞檔影響啟動', () => {
    expect(parseLegacyGlobalRoots(undefined)).toEqual([]);
    expect(parseLegacyGlobalRoots('')).toEqual([]);
    expect(parseLegacyGlobalRoots('{oops')).toEqual([]);
    expect(parseLegacyGlobalRoots('{"roots":"nope"}')).toEqual([]);
    expect(parseLegacyGlobalRoots('[{"name":"no-path"}, 42, ""]')).toEqual([]);
  });

  it('readLegacyGlobalRoots 對不存在或壞檔回空清單', () => {
    const dir = makeDir();
    expect(readLegacyGlobalRoots(path.join(dir, 'missing.json'))).toEqual([]);
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{not json');
    expect(readLegacyGlobalRoots(broken)).toEqual([]);
  });

  it('retireLegacyGlobalRoots 改名為 *.migrated.json 並保留內容', () => {
    const dir = makeDir();
    const file = path.join(dir, 'global-roots.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, roots: ['D:/notes'] }));
    const retired = retireLegacyGlobalRoots(file);
    expect(retired).toBe(path.join(dir, 'global-roots.migrated.json'));
    expect(fs.existsSync(file)).toBe(false);
    expect(JSON.parse(fs.readFileSync(retired!, 'utf8')).roots).toEqual(['D:/notes']);
  });

  it('重複退役不拋錯（檔案已不存在回 undefined）', () => {
    const dir = makeDir();
    expect(retireLegacyGlobalRoots(path.join(dir, 'nope.json'))).toBeUndefined();
  });

  it('既有備份不被覆寫：目標已存在時改存時間戳檔名', () => {
    const dir = makeDir();
    const file = path.join(dir, 'global-roots.json');
    const previous = path.join(dir, 'global-roots.migrated.json');
    fs.writeFileSync(previous, JSON.stringify({ version: 1, roots: ['D:/old'] }));
    fs.writeFileSync(file, JSON.stringify({ version: 1, roots: ['D:/new'] }));
    const retired = retireLegacyGlobalRoots(file);
    expect(retired).not.toBe(previous);
    expect(retired).toMatch(/global-roots\.migrated-.+\.json$/);
    expect(JSON.parse(fs.readFileSync(previous, 'utf8')).roots).toEqual(['D:/old']);
    expect(JSON.parse(fs.readFileSync(retired!, 'utf8')).roots).toEqual(['D:/new']);
  });

  it('legacyGlobalRootsExists 只對既有檔案回 true（空檔也算存在）', () => {
    const dir = makeDir();
    const empty = path.join(dir, 'empty.json');
    expect(legacyGlobalRootsExists(empty)).toBe(false);
    fs.writeFileSync(empty, '');
    expect(legacyGlobalRootsExists(empty)).toBe(true);
  });
});
