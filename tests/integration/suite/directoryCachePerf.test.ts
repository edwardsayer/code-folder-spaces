import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DirectoryCache } from '../../../src/spaces/directoryCache';
import type { DirectoryEntry } from '../../../src/spaces/directoryCache';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { clearGlobalSettings, createPaneStateHarness, paneRootNode, paneScopeFor, seedPane } from './helpers';

// F-44 S4R7 量測（契約 D79–D85）：以注入的計數 cache 量測
// ① 冷啟動首次根列舉 ② TTL 內重複列舉（記憶體命中）③ invalidate 後新鮮列舉
// ④ 快照提示的子項探測（chevron）vs 無快照。
// 這些是 provider 層（Node fs + workspace.fs）量測，不代表 renderer 繪製時間；
// 量級僅點估計，不可跨機器比較。

const DIRECTORY_COUNT = 300;
const FILES_PER_DIRECTORY = 5;

interface CountingCache {
  cache: DirectoryCache;
  reads: string[];
  dispose: () => void;
}

function createCountingCache(): CountingCache {
  const reads: string[] = [];
  const cache = new DirectoryCache({
    readDirectory: async (uri: string): Promise<DirectoryEntry[]> => {
      reads.push(uri);
      return await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri));
    },
    // TTL 拉長：讓「TTL 內重複列舉」確定命中記憶體。
    limits: { memoryTtlMs: 600_000 },
  });
  return { cache, reads, dispose: () => cache.dispose() };
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

suite('F-44 快取量測（S4R7）', () => {
  let tmpRoot: string;

  suiteSetup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-s4r7-perf-'));
    for (let index = 0; index < DIRECTORY_COUNT; index += 1) {
      const directory = path.join(tmpRoot, `dir-${String(index).padStart(4, '0')}`);
      fs.mkdirSync(directory);
      for (let file = 0; file < FILES_PER_DIRECTORY; file += 1) {
        fs.writeFileSync(path.join(directory, `file-${file}.txt`), 'file');
      }
    }
  });

  suiteTeardown(async () => {
    await clearGlobalSettings();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('量測冷／TTL 命中／invalidate 後列舉與快照 chevron 探測', async () => {
    const store = new SpaceStore();
    const harness = createCountingCache();
    let provider: SpaceTreeDataProvider | undefined;
    try {
      const { state: viewState } = createPaneStateHarness();
      await seedPane(viewState, 'pane1', { root: tmpRoot, showFiles: true });
      const scope = paneScopeFor(store, viewState, 'pane1');
      assert.ok(scope, 'pane1 必須有 root');
      provider = new SpaceTreeDataProvider(store, viewState, scope, harness.cache);
      const root = paneRootNode(provider);

      // ① 基準（無快取層）：直接以 workspace.fs 讀 root ＋逐子目錄子項探測（等價無快取展開的 I/O 面）。
      const baselineSamples: number[] = [];
      let baselineReads = 0;
      for (let iteration = 0; iteration < 3; iteration += 1) {
        let reads = 0;
        const started = performance.now();
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(tmpRoot));
        reads += 1;
        for (const [name, type] of entries) {
          if (type & vscode.FileType.Directory) {
            await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(vscode.Uri.file(tmpRoot), name));
            reads += 1;
          }
        }
        baselineSamples.push(performance.now() - started);
        baselineReads = reads;
      }

      // ② 冷啟動：記憶體為空，需實際讀 root 目錄。
      harness.reads.length = 0;
      const coldSamples: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        provider.refresh(); // 每次冷取：清空記憶體
        harness.reads.length = 0;
        const started = performance.now();
        const children = await provider.getChildren(root) as SpaceNode[];
        coldSamples.push(performance.now() - started);
        assert.equal(children.length, DIRECTORY_COUNT);
      }
      const coldReads = harness.reads.length;

      // ④ TTL 內重複列舉：root 命中記憶體，不重讀來源。
      harness.reads.length = 0;
      const warmSamples: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const started = performance.now();
        const children = await provider.getChildren(root) as SpaceNode[];
        warmSamples.push(performance.now() - started);
        assert.equal(children.length, DIRECTORY_COUNT);
      }
      const warmReads = harness.reads.length;

      // ⑤ invalidate 後新鮮列舉：重新讀來源。
      harness.reads.length = 0;
      const freshSamples: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        harness.cache.invalidate();
        harness.reads.length = 0;
        const started = performance.now();
        const children = await provider.getChildren(root) as SpaceNode[];
        freshSamples.push(performance.now() - started);
        assert.equal(children.length, DIRECTORY_COUNT);
      }
      const freshReads = harness.reads.length;

      // ⑥ 快照 chevron 探測：快照存在時不阻塞於子目錄實際讀取。
      const snapshotSamples: number[] = [];
      harness.cache.invalidate();
      for (let iteration = 0; iteration < 3; iteration += 1) {
        await provider.getChildren(root); // 產生新鮮記憶體＋快照
        harness.cache.invalidate();
        harness.cache.loadSnapshot(harness.cache.exportSnapshot());
        harness.reads.length = 0;
        const started = performance.now();
        const children = await provider.getChildren(root) as SpaceNode[];
        // 每個目錄列的 hasChildren 探測走 allowSnapshot=true。
        assert.equal(children.length, DIRECTORY_COUNT);
        snapshotSamples.push(performance.now() - started);
      }
      const snapshotHintReads = harness.reads.length;

      console.log(`S4R7-MEASUREMENT ${JSON.stringify({
        phase: process.env.S4_7_PERF_PHASE ?? 'unspecified',
        platform: process.platform,
        node: process.version,
        vscode: vscode.version,
        localFileSystem: 'Node fs temporary directory + vscode.workspace.fs provider',
        directoryCount: DIRECTORY_COUNT,
        filesPerDirectory: FILES_PER_DIRECTORY,
        baselineMilliseconds: baselineSamples,
        baselineMedianMilliseconds: median(baselineSamples),
        baselineReads,
        coldMilliseconds: coldSamples,
        coldMedianMilliseconds: median(coldSamples),
        coldReads,
        warmMilliseconds: warmSamples,
        warmMedianMilliseconds: median(warmSamples),
        warmReads,
        freshMilliseconds: freshSamples,
        freshMedianMilliseconds: median(freshSamples),
        freshReads,
        snapshotHintMilliseconds: snapshotSamples,
        snapshotHintMedianMilliseconds: median(snapshotSamples),
        snapshotHintReads,
        notes: 'provider 層量測，不含 renderer 繪製；量級為單次點估計',
      })}`);
    } finally {
      provider?.dispose();
      harness.dispose();
      store.dispose();
    }
  });
});
