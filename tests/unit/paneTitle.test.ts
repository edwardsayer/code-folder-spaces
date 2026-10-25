import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { computePaneTitleAndHint } from '../../src/spaces/paneTitle';

describe('computePaneTitleAndHint（v22-R1 使用者設計）', () => {
  it('Tree 模式：viewTitle 為 undefined（維持 Folder Spaces），hint 設為完整路徑', () => {
    const rootPath = path.resolve('/repo/project');
    const res = computePaneTitleAndHint({
      mode: 'tree',
      roots: [rootPath],
      drillRoot: null,
      hasDrillStack: false,
    });
    expect(res.viewTitle).toBeUndefined();
    expect(res.displayName).toBe('Folder Spaces');
    expect(res.hint).toBe(rootPath);
  });

  it('Tree 模式下鑽時：viewTitle 仍為 undefined（維持 Folder Spaces），hint 更新為下鑽完整路徑', () => {
    const rootPath = path.resolve('/repo/project');
    const drill = path.resolve('/repo/project/src/sub');
    const res = computePaneTitleAndHint({
      mode: 'tree',
      roots: [rootPath],
      drillRoot: drill,
      hasDrillStack: true,
    });
    expect(res.viewTitle).toBeUndefined();
    expect(res.displayName).toBe('Folder Spaces');
    expect(res.hint).toBe(drill);
  });

  it('Dual 模式：viewTitle 設為路徑最後一段，hint 設為完整路徑', () => {
    const rootPath = path.resolve('/repo/my-project');
    const res = computePaneTitleAndHint({
      mode: 'dual',
      roots: [rootPath],
      drillRoot: null,
      hasDrillStack: false,
    });
    expect(res.viewTitle).toBe('my-project');
    expect(res.hint).toBe(rootPath);
  });

  it('Dual 模式多 root：pane1 名稱簡化為 Spaces', () => {
    const rootA = path.resolve('/repo/project-a');
    const rootB = path.resolve('/repo/project-b');
    const res = computePaneTitleAndHint({
      mode: 'dual',
      roots: [rootA, rootB],
      drillRoot: null,
      hasDrillStack: false,
    });
    expect(res.viewTitle).toBe('Spaces');
    expect(res.displayName).toBe('Spaces');
    expect(res.hint).toBe(`${rootA}\n${rootB}`);
  });

  it('Dual 模式下鑽時：viewTitle 設為下鑽路徑最後一段，hint 設為下鑽完整路徑', () => {
    const rootPath = path.resolve('/repo/my-project');
    const drill = path.resolve('/repo/my-project/assets/icons');
    const res = computePaneTitleAndHint({
      mode: 'dual',
      roots: [rootPath],
      drillRoot: drill,
      hasDrillStack: true,
    });
    expect(res.viewTitle).toBe('icons');
    expect(res.hint).toBe(drill);
  });

  it('沒有 root：兩種模式都回 Spaces，hint 為空字串', () => {
    for (const mode of ['tree', 'dual'] as const) {
      const res = computePaneTitleAndHint({ mode, roots: [], drillRoot: null, hasDrillStack: false });
      expect(res.hint).toBe('');
      expect(res.viewTitle).toBe(mode === 'tree' ? undefined : 'Spaces');
      expect(res.displayName).toBe(mode === 'tree' ? 'Folder Spaces' : 'Spaces');
    }
  });

  it('單一 root 且命中 space 定義時，Dual 標題優先使用 space 名稱', () => {
    const rootPath = path.resolve('/repo/my-project');
    const res = computePaneTitleAndHint({
      mode: 'dual',
      roots: [rootPath],
      drillRoot: null,
      hasDrillStack: false,
      definitionName: 'Notes',
    });
    expect(res.viewTitle).toBe('Notes');
    expect(res.hint).toBe(rootPath);
  });

  it('Dual 多 root 下鑽時：忽略多 root 的 Spaces 簡化，取下鑽目錄名', () => {
    const rootA = path.resolve('/repo/project-a');
    const rootB = path.resolve('/repo/project-b');
    const drill = path.join(rootA, 'src');
    const res = computePaneTitleAndHint({
      mode: 'dual',
      roots: [rootA, rootB],
      drillRoot: drill,
      hasDrillStack: true,
    });
    expect(res.viewTitle).toBe('src');
    expect(res.hint).toBe(drill);
  });

  it('drillRoot 存在但 drillStack 為空時不視為下鑽（避免殘留狀態污染標題）', () => {
    const rootPath = path.resolve('/repo/project');
    const res = computePaneTitleAndHint({
      mode: 'dual',
      roots: [rootPath],
      drillRoot: path.join(rootPath, 'ghost'),
      hasDrillStack: false,
    });
    expect(res.viewTitle).toBe('project');
    expect(res.hint).toBe(rootPath);
  });
});
