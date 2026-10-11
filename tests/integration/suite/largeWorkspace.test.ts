import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import type { SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { createPaneProvider, createPaneStateHarness, seedPane } from './helpers';

const enabled = process.env.S4_4_PERF === '1';
const requestedPhase = process.env.S4_4_PERF_PHASE;
const phase = requestedPhase === 'before' || requestedPhase === 'after' ? requestedPhase : 'unspecified';
const FILES_PER_DIRECTORY = 50;
const DIRECTORY_COUNT = 1000;
const EXPECTED_FILE_COUNT = FILES_PER_DIRECTORY * DIRECTORY_COUNT;
const MEMORY_SAMPLE_INTERVAL_MS = 100;

suite('S4R4 F-44 大型工作區效能基線', () => {
  test('量測 50,000 檔案的大型工作區操作', async function () {
    this.timeout(15 * 60 * 1000);
    if (!enabled) {
      this.skip();
    }

    let tmpRoot: string | undefined;
    let config: vscode.WorkspaceConfiguration | undefined;
    let previousSpaces: { workspaceValue?: unknown; globalValue?: unknown } | undefined;
    let settingsUpdateStarted = false;
    let store: SpaceStore | undefined;
    let provider: SpaceTreeDataProvider | undefined;
    let sampler: ReturnType<typeof setInterval> | undefined;
    const memorySamples: { elapsedMilliseconds: number; heapUsed: number; rss: number }[] = [];
    let startHeap: NodeJS.MemoryUsage | undefined;
    let memoryStarted = 0;
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => void | PromiseLike<void>): Promise<void> => {
      try { await action(); }
      catch (error) { cleanupErrors.push(error); }
    };

    try {
      const fixtureStarted = performance.now();
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-s4-4-'));
      for (let directoryIndex = 0; directoryIndex < DIRECTORY_COUNT; directoryIndex += 1) {
        const directory = path.join(tmpRoot, `directory-${String(directoryIndex).padStart(4, '0')}`);
        fs.mkdirSync(directory);
        for (let fileIndex = 0; fileIndex < FILES_PER_DIRECTORY; fileIndex += 1) {
          fs.writeFileSync(path.join(directory, `file-${String(fileIndex).padStart(2, '0')}.txt`), 'baseline');
        }
      }
      const fixtureCreationMilliseconds = performance.now() - fixtureStarted;

      config = vscode.workspace.getConfiguration('codeFolderSpaces');
      previousSpaces = config.inspect<unknown[]>('spaces');
      store = new SpaceStore();
      // S4R6：provider 綁定單一 pane（paneId 為狀態 key）。
      const { state: viewState } = createPaneStateHarness();
      await seedPane(viewState, 'pane1', { root: tmpRoot });
      startHeap = process.memoryUsage();
      memoryStarted = performance.now();
      sampler = setInterval(() => {
        const memory = process.memoryUsage();
        memorySamples.push({ elapsedMilliseconds: performance.now() - memoryStarted, heapUsed: memory.heapUsed, rss: memory.rss });
      }, MEMORY_SAMPLE_INTERVAL_MS);

      settingsUpdateStarted = true;
      await config.update('spaces', [{ path: tmpRoot }], vscode.ConfigurationTarget.Global);
      provider = createPaneProvider(store, viewState, 'pane1');
      const roots = await provider.getChildren() as SpaceNode[];
      assert.equal(roots.length, 1);
      const root = roots[0];

      const measureThree = async <T>(run: () => Promise<T>, validate?: (result: T) => void | Promise<void>): Promise<{ milliseconds: number[]; result: T }> => {
        await validate?.(await run()); // 暖機；OS 與 VS Code 檔案系統快取狀態不可控
        const milliseconds: number[] = [];
        let result!: T;
        for (let sample = 0; sample < 3; sample += 1) {
          const started = performance.now();
          result = await run();
          milliseconds.push(performance.now() - started);
          await validate?.(result);
        }
        return { milliseconds, result };
      };

      const rootLoad = await measureThree(async () => await provider!.getChildren() as SpaceNode[], nodes => assert.equal(nodes.length, 1));

      const rootExpand = await measureThree(async () => {
        provider!.refresh();
        return await provider!.getChildren(root) as SpaceNode[];
      }, nodes => {
        assert.equal(nodes.length, DIRECTORY_COUNT);
        assert.equal(nodes[0].label, 'directory-0000');
        assert.equal(nodes[DIRECTORY_COUNT - 1].label, 'directory-0999');
      });
      const representative = rootExpand.result[Math.floor(DIRECTORY_COUNT / 2)];
      const representativeExpand = await measureThree(async () => {
        provider!.refresh();
        return await provider!.getChildren(representative) as SpaceNode[];
      }, nodes => {
        assert.equal(nodes.length, FILES_PER_DIRECTORY);
        assert.equal(nodes[0].label, 'file-00.txt');
        assert.equal(nodes[FILES_PER_DIRECTORY - 1].label, 'file-49.txt');
      });

      await viewState.setPreset('pane1', 'Files');
      await viewState.setSort('pane1', 'name', 'asc');
      const flatName = await measureThree(async () => {
        provider!.refresh();
        return await provider!.getChildren(root) as SpaceNode[];
      }, nodes => {
        assert.equal(nodes.length, EXPECTED_FILE_COUNT);
        assert.equal(nodes[0].label, 'file-00.txt');
        assert.equal(nodes[EXPECTED_FILE_COUNT - 1].label, 'file-49.txt');
        assert.ok(nodes.some(node => node.resourceUri?.fsPath.endsWith(path.join('directory-0500', 'file-00.txt'))));
      });

      await viewState.setSort('pane1', 'mtime', 'asc');
      const flatMtime = await measureThree(async () => {
        provider!.refresh(); // 每次量測前清除 provider 的 stat 備忘錄
        return await provider!.getChildren(root) as SpaceNode[];
      }, async nodes => {
        assert.equal(nodes.length, EXPECTED_FILE_COUNT);
        const stride = 50;
        const sampledNodes = nodes.filter((_, index) => index % stride === 0);
        const times: number[] = [];
        for (let offset = 0; offset < sampledNodes.length; offset += 16) {
          const batch = sampledNodes.slice(offset, offset + 16);
          const batchTimes = await Promise.all(batch.map(async node => {
            assert.equal(node.resourceUri?.scheme, 'file');
            return (await vscode.workspace.fs.stat(node.resourceUri!)).mtime;
          }));
          times.push(...batchTimes);
        }
        for (let index = 1; index < times.length; index += 1) {
          assert.ok(times[index] >= times[index - 1], `sampled mtime order violated at sample ${index}`);
        }
        assert.equal(new Set(nodes.map(node => node.resourceUri!.fsPath)).size, EXPECTED_FILE_COUNT);
      });

      const finalHeap = process.memoryUsage();
      const peakHeapSample = memorySamples.reduce((peak, sample) => sample.heapUsed > peak.heapUsed ? sample : peak, { elapsedMilliseconds: 0, heapUsed: startHeap.heapUsed, rss: startHeap.rss });
      const peakRssSample = memorySamples.reduce((peak, sample) => sample.rss > peak.rss ? sample : peak, { elapsedMilliseconds: 0, heapUsed: startHeap.heapUsed, rss: startHeap.rss });
      const peakHeap = Math.max(startHeap.heapUsed, finalHeap.heapUsed, peakHeapSample.heapUsed);
      const peakRss = Math.max(startHeap.rss, finalHeap.rss, peakRssSample.rss);
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
      const result = {
        phase,
        platform: { platform: process.platform, release: os.release(), arch: process.arch, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model },
        runtime: { node: process.version, vscode: vscode.version },
        fixture: { root: tmpRoot, uniqueMkdtemp: true, directoryCount: DIRECTORY_COUNT, filesPerDirectory: FILES_PER_DIRECTORY, fileCount: EXPECTED_FILE_COUNT, depth: 2, creationMilliseconds: fixtureCreationMilliseconds },
        operations: {
          initialRootLoad: { meaning: 'provider.getChildren() for space roots; not complete extension activation', samplesMilliseconds: rootLoad.milliseconds, medianMilliseconds: median(rootLoad.milliseconds) },
          rootSingleLevelExpand: { samplesMilliseconds: rootExpand.milliseconds, medianMilliseconds: median(rootExpand.milliseconds), expectedChildren: DIRECTORY_COUNT },
          representativeDirectoryExpand: { path: 'directory-0500', samplesMilliseconds: representativeExpand.milliseconds, medianMilliseconds: median(representativeExpand.milliseconds), expectedChildren: FILES_PER_DIRECTORY },
          flatFilesName: { samplesMilliseconds: flatName.milliseconds, medianMilliseconds: median(flatName.milliseconds), expectedEntries: EXPECTED_FILE_COUNT },
          flatFilesMtime: { samplesMilliseconds: flatMtime.milliseconds, medianMilliseconds: median(flatMtime.milliseconds), expectedEntries: EXPECTED_FILE_COUNT },
        },
        cacheAndStrategy: { warmupsPerOperation: 1, measuredSamplesPerOperation: 3, coldCache: 'not guaranteed; OS and VS Code filesystem caches uncontrolled', warmCache: 'one same-operation warmup before each 3 samples', statMemo: 'provider StatCache cleared with refresh before tree/flat expansion samples', statConcurrency: 'sortEntries uses bounded concurrency 16; directory visible-child checks use bounded concurrency 16' },
        memory: { before: { heapUsed: startHeap.heapUsed, rss: startHeap.rss }, after: { heapUsed: finalHeap.heapUsed, rss: finalHeap.rss }, sampledPeak: { heapUsed: peakHeap, heapElapsedMilliseconds: peakHeapSample.elapsedMilliseconds, rss: peakRss, rssElapsedMilliseconds: peakRssSample.elapsedMilliseconds }, samplingIntervalMilliseconds: MEMORY_SAMPLE_INTERVAL_MS, sampleCount: memorySamples.length },
      };
      console.log(`S4R4-PERFORMANCE-BASELINE ${JSON.stringify(result)}`);
    } finally {
      if (sampler) clearInterval(sampler);
      await cleanup(() => provider?.dispose());
      await cleanup(() => store?.dispose());
      if (settingsUpdateStarted && config) {
        await cleanup(() => config!.update('spaces', previousSpaces?.workspaceValue, vscode.ConfigurationTarget.Workspace));
        await cleanup(() => config!.update('spaces', previousSpaces?.globalValue, vscode.ConfigurationTarget.Global));
      }
      if (tmpRoot) await cleanup(() => fs.rmSync(tmpRoot!, { recursive: true, force: true }));
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '大型工作區效能測試清理失敗');
    }
  });
});
