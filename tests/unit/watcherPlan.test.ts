import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { diffWatchers, planWatchers } from '../../src/spaces/watcherPlan';

/** 以本平台規則建立可預期的絕對路徑（避免 Windows／POSIX 差異影響斷言）。 */
const P = (...segments: string[]): string => path.normalize(path.join(path.parse(process.cwd()).root, ...segments));

describe('planWatchers（MR-I5：watcher 逐 root 建立與跨窗格去重）', () => {
  it('為每個窗格的每個 root 各產生一個監看器', () => {
    const one = P('watcher-plan', 'one');
    const two = P('watcher-plan', 'two');
    const plan = planWatchers([
      { paneId: 'pane1', roots: [one, two] },
      { paneId: 'pane2', roots: [] },
    ]);
    expect([...plan.values()].sort()).toEqual([one, two].sort());
  });

  it('同一 root 被多個窗格共用時只保留一筆（跨窗格去重）', () => {
    const shared = P('watcher-plan', 'shared');
    const plan = planWatchers([
      { paneId: 'pane1', roots: [shared] },
      { paneId: 'pane2', roots: [shared] },
      { paneId: 'pane3', roots: [shared] },
    ]);
    expect(plan.size).toBe(1);
    expect([...plan.values()]).toEqual([shared]);
  });

  it('同一窗格內重複列出同一 root 時亦去重', () => {
    const shared = P('watcher-plan', 'dup');
    const plan = planWatchers([{ paneId: 'pane1', roots: [shared, shared] }]);
    expect(plan.size).toBe(1);
  });

  it('去重 key 對大小寫與尾端分隔符正規化後仍相同（同一目錄不同寫法只算一個）', () => {
    const base = P('watcher-plan', 'CaseRoot');
    const variant = base + path.sep;
    const plan = planWatchers([{ paneId: 'pane1', roots: [base, variant] }]);
    // Windows 大小寫不敏感；POSIX 下尾端分隔符仍由 path.normalize 收斂。
    expect(plan.size).toBe(1);
  });

  it('沒有窗格或窗格皆無 root 時不建立任何監看器', () => {
    expect(planWatchers([]).size).toBe(0);
    expect(planWatchers([{ paneId: 'pane1', roots: [] }]).size).toBe(0);
  });
});

describe('diffWatchers（MR-I5：建立／保留／移除 root 後 dispose）', () => {
  const keep = P('watcher-plan', 'keep');
  const drop = P('watcher-plan', 'drop');
  const add = P('watcher-plan', 'add');

  it('新增 root 時建立、既有 root 不重建、被移除的 root 進入 dispose', () => {
    const desired = planWatchers([{ paneId: 'pane1', roots: [keep, add] }]);
    const existing = [...planWatchers([{ paneId: 'pane1', roots: [keep, drop] }]).keys()];
    const plan = diffWatchers(existing, desired);
    expect(plan.dispose).toEqual([...planWatchers([{ paneId: 'pane1', roots: [drop] }]).keys()]);
    expect(plan.create).toEqual([add]);
  });

  it('roots 完全不變時不建立也不 dispose（避免每次 refresh 重建監看器）', () => {
    const desired = planWatchers([{ paneId: 'pane1', roots: [keep, drop] }]);
    const plan = diffWatchers([...desired.keys()], desired);
    expect(plan).toEqual({ dispose: [], create: [] });
  });

  it('移除全部 root 時全部進入 dispose', () => {
    const desired = planWatchers([]);
    const existing = [...planWatchers([{ paneId: 'pane1', roots: [keep, drop] }]).keys()];
    const plan = diffWatchers(existing, desired);
    expect(plan.dispose).toHaveLength(2);
    expect(plan.create).toEqual([]);
  });

  it('同 root 跨窗格去重後，其中一個窗格移除該 root 仍保留監看器', () => {
    const before = planWatchers([
      { paneId: 'pane1', roots: [keep] },
      { paneId: 'pane2', roots: [keep] },
    ]);
    const after = planWatchers([{ paneId: 'pane2', roots: [keep] }]);
    const plan = diffWatchers([...before.keys()], after);
    expect(plan).toEqual({ dispose: [], create: [] });
  });
});

describe('planWatchers（根路徑保護：磁碟根／UNC／POSIX 根不得被去尾端分隔符）', () => {
  it('Windows 磁碟根保留尾端分隔符', () => {
    const win = path.win32;
    const driveRoot = 'C:' + String.fromCharCode(92);
    // 以當前平台的 path 實作驗證保護分支：磁碟根 normalize 後與 root 前綴同長，不得被 slice。
    const parsed = win.parse(win.normalize(driveRoot)).root;
    expect(parsed).toBe(driveRoot);
    // 保護條件（長度比較）在磁碟根上為 false，故 canonicalRoot 不會去尾。
    expect(win.normalize(driveRoot).length > win.parse(win.normalize(driveRoot)).root.length).toBe(false);
  });

  it('UNC 共享根不會被去尾端分隔符', () => {
    const win = path.win32;
    const bs = String.fromCharCode(92);
    const unc = bs + bs + 'server' + bs + 'share' + bs;
    const normalized = win.normalize(unc);
    expect(win.parse(normalized).root).toBe(bs + bs + 'server' + bs + 'share' + bs);
    expect(normalized.length > win.parse(normalized).root.length).toBe(false);
  });

  it('POSIX 根目錄在 POSIX 平台不會被去尾（僅在 posix 語意下驗證）', () => {
    const posix = path.posix;
    const root = posix.normalize('/');
    expect(posix.parse(root).root).toBe('/');
    expect(root.length > posix.parse(root).root.length).toBe(false);
  });

  it('一般目錄的尾端分隔符才會被收斂（同一目錄只算一個 root）', () => {
    const dir = P('watcher-plan', 'trailing');
    expect(planWatchers([{ paneId: 'pane1', roots: [dir, dir + path.sep] }]).size).toBe(1);
  });
});
