/**
 * S4R7-D85：refresh 排程器（純邏輯，零 vscode 相依，可單元測試）。
 *
 * 兩種時序：
 * - 啟動窗口內：「一般 trailing debounce ＋ 批次硬截止」——每個事件重設 debounce 時鐘，
 *   但批次截止（首個事件 + maxWaitMs）不被推遲；持續事件流下每個批次至多 fire 一次
 *   （避免啟動期洪水造成 refresh 飢餓或逐事件重繪）。
 * - 窗口外（或未設 startupWindowMs）：一般 trailing debounce（新事件重設時鐘）。
 *
 * 時鐘與計時器皆注入，方便以假時鐘驗證時序；預設使用 Date.now 與全域 setTimeout。
 */

export interface RefreshSchedulerOptions {
  /** 觸發一次 fire 排程。 */
  fire(): void;
  /** 一般 debounce 毫秒（參考值 200）。 */
  debounceMs: number;
  /** 啟動窗口毫秒（參考值 2800）；省略或 <=0 表示一律使用一般 debounce。 */
  startupWindowMs?: number;
  /** 啟動窗口內單批次最大等待毫秒（參考值 1000）。 */
  startupMaxWaitMs?: number;
  /** 啟動基準時間（activation 起算）；預設建構當下。 */
  startupAt?: number;
  clock?: () => number;
  setTimeout?(callback: () => void, milliseconds: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface RefreshScheduler {
  /** 安排（或合併）一次 refresh fire。 */
  schedule(): void;
  /** 清除未觸發的排程（dispose 用）。 */
  dispose(): void;
  /** 目前是否已排程尚未 fire（測試／診斷用）。 */
  readonly pending: boolean;
}

export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
  const clock = options.clock ?? ((): number => Date.now());
  const setTimer = options.setTimeout ?? ((callback: () => void, milliseconds: number): unknown => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimeout ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startupWindowMs = options.startupWindowMs && options.startupWindowMs > 0 ? options.startupWindowMs : undefined;
  const startupMaxWaitMs = options.startupMaxWaitMs && options.startupMaxWaitMs > 0
    ? options.startupMaxWaitMs
    : options.debounceMs;
  const startupAt = options.startupAt ?? clock();

  let timer: unknown;
  /** 窗口內本批次硬截止（首個事件 + startupMaxWaitMs）；持續事件不 reset，fire 後清除。 */
  let deadlineAt: number | undefined;

  const fire = (): void => {
    timer = undefined;
    deadlineAt = undefined;
    options.fire();
  };

  return {
    schedule(): void {
      const now = clock();
      let dueAt: number;
      if (startupWindowMs !== undefined && now - startupAt < startupWindowMs) {
        // 窗口內：批次硬截止＝首個事件 + startupMaxWaitMs（不被後續事件推遲）。
        if (deadlineAt === undefined) {
          deadlineAt = now + startupMaxWaitMs;
        }
        dueAt = Math.min(now + options.debounceMs, deadlineAt);
      } else {
        // 窗口外：一般 trailing debounce。
        deadlineAt = undefined;
        dueAt = now + options.debounceMs;
      }
      if (timer !== undefined) {
        clearTimer(timer);
      }
      timer = setTimer(fire, Math.max(0, dueAt - now));
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      deadlineAt = undefined;
    },
    get pending(): boolean {
      return timer !== undefined;
    },
  };
}
