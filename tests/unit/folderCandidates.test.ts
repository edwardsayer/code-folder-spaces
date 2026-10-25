import { describe, expect, it } from 'vitest';
import path from 'path';
import { collectCandidateFolders, isStrictSubdirectory } from '../../src/spaces/folderCandidates';

describe('folderCandidates', () => {
  describe('isStrictSubdirectory', () => {
    it('正確認定子目錄與自身/外部', () => {
      const parent = path.resolve('/repo/project');
      const child = path.resolve('/repo/project/src/sub');
      const sibling = path.resolve('/repo/other');

      expect(isStrictSubdirectory(child, parent)).toBe(true);
      expect(isStrictSubdirectory(parent, parent)).toBe(false);
      expect(isStrictSubdirectory(sibling, parent)).toBe(false);
      expect(isStrictSubdirectory(path.dirname(parent), parent)).toBe(false);
    });
  });

  describe('collectCandidateFolders', () => {
    it('納入非 global root 的父層路徑，排除 global root 的父層', () => {
      const wsRoot = path.resolve('/repo/app');
      const globalRoot = path.resolve('/external/shared');

      const candidates = collectCandidateFolders({
        currentRoots: [wsRoot, globalRoot],
        globalRoots: [globalRoot],
        workspaceFolders: [wsRoot],
        recentFolders: [],
      });

      // wsRoot 的父層是 /repo，且不是 global
      expect(candidates).toContain(path.dirname(wsRoot));
      // globalRoot 的父層不應納入
      expect(candidates).not.toContain(path.dirname(globalRoot));
      // 當前 roots 自身不應在候選中
      expect(candidates).not.toContain(wsRoot);
      expect(candidates).not.toContain(globalRoot);
    });

    it('納入最近開啟的資料夾，並去重', () => {
      const wsRoot = path.resolve('/repo/app');
      const recentA = path.resolve('/workspace/other1');
      const recentB = path.resolve('/workspace/other2');

      const candidates = collectCandidateFolders({
        currentRoots: [wsRoot],
        globalRoots: [],
        workspaceFolders: [wsRoot],
        recentFolders: [recentA, recentB, recentA], // 重複項目
      });

      expect(candidates).toContain(recentA);
      expect(candidates).toContain(recentB);
      // 去重檢查
      expect(candidates.filter(c => c === recentA).length).toBe(1);
    });

    it('不秀當前 workspace 的子目錄', () => {
      const wsRoot = path.resolve('/repo/app');
      const subDir = path.resolve('/repo/app/src/components');
      const otherWs = path.resolve('/other/proj');

      const candidates = collectCandidateFolders({
        currentRoots: [wsRoot],
        globalRoots: [],
        workspaceFolders: [wsRoot],
        recentFolders: [subDir, otherWs],
      });

      // subDir 是 wsRoot 的子目錄，必須被排除
      expect(candidates).not.toContain(subDir);
      expect(candidates).toContain(otherWs);
    });

    it('排除任意 current root 之下的子目錄（不限 workspace folder）', () => {
      // v22-R1 gate C2：非 workspace folder 的 root 也套用同一排除規則；子目錄請用 Drill Into Folder。
      const wsRoot = path.resolve('/repo/app');
      const externalRoot = path.resolve('/external/proj');
      const externalSub = path.resolve('/external/proj/src');

      const candidates = collectCandidateFolders({
        currentRoots: [wsRoot, externalRoot],
        globalRoots: [],
        workspaceFolders: [wsRoot],
        recentFolders: [externalSub],
      });

      expect(candidates).not.toContain(externalSub);
    });

    it('排除已在 currentRoots 的路徑', () => {
      const wsRoot = path.resolve('/repo/app');
      const parent = path.dirname(wsRoot);

      const candidates = collectCandidateFolders({
        currentRoots: [wsRoot, parent], // parent 本身已經是 currentRoot
        globalRoots: [],
        workspaceFolders: [wsRoot],
        recentFolders: [parent],
      });

      expect(candidates).not.toContain(parent);
      expect(candidates).not.toContain(wsRoot);
    });
  });
});
