import { describe, expect, it } from 'vitest';
import {
  defaultDirectoryCacheLimits,
  DirectoryCache,
  type DirectoryCacheLimits,
  type DirectoryEntry,
} from '../../src/spaces/directoryCache';

interface Gate {
  uri: string;
  resolve: (entries: DirectoryEntry[]) => void;
  reject: (error: unknown) => void;
}

/** 建立可手動控制完成時機的 mock readDirectory：每次呼叫推入一個 deferred gate。 */
function createHarness(options: { limits?: Partial<DirectoryCacheLimits> } = {}) {
  let now = 1_000_000;
  const gates: Gate[] = [];
  const readDirectory = (uri: string): Promise<DirectoryEntry[]> => {
    let resolve!: (entries: DirectoryEntry[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<DirectoryEntry[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    gates.push({ uri, resolve: resolve!, reject: reject! });
    return promise;
  };
  const revalidated: string[] = [];
  const stored: string[] = [];
  const errors: Array<{ uri: string; error: unknown }> = [];
  const cache = new DirectoryCache({
    readDirectory,
    clock: () => now,
    onDidRevalidate: uri => revalidated.push(uri),
    onDidStore: uri => stored.push(uri),
    onError: (uri, error) => errors.push({ uri, error }),
    limits: options.limits,
  });
  return {
    cache,
    gates,
    revalidated,
    stored,
    errors,
    advance: (ms: number) => {
      now += ms;
    },
    /** 解析最後一個 gate。 */
    settle: (index: number, entries: DirectoryEntry[]) => gates[index].resolve(entries),
  };
}

const dir = 'file:///ws/a';
const other = 'file:///ws/b';

describe('DirectoryCache 預設界線', () => {
  it('反映 S4R7-D81 的數字界線', () => {
    expect(defaultDirectoryCacheLimits).toEqual({
      maxDirectories: 512,
      maxTotalEntries: 20_000,
      maxEntriesPerDirectory: 2_000,
      memoryTtlMs: 2_000,
      maxSnapshotBytes: 1024 * 1024,
      maxSnapshotAgeMs: 24 * 60 * 60 * 1000,
    });
  });

  it('拒絕非正整數的 limits', () => {
    expect(() => new DirectoryCache({ readDirectory: async () => [], limits: { maxDirectories: 0 } })).toThrow(RangeError);
    expect(() => new DirectoryCache({ readDirectory: async () => [], limits: { memoryTtlMs: 1.5 } })).toThrow(RangeError);
  });
});

describe('pending 去重與 TTL', () => {
  it('同代同 URI 的併發 read 共用一個請求，且各自取得獨立副本', async () => {
    const h = createHarness();
    const first = h.cache.read(dir);
    const second = h.cache.read(dir);
    expect(h.gates.length).toBe(1);
    h.gates[0].resolve([['x.ts', 1]]);
    const a = await first;
    const b = await second;
    expect(a).toEqual([['x.ts', 1]]);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b[0]).not.toBe(a[0]);
  });

  it('TTL 內共用新鮮記憶體，TTL 後重新讀取', async () => {
    const h = createHarness();
    const p1 = h.cache.read(dir);
    h.gates[0].resolve([['a', 1]]);
    expect(await p1).toEqual([['a', 1]]);

    h.advance(defaultDirectoryCacheLimits.memoryTtlMs - 1);
    const p2 = h.cache.read(dir);
    expect(h.gates.length).toBe(1); // 未再打來源
    expect(await p2).toEqual([['a', 1]]);

    h.advance(1); // 總齡 = TTL → 不再新鮮
    const p3 = h.cache.read(dir);
    expect(h.gates.length).toBe(2);
    h.gates[1].resolve([['b', 1]]);
    expect(await p3).toEqual([['b', 1]]);
  });

  it('回傳副本不被呼叫端改動污染', async () => {
    const h = createHarness();
    const p = h.cache.read(dir);
    const payload: DirectoryEntry[] = [['a', 1]];
    h.gates[0].resolve(payload);
    const result = await p;
    result[0][0] = 'mutated';
    result.push(['injected', 1]);
    payload[0][1] = 99;
    const again = await h.cache.read(dir);
    expect(again).toEqual([['a', 1]]);
  });
});

describe('LRU 與容量界線', () => {
  it('目錄數超過上限時淘汰最舊的目錄', async () => {
    const h = createHarness({ limits: { maxDirectories: 2 } });
    const urls = ['file:///w/1', 'file:///w/2', 'file:///w/3'];
    for (const uri of urls) {
      const p = h.cache.read(uri);
      h.gates[h.gates.length - 1].resolve([[uri, 2]]);
      await p;
    }
    // urls[0] 已被淘汰：再讀會打來源；重新插入時urls[1] 成為最舊被淘汰，urls[2] 保留。
    const p1 = h.cache.read(urls[0]);
    expect(h.gates.length).toBe(4);
    h.gates[3].resolve([[urls[0], 2]]);
    await p1;
    const p2 = h.cache.read(urls[2]);
    expect(h.gates.length).toBe(4);
    await p2;
  });

  it('entry 總量超過上限時淘汰最舊目錄', async () => {
    const h = createHarness({ limits: { maxDirectories: 10, maxTotalEntries: 3 } });
    const mk = (n: number, tag: string): DirectoryEntry[] =>
      Array.from({ length: n }, (_, i) => [`${tag}${i}`, 1] as DirectoryEntry);
    const read = async (uri: string, entries: DirectoryEntry[]) => {
      const p = h.cache.read(uri);
      h.gates[h.gates.length - 1].resolve(entries);
      await p;
    };
    await read('file:///w/1', mk(2, 'a'));
    await read('file:///w/2', mk(1, 'b'));
    // 加入 w/3 後總量 4 > 3 → 最舊的 w/1（2 entries）被淘汰。
    await read('file:///w/3', mk(1, 'c'));
    const p = h.cache.read('file:///w/1');
    expect(h.gates.length).toBe(4);
    h.gates[3].resolve(mk(2, 'a'));
    await p;
    const kept = h.cache.read('file:///w/3');
    expect(h.gates.length).toBe(4); // w/3 仍被保留
    await kept;
  });

  it('超過單目錄上限的讀取可回傳但不快存、也不進快照', async () => {
    const h = createHarness({ limits: { maxEntriesPerDirectory: 2 } });
    const big: DirectoryEntry[] = [['a', 1], ['b', 1], ['c', 1]];
    const p = h.cache.read(dir);
    h.gates[0].resolve(big);
    expect(await p).toEqual(big); // 仍可完整回傳
    const p2 = h.cache.read(dir);
    expect(h.gates.length).toBe(2); // 沒有被記憶化
    h.gates[1].resolve(big);
    await p2;
    expect(h.cache.exportSnapshot()).toEqual({ version: 1, entries: [] });
  });
});

describe('快照僅為提示', () => {
  it('allowSnapshot=false 從不回傳未經驗證的快照', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['stale', 1]] }] });
    const p = h.cache.read(dir, false);
    expect(h.gates.length).toBe(1); // 一定打來源
    h.gates[0].resolve([['fresh', 1]]);
    expect(await p).toEqual([['fresh', 1]]);
  });

  it('allowSnapshot=true 立即回快照並背景 revalidate；內容改變才通知', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['stale', 1]] }] });
    const p = h.cache.read(dir, true);
    expect(h.gates.length).toBe(1); // 背景 revalidate 已排程
    expect(await p).toEqual([['stale', 1]]); // 立即拿到提示內容
    h.gates[0].resolve([['fresh', 1]]);
    await h.cache.whenSettled();
    expect(h.revalidated).toEqual([dir]);
    const next = await h.cache.read(dir, true);
    expect(next).toEqual([['fresh', 1]]); // 背景結果已記憶化，不再回舊提示
    expect(h.gates.length).toBe(1);
  });

  it('背景 revalidate 結果未改變時不通知', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['same', 1], ['d', 2]] }] });
    await h.cache.read(dir, true);
    h.gates[0].resolve([['same', 1], ['d', 2]]);
    await h.cache.whenSettled();
    expect(h.revalidated).toEqual([]);
  });

  it('同 URI 的背景 revalidate 與 fresh read 共用 pending', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['stale', 1]] }] });
    await h.cache.read(dir, true); // 產生背景請求
    const fresh = h.cache.read(dir, false);
    expect(h.gates.length).toBe(1); // 沒有重複打來源
    h.gates[0].resolve([['fresh', 1]]);
    expect(await fresh).toEqual([['fresh', 1]]);
  });

  it('過舊快照被丢棄，不作為提示', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 999_000, children: [['stale', 1]] }] });
    h.advance(defaultDirectoryCacheLimits.maxSnapshotAgeMs); // 載入後再推過 24h
    const p = h.cache.read(dir, true);
    expect(h.gates.length).toBe(1); // 無提示可用，改打來源
    h.gates[0].resolve([['fresh', 1]]);
    expect(await p).toEqual([['fresh', 1]]);
  });
});

describe('錯誤處理', () => {
  it('fresh read 失敗：reject、onError、不快存空結果、清掉該 URI 舊快照', async () => {
    const h = createHarness();
    const ok = h.cache.read(dir);
    h.gates[0].resolve([['good', 1]]);
    await ok;
    h.advance(defaultDirectoryCacheLimits.memoryTtlMs); // 記憶體過期、快照仍新

    const fail = h.cache.read(dir, false);
    h.gates[1].reject(new Error('EIO'));
    await expect(fail).rejects.toThrow('EIO');
    expect(h.errors.length).toBe(1);
    expect(h.errors[0].uri).toBe(dir);
    // 失敗不記空目錄且快照被清除：下一次仍實際打來源。
    const retry = h.cache.read(dir, true);
    expect(h.gates.length).toBe(3);
    h.gates[2].resolve([['good', 1]]);
    expect(await retry).toEqual([['good', 1]]);
    expect(h.cache.exportSnapshot()).toEqual({
      version: 1,
      entries: [{ uri: dir, time: 1_002_000, children: [['good', 1]] }],
    });
  });

  it('背景 revalidate 的 rejection 被處理：不 unhandled、清快照、onError 記錄', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = createHarness();
      h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['stale', 1]] }] });
      await h.cache.read(dir, true); // 觸發背景請求
      h.gates[0].reject(new Error('boom'));
      await h.cache.whenSettled();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(h.errors.length).toBe(1);
      // 快照層已清除 → 不會重複端出壞提示造成 revalidate 循環。
      const next = h.cache.read(dir, true);
      expect(h.gates.length).toBe(2);
      h.gates[1].resolve([['ok', 1]]);
      expect(await next).toEqual([['ok', 1]]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('invalidate 代次隔離', () => {
  it('invalidate 清空全部層；舊 pending 成功結果不回填、不發事件', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['hint', 1]] }] });
    const inflight = h.cache.read(dir, false);
    h.cache.invalidate();
    h.gates[0].resolve([['late', 1]]);
    // 呼叫端仍拿到值（由 provider 代次自行丢棄），但不寫入新代。
    expect(await inflight).toEqual([['late', 1]]);
    await h.cache.whenSettled();
    expect(h.revalidated).toEqual([]);
    expect(h.cache.exportSnapshot()).toEqual({ version: 1, entries: [] });
    const fresh = h.cache.read(dir, true);
    expect(h.gates.length).toBe(2); // 新代實際打來源
    h.gates[1].resolve([['new', 1]]);
    expect(await fresh).toEqual([['new', 1]]);
  });

  it('invalidate 後舊 pending 的失敗不污染新代（不刪新 pending、不發 onError）', async () => {
    const h = createHarness();
    const inflight = h.cache.read(dir, false);
    inflight.catch(() => undefined); // 舊呼叫端結果在本測試不關心
    h.cache.invalidate();
    const next = h.cache.read(dir, false);
    h.gates[0].reject(new Error('stale failure'));
    h.gates[1].resolve([['new', 1]]);
    expect(await next).toEqual([['new', 1]]); // 新 pending 存活且完成
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.errors).toEqual([]);
  });
});

describe('whenSettled', () => {
  it('等待呼叫時已開始的請求，不等待之後新讀取', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['stale', 1]] }] });
    await h.cache.read(dir, true); // 觸發背景請求
    let settled = false;
    const waiter = h.cache.whenSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.gates[0].resolve([['fresh', 1]]);
    await waiter;
    expect(settled).toBe(true);
    // settle 後的新 read 不屬於本次收斂範圍。
    const after = h.cache.read(other, false);
    expect(h.gates.length).toBe(2);
    h.gates[1].resolve([['x', 1]]);
    await after;
  });

  it('無進行中請求時立即完成', async () => {
    const h = createHarness();
    await h.cache.whenSettled();
  });
});

describe('dispose', () => {
  it('dispose 使進行中請求的舊結果無副作用：不回填、不發事件', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['stale', 1]] }] });
    await h.cache.read(dir, true); // 觸發背景請求
    h.cache.dispose();
    h.gates[0].resolve([['changed', 1]]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.revalidated).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.cache.exportSnapshot()).toEqual({ version: 1, entries: [] });
  });

  it('dispose 後的 read 為直通讀取（每次打來源、不記憶、不發事件）', async () => {
    const h = createHarness();
    h.cache.dispose();
    const p1 = h.cache.read(dir);
    h.gates[0].resolve([['a', 1]]);
    await p1;
    const p2 = h.cache.read(dir);
    expect(h.gates.length).toBe(2); // 沒有快取
    h.gates[1].resolve([['b', 1]]);
    expect(await p2).toEqual([['b', 1]]);
    expect(h.cache.exportSnapshot()).toEqual({ version: 1, entries: [] });
  });

  it('dispose 後失敗只 reject，不觸發 onError', async () => {
    const h = createHarness();
    h.cache.dispose();
    const p = h.cache.read(dir);
    h.gates[0].reject(new Error('after dispose'));
    await expect(p).rejects.toThrow('after dispose');
    expect(h.errors).toEqual([]);
  });
});

describe('loadSnapshot schema 驗證（不合法即丢棄、不 throw）', () => {
  const validChildren: DirectoryEntry[] = [['ok.txt', 1], ['sub', 2]];

  /** 断言 payload 完全不被採用：read(dir, true) 必須實際打來源而非端出提示。 */
  async function expectDiscarded(value: unknown): Promise<void> {
    const h = createHarness();
    h.cache.loadSnapshot(value);
    const p = h.cache.read(dir, true);
    expect(h.gates.length).toBe(1);
    h.gates[0].resolve([['fresh', 1]]);
    expect(await p).toEqual([['fresh', 1]]);
  }

  it('拒绝非物件、錯誤 version、entries 非陣列', async () => {
    await expectDiscarded(null);
    await expectDiscarded('snapshot');
    await expectDiscarded({ version: 2, entries: [] });
    await expectDiscarded({ version: 1, entries: 'nope' });
  });

  it('拒绝非 file: scheme 的 URI 與非字串 URI', async () => {
    await expectDiscarded({ version: 1, entries: [{ uri: 'untitled:/a', time: 1_000_000, children: validChildren }] });
    await expectDiscarded({ version: 1, entries: [{ uri: 42, time: 1_000_000, children: validChildren }] });
  });

  it('拒绝路徑穿越型 name 與非法 FileType', async () => {
    for (const children of [[['../evil', 1]], [['a/b', 1]], [['a\\b', 1]], [['.', 1]], [['..', 1]], [['', 1]]]) {
      await expectDiscarded({ version: 1, entries: [{ uri: dir, time: 1_000_000, children }] });
    }
    for (const type of [0, -1, 1.5, 999, 'file', undefined]) {
      await expectDiscarded({
        version: 1,
        entries: [{ uri: dir, time: 1_000_000, children: [['good', type as unknown as number]] }],
      });
    }
  });

  it('拒绝 time 非法、未來時間或超過 24h 的目錄', async () => {
    await expectDiscarded({ version: 1, entries: [{ uri: dir, time: 'x', children: validChildren }] });
    await expectDiscarded({ version: 1, entries: [{ uri: dir, time: Number.NaN, children: validChildren }] });
    await expectDiscarded({ version: 1, entries: [{ uri: dir, time: 1_000_001, children: validChildren }] });
    await expectDiscarded({
      version: 1,
      entries: [{ uri: dir, time: 1_000_000 - defaultDirectoryCacheLimits.maxSnapshotAgeMs - 1, children: validChildren }],
    });
  });

  it('拒绝 children 非陣列、超限目錄或畸形 tuple', async () => {
    await expectDiscarded({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: 'nope' }] });
    await expectDiscarded({ version: 1, entries: [{ uri: dir, time: 1_000_000, children: [['a', 1, 'extra']] }] });
    await expectDiscarded({
      version: 1,
      entries: [
        {
          uri: dir,
          time: 1_000_000,
          children: Array.from({ length: defaultDirectoryCacheLimits.maxEntriesPerDirectory + 1 }, (_, i) => [`f${i}`, 1]),
        },
      ],
    });
  });

  it('合法目錄保留、非法目錄略過；URI key 完整且不小寫化', async () => {
    const h = createHarness();
    h.cache.loadSnapshot({
      version: 1,
      entries: [
        { uri: 'file:///ws/MixedCase', time: 1_000_000, children: validChildren },
        { uri: 'untitled:/bad', time: 1_000_000, children: validChildren },
        'garbage',
      ],
    });
    const hinted = await h.cache.read('file:///ws/MixedCase', true);
    expect(hinted).toEqual(validChildren);
    expect(h.gates.length).toBe(1); // 背景 revalidate 進行中
    h.gates[0].resolve(validChildren); // 內容相同 → 不通知
    await h.cache.whenSettled();
    expect(h.revalidated).toEqual([]);
    // 不小寫化：只有原 key 命中。
    const missed = h.cache.read('file:///ws/mixedcase', true);
    expect(h.gates.length).toBe(2);
    h.gates[1].resolve([['x', 1]]);
    expect(await missed).toEqual([['x', 1]]);
  });
});

describe('exportSnapshot', () => {
  it('只含 file: 目錄；非 file: 的新鮮讀取不進快照', async () => {
    const h = createHarness();
    for (const uri of [dir, 'untitled:///memory-only']) {
      const p = h.cache.read(uri);
      h.gates[h.gates.length - 1].resolve([['f', 1]]);
      await p;
    }
    const exported = h.cache.exportSnapshot() as { version: number; entries: Array<{ uri: string }> };
    expect(exported.version).toBe(1);
    expect(exported.entries.map(entry => entry.uri)).toEqual([dir]);
  });

  it('匯出 JSON 不超過 maxSnapshotBytes', async () => {
    const h = createHarness({ limits: { maxSnapshotBytes: 400 } });
    for (let i = 0; i < 20; i++) {
      const p = h.cache.read(`file:///w/d${i}`);
      h.gates[h.gates.length - 1].resolve(
        Array.from({ length: 10 }, (_, j) => [`file${j}.ts`, 1] as DirectoryEntry)
      );
      await p;
    }
    const json = JSON.stringify(h.cache.exportSnapshot());
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(400);
    const parsed = JSON.parse(json) as { entries: unknown[] };
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it('load 後再 read(dir, true) 以快照作為提示（往返一致）', async () => {
    const h = createHarness();
    const p = h.cache.read(dir);
    h.gates[0].resolve([['a', 1], ['b', 2]]);
    await p;
    const exported = h.cache.exportSnapshot();
    h.cache.invalidate(); // 清空記憶體與快照
    h.cache.loadSnapshot(exported); // 模擬重啟後從 memento 還原
    const hinted = h.cache.read(dir, true);
    expect(await hinted).toEqual([['a', 1], ['b', 2]]);
    expect(h.gates.length).toBe(2); // 僅背景 revalidate
    h.gates[1].resolve([['a', 1], ['b', 2]]);
    await h.cache.whenSettled();
    expect(h.revalidated).toEqual([]);
  });
});

describe('DirectoryCache onDidStore（S4R7-D81 持久化觸發）', () => {
  it('成功記憶化後通知；同代重複讀取不重複通知（TTL 命中不觸發）', async () => {
    const h = createHarness();
    const first = h.cache.read(dir);
    h.gates[0].resolve([['a', 1]]);
    await first;
    expect(h.stored).toEqual([dir]);
    // TTL 內再讀：直接命中記憶體，不再觸發 store。
    await h.cache.read(dir);
    expect(h.stored).toEqual([dir]);
  });

  it('讀取失敗不通知（失敗不得當成可持久化的空目錄）', async () => {
    const h = createHarness();
    const failing = h.cache.read(dir);
    h.gates[0].reject(new Error('EACCES'));
    await expect(failing).rejects.toThrow('EACCES');
    expect(h.stored).toEqual([]);
    expect(h.errors.length).toBe(1);
  });

  it('invalidate 後舊代 pending 完成不通知（不污染新一代持久化）', async () => {
    const h = createHarness();
    const stale = h.cache.read(dir);
    h.cache.invalidate(); // 舊代作廢
    h.gates[0].resolve([['a', 1]]);
    await stale; // 舊 promise 仍 resolve，但不得 store
    expect(h.stored).toEqual([]);
    // 新代讀取正常通知。
    const fresh = h.cache.read(dir);
    h.gates[1].resolve([['b', 2]]);
    await fresh;
    expect(h.stored).toEqual([dir]);
  });
});

describe('DirectoryCache 失效粒度與快照上限（審查 F1/F3）', () => {
  it('invalidateMemory 保留快照提示；invalidate 才清（F1）', async () => {
    const h = createHarness();
    const first = h.cache.read(dir);
    h.gates[0].resolve([['a', 1]]);
    await first;
    h.cache.invalidateMemory(); // provider refresh 路徑：memory/pending 清、提示保留
    const hinted = await h.cache.read(dir, true);
    expect(hinted).toEqual([['a', 1]]);
    h.gates[1].resolve([['a', 1]]); // 背景 revalidate
    await h.cache.whenSettled();

    h.cache.invalidate(); // 全量失效（FS 事件路徑）：提示也不在
    const before = h.gates.length;
    const fresh = h.cache.read(dir, true);
    expect(h.gates.length).toBe(before + 1); // 無 hint → 直接走來源
    h.gates[before].resolve([['b', 2]]);
    await fresh;
    expect(await h.cache.read(dir, true)).toEqual([['b', 2]]); // 記憶體命中，不再新增 gate
    expect(h.gates.length).toBe(before + 1);
  });

  it('快照層受 maxDirectories 上限約束（F3）', async () => {
    const h = createHarness({ limits: { maxDirectories: 2 } });
    const uris = ['file:///ws/1', 'file:///ws/2', 'file:///ws/3'];
    for (let index = 0; index < uris.length; index += 1) {
      const pending = h.cache.read(uris[index]);
      h.gates[index].resolve([['x', 1]]);
      await pending;
    }
    const exported = h.cache.exportSnapshot() as { entries: unknown[] };
    expect(exported.entries.length).toBe(2);
  });
});
