/**
 * F-44 目錄清單快取（S4R7 W1，S4R7-D79–D83）：純邏輯、零 vscode 相依。
 *
 * 兩層設計：
 * - 記憶體快取：短 TTL／LRU 有界，只存成功讀取的新鲜結果。
 * - 快照（exportSnapshot／loadSnapshot）：僅作 chevron「有無子項」提示；
 *   只有呼叫端明確 allowSnapshot 才會回傳未經驗證的快照資料，並立即背景 revalidate。
 *
 * memento 存放與 timer／debounce 排程由 extension（W3）負責，本 seam 只使用注入的 clock，
 * 不自行建立任何 timer 或持久化寫入。
 */

/** 與 vscode FileMapping 對齊的原始 tuple：[檔名, FileType bitmask]。 */
export type DirectoryEntry = [name: string, fileType: number];

export interface DirectoryCacheLimits {
  /** 記憶體快取最多保留的目錄數。 */
  maxDirectories: number;
  /** 記憶體快取所有目錄 entry 總數上限。 */
  maxTotalEntries: number;
  /** 單一目錄超過此 entry 數時可回傳但不快存（S4R7-D81）。 */
  maxEntriesPerDirectory: number;
  /** 記憶體條目視為新鮮的毫秒數。 */
  memoryTtlMs: number;
  /** exportSnapshot 產出 JSON 的位元組上限。 */
  maxSnapshotBytes: number;
  /** 快照最大存活毫秒數，過舊一律丢弃。 */
  maxSnapshotAgeMs: number;
}

export const defaultDirectoryCacheLimits: DirectoryCacheLimits = {
  maxDirectories: 512,
  maxTotalEntries: 20_000,
  maxEntriesPerDirectory: 2_000,
  memoryTtlMs: 2_000,
  maxSnapshotBytes: 1024 * 1024,
  maxSnapshotAgeMs: 24 * 60 * 60 * 1000,
};

export interface DirectoryCacheOptions {
  /** 注入的目錄列舉來源（provider 接線由 W2 負責）。 */
  readDirectory(uri: string): Promise<DirectoryEntry[]>;
  /** 可注入時鐘，方便單元測試；預設 Date.now。 */
  clock?: () => number;
  limits?: Partial<DirectoryCacheLimits>;
  /** 僅在快照提示的背景 revalidate 實際改變內容時呼叫。 */
  onDidRevalidate?(uri: string): void;
  /** 成功記憶化一個目錄後呼叫（供持久化層排定 debounce 寫入；S4R7-D81）。 */
  onDidStore?(uri: string): void;
  /** 讀取失敗時呼叫；失敗結果一律不快存。 */
  onError?(uri: string, error: unknown): void;
}

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_WRAPPER = '{"version":1,"entries":[]}';
const textEncoder = new TextEncoder();

interface CachedDirectory {
  time: number;
  entries: DirectoryEntry[];
}

interface PendingRead {
  generation: number;
  promise: Promise<DirectoryEntry[]>;
}

interface SnapshotDirectoryRecord {
  uri: string;
  time: number;
  children: DirectoryEntry[];
}

function copyEntries(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return entries.map(([name, fileType]) => [name, fileType] as DirectoryEntry);
}

function sameEntries(a: readonly DirectoryEntry[], b: readonly DirectoryEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry[0] === b[index][0] && entry[1] === b[index][1]);
}

/** 快照僅接受 file: scheme；key 為完整序列化 URI，不小寫化（S4R7-D80）。 */
function isFileSchemeUri(uri: string): boolean {
  return uri.length > 5 && /^file:/i.test(uri);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拒路徑穿越型 name：非空、不含分隔符、不是 . 或 ..。 */
function isSafeEntryName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\');
}

/** 合理的 vscode FileType bitmask：1<<0 File .. 1<<6 NamedPipe 的非零子集（0 Unknown 無提示價值）。 */
function isFileTypeBitmask(type: unknown): type is number {
  return typeof type === 'number' && Number.isInteger(type) && type >= 1 && type <= 127;
}

function isValidDirectoryChildren(children: unknown, limit: number): children is DirectoryEntry[] {
  return Array.isArray(children) && children.length <= limit
    && children.every(child => Array.isArray(child) && child.length === 2
      && isSafeEntryName(child[0]) && isFileTypeBitmask(child[1]));
}

function jsonByteSize(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length;
}

export class DirectoryCache {
  private readonly readDirectory: (uri: string) => Promise<DirectoryEntry[]>;
  private readonly clock: () => number;
  private readonly limits: DirectoryCacheLimits;
  private readonly onDidRevalidate?: (uri: string) => void;
  private readonly onDidStore?: (uri: string) => void;
  private readonly onError?: (uri: string, error: unknown) => void;

  /** 失效代次：invalidate／dispose 递增，舊代完成的結果一律不產生副作用（S4R7-D83）。 */
  private generation = 0;
  private disposed = false;
  private memory = new Map<string, CachedDirectory>();
  private memoryTotalEntries = 0;
  private snapshots = new Map<string, CachedDirectory>();
  private pending = new Map<string, PendingRead>();

  constructor(options: DirectoryCacheOptions) {
    const limits = { ...defaultDirectoryCacheLimits, ...options.limits };
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`DirectoryCache limits.${key} 必須是正整數`);
      }
    }
    this.readDirectory = options.readDirectory;
    this.clock = options.clock ?? ((): number => Date.now());
    this.limits = limits;
    this.onDidRevalidate = options.onDidRevalidate;
    this.onDidStore = options.onDidStore;
    this.onError = options.onError;
  }

  /**
   * 讀取目錄：
   * - 同代同 URI 的 pending 讀取自動去重；背景 revalidate 與一般 read 共用同一 pending。
   * - 記憶體條目在 TTL 內直接共用（已是驗證過的新鮮資料）。
   * - 只有在 allowSnapshot=true 時才會立即回傳快照提示並背景 revalidate；
   *   false 一律等待實際讀取結果，不回未驗證快照（S4R7-D79）。
   * - dispose 之後為無副作用的直通讀取。
   */
  async read(uri: string, allowSnapshot = false): Promise<DirectoryEntry[]> {
    if (this.disposed) {
      return copyEntries(await this.readDirectory(uri));
    }
    const now = this.clock();

    const cached = this.memory.get(uri);
    if (cached) {
      if (now - cached.time < this.limits.memoryTtlMs) {
        // LRU：命中時移至鏈尾。
        this.memory.delete(uri);
        this.memory.set(uri, cached);
        return copyEntries(cached.entries);
      }
      this.deleteMemory(cached, uri);
    }

    if (allowSnapshot) {
      const hint = this.snapshots.get(uri);
      if (hint && now - hint.time <= this.limits.maxSnapshotAgeMs) {
        const generation = this.generation;
        const served = hint.entries;
        this.fetch(uri).then(
          fresh => {
            if (this.disposed || generation !== this.generation) {
              return;
            }
            // 只有實際內容改變才通知，避免 revalidate 循環（S4R7-D82）。
            if (!sameEntries(served, fresh)) {
              this.onDidRevalidate?.(uri);
            }
          },
          // 失敗清理與 onError 已在 fetch 內處理；此處吸收 rejection，不產生 unhandled rejection。
          () => undefined
        );
        return copyEntries(served);
      }
      if (hint) {
        this.snapshots.delete(uri);
      }
    }

    return copyEntries(await this.fetch(uri));
  }

  /** 全量失效：增代次並清空記憶體、pending 與快照（S4R7-D83）。 */
  invalidate(): void {
    this.generation += 1;
    this.clearStores();
  }

  /**
   * 等待呼叫當下「已開始」的讀取（含背景 revalidate）收斂；
   * 不等待呼叫之後才發起的 getChildren，也不等待失效後的殘留舊請求（S4R7-D84）。
   */
  async whenSettled(): Promise<void> {
    const inFlight = [...this.pending.values()].map(record => record.promise.then(() => undefined, () => undefined));
    if (inFlight.length > 0) {
      await Promise.all(inFlight);
    }
  }

  /**
   * 匯出快照 schema v1：{ version, entries: [{ uri, time, children }] }。
   * 僅 file: URI、僅成功讀取過的資料；過舊／超限／非法名稱一律排除，
   * 依新到舊打包使 JSON 不超過 maxSnapshotBytes。
   */
  exportSnapshot(): unknown {
    const now = this.clock();
    const merged = new Map<string, CachedDirectory>();
    for (const [uri, record] of this.snapshots) {
      merged.set(uri, record);
    }
    for (const [uri, record] of this.memory) {
      const existing = merged.get(uri);
      if (!existing || record.time >= existing.time) {
        merged.set(uri, record);
      }
    }

    const candidates: SnapshotDirectoryRecord[] = [];
    for (const [uri, record] of merged) {
      if (!isFileSchemeUri(uri)) {
        continue;
      }
      const age = now - record.time;
      if (age < 0 || age > this.limits.maxSnapshotAgeMs) {
        continue;
      }
      if (!isValidDirectoryChildren(record.entries, this.limits.maxEntriesPerDirectory)) {
        continue;
      }
      candidates.push({ uri, time: record.time, children: record.entries });
    }
    // 新到舊、同時間依 URI 字典序，確保打包結果可重現。
    candidates.sort((a, b) => b.time - a.time || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

    const picked: SnapshotDirectoryRecord[] = [];
    let used = jsonByteSize(SNAPSHOT_WRAPPER);
    for (const candidate of candidates) {
      const cost = jsonByteSize(candidate) + (picked.length > 0 ? 1 : 0);
      if (used + cost > this.limits.maxSnapshotBytes) {
        continue;
      }
      used += cost;
      picked.push(candidate);
    }
    return { version: SNAPSHOT_VERSION, entries: picked };
  }

  /**
   * 載入持久化快照（啟動還原用，整層取代現有快照）。
   * schema 不合法時静默丢弃而不 throw；單一目錄非法即整體略過。
   */
  loadSnapshot(value: unknown): void {
    const next = new Map<string, CachedDirectory>();
    const now = this.clock();
    if (isPlainObject(value) && value.version === SNAPSHOT_VERSION && Array.isArray(value.entries)) {
      for (const item of value.entries) {
        if (!isPlainObject(item)) {
          continue;
        }
        const { uri, time, children } = item;
        if (typeof uri !== 'string' || !isFileSchemeUri(uri)) {
          continue;
        }
        if (typeof time !== 'number' || !Number.isFinite(time) || time > now || now - time > this.limits.maxSnapshotAgeMs) {
          continue;
        }
        if (!isValidDirectoryChildren(children, this.limits.maxEntriesPerDirectory)) {
          continue;
        }
        // 完整 URI 當作 key，不小寫化，避免破壞大小寫敏感 provider（S4R7-D80）。
        next.set(uri, { time, entries: copyEntries(children) });
      }
    }
    this.snapshots = next;
  }

  /** 銷毀：之後的舊結果一律不產生副作用（不回填、不發事件）。 */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearStores();
  }

  /** 發起或共用同 URI 的當代讀取；成功記憶化、失敗清除該 URI 並報錯。 */
  private fetch(uri: string): Promise<DirectoryEntry[]> {
    const existing = this.pending.get(uri);
    if (existing && existing.generation === this.generation) {
      return existing.promise;
    }
    const generation = this.generation;
    const record: PendingRead = { generation, promise: null as unknown as Promise<DirectoryEntry[]> };
    record.promise = this.readDirectory(uri).then(
      raw => {
        const entries = copyEntries(raw);
        if (!this.disposed && generation === this.generation) {
          if (this.pending.get(uri) === record) {
            this.pending.delete(uri);
          }
          this.remember(uri, entries);
        }
        return entries;
      },
      error => {
        if (!this.disposed && generation === this.generation) {
          if (this.pending.get(uri) === record) {
            this.pending.delete(uri);
          }
          // 讀取失敗不得快存成空目錄；移除該 URI 的舊記憶體與舊快照（S4R7-D82）。
          const stale = this.memory.get(uri);
          if (stale) {
            this.deleteMemory(stale, uri);
          }
          this.snapshots.delete(uri);
          this.onError?.(uri, error);
        }
        throw error;
      }
    );
    this.pending.set(uri, record);
    return record.promise;
  }

  /** 成功讀取的唯一記憶化入口：超限目錄不存；file: URI 才進快照層。 */
  private remember(uri: string, entries: DirectoryEntry[]): void {
    if (entries.length > this.limits.maxEntriesPerDirectory) {
      return;
    }
    this.setMemory(uri, entries);
    if (isFileSchemeUri(uri)) {
      this.snapshots.set(uri, { time: this.clock(), entries });
    }
    // 僅在成功驗證後通知持久化層（失敗路徑不會到達這裡，S4R7-D81）。
    this.onDidStore?.(uri);
  }

  private setMemory(uri: string, entries: DirectoryEntry[]): void {
    const previous = this.memory.get(uri);
    if (previous) {
      this.deleteMemory(previous, uri);
    }
    this.memory.set(uri, { time: this.clock(), entries });
    this.memoryTotalEntries += entries.length;
    this.evictMemory();
  }

  /** LRU 淘汰：Map 迭代序即插入序（命中時 re-set 至鏈尾），從最舊開始丟。 */
  private evictMemory(): void {
    while (this.memory.size > this.limits.maxDirectories || this.memoryTotalEntries > this.limits.maxTotalEntries) {
      const oldest = this.memory.keys().next();
      if (oldest.done) {
        break;
      }
      const record = this.memory.get(oldest.value);
      if (record) {
        this.deleteMemory(record, oldest.value);
      }
    }
  }

  private deleteMemory(record: CachedDirectory, uri: string): void {
    this.memoryTotalEntries -= record.entries.length;
    this.memory.delete(uri);
  }

  private clearStores(): void {
    this.memory = new Map();
    this.memoryTotalEntries = 0;
    this.snapshots = new Map();
    this.pending = new Map();
  }
}
