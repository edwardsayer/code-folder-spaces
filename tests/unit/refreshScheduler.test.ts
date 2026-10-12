import { describe, expect, it } from 'vitest';
import { createRefreshScheduler } from '../../src/spaces/refreshScheduler';

/** 假時鐘＋假計時器：以到期時間排序的幀佇列模擬 setTimeout/clearTimeout。 */
class FakeTimers {
  now = 0;
  private nextId = 1;
  private queue: { id: number; dueAt: number; callback: () => void }[] = [];

  setTimeout = (callback: () => void, milliseconds: number): unknown => {
    const entry = { id: this.nextId++, dueAt: this.now + milliseconds, callback };
    this.queue.push(entry);
    return entry.id;
  };

  clearTimeout = (handle: unknown): void => {
    this.queue = this.queue.filter(entry => entry.id !== handle);
  };

  /** 推進時鐘並依序執行到期的計時器。 */
  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const due = this.queue
        .filter(entry => entry.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter(entry => entry !== due);
      this.now = due.dueAt;
      due.callback();
    }
    this.now = target;
  }
}

interface Harness {
  timers: FakeTimers;
  fires: number[];
  scheduler: ReturnType<typeof createRefreshScheduler>;
}

function createHarness(overrides?: { startupWindowMs?: number; startupMaxWaitMs?: number; debounceMs?: number }): Harness {
  const timers = new FakeTimers();
  const fires: number[] = [];
  const scheduler = createRefreshScheduler({
    fire: () => fires.push(timers.now),
    debounceMs: overrides?.debounceMs ?? 200,
    startupWindowMs: overrides?.startupWindowMs ?? 2800,
    startupMaxWaitMs: overrides?.startupMaxWaitMs ?? 1000,
    startupAt: 0,
    clock: () => timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { timers, fires, scheduler };
}

describe('createRefreshScheduler（S4R7-D85 啟動事件合併）', () => {
  it('窗口外單一事件：debounceMs 後 fire 一次', () => {
    const { timers, fires, scheduler } = createHarness({ startupWindowMs: 0 });
    scheduler.schedule();
    timers.advance(199);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toEqual([200]);
  });

  it('窗口外事件流：每次新事件重設時鐘（trailing debounce），流停止後 fire 一次', () => {
    const { timers, fires, scheduler } = createHarness({ startupWindowMs: 0 });
    for (let at = 0; at <= 1000; at += 100) {
      timers.advance(100);
      scheduler.schedule();
    }
    timers.advance(199);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toEqual([1300]);
  });

  it('窗口內事件風暴：批次硬截止不被推遲，每批至多 fire 一次（約 1 次/秒），窗口結束回 trailing debounce', () => {
    const { timers, fires, scheduler } = createHarness();
    // 每 50ms 一個事件、共 10 秒——風暴遠超過 2800ms 啟動窗口。
    for (let at = 0; at <= 10_000; at += 50) {
      scheduler.schedule();
      timers.advance(50);
    }
    // 批次一：首事件 t=0 → 硬截止 t=1000；批次二：t=1000 起 → t=2000；
    // t=2800 窗口結束後回 200ms trailing，風暴未停故遲至最後事件後 200ms 才 fire。
    timers.advance(200);
    expect(fires).toEqual([1000, 2000, 10_200]);
  });

  it('窗口內風暴後安靜：在硬截止前安靜即按 debounce 提前 fire，不等到截止', () => {
    const { timers, fires, scheduler } = createHarness();
    for (let at = 0; at <= 500; at += 50) {
      scheduler.schedule();
      timers.advance(50);
    }
    timers.advance(149);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toEqual([700]);
  });

  it('窗口內單一事件：debounce 早於截止時按 debounce fire', () => {
    const { timers, fires, scheduler } = createHarness();
    scheduler.schedule();
    timers.advance(199);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toEqual([200]);
  });

  it('窗口內晚到事件：截止（首事件+1000）早於 debounce 時程時以截止 fire', () => {
    const { timers, fires, scheduler } = createHarness();
    // 事件每 150ms 一來（debounce 200ms 不及安靜），時鐘被持續重設；
    // 末事件 t=900 時 debounce 會到 1100，但批次截止 1000 生效。
    for (let at = 0; at <= 900; at += 150) {
      scheduler.schedule();
      timers.advance(150);
    }
    // 末次 advance 已越過截止 1000，fire 發生在批次截止而非 debounce 1100。
    expect(fires).toEqual([1000]);
  });

  it('窗口結束後的新事件改用一般 trailing debounce', () => {
    const { timers, fires, scheduler } = createHarness();
    timers.now = 3000; // 超過 2800ms 窗口
    scheduler.schedule();
    timers.advance(100);
    scheduler.schedule(); // 重設時鐘
    timers.advance(199);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toEqual([3300]);
  });

  it('dispose 為終態：清除未觸發排程，之後 schedule 為無效操作（審查 F7）', () => {
    const { timers, fires, scheduler } = createHarness({ startupWindowMs: 0 });
    scheduler.schedule();
    expect(scheduler.pending).toBe(true);
    scheduler.dispose();
    expect(scheduler.pending).toBe(false);
    scheduler.schedule();
    expect(scheduler.pending).toBe(false);
    timers.advance(1000);
    expect(fires).toEqual([]);
  });

  it('startupMaxWaitMs 未設定時以 debounceMs 作為批次上限', () => {
    const timers = new FakeTimers();
    const fires: number[] = [];
    const scheduler = createRefreshScheduler({
      fire: () => fires.push(timers.now),
      debounceMs: 100,
      startupWindowMs: 1000,
      startupAt: 0,
      clock: () => timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    for (let at = 0; at <= 600; at += 20) {
      scheduler.schedule();
      timers.advance(20);
    }
    // 批次截止退化為 debounce（100ms）：風暴期間每批 100ms 一次；安靜後 t=700 最後一次。
    timers.advance(80);
    expect(fires).toEqual([100, 200, 300, 400, 500, 600, 700]);
  });
});
