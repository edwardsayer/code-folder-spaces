import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DirectoryCache, defaultDirectoryCacheLimits } from '../../../src/spaces/directoryCache';
import type { DirectoryEntry } from '../../../src/spaces/directoryCache';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import type { PaneProviderScope, SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';
import { SpaceRootNode, SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { PaneStateStore } from '../../../src/spaces/viewState';
import { clearGlobalSettings, createPaneStateHarness, paneScopeFor, seedPane } from './helpers';

// F-44（S4R7 W2）provider 接線整合測試；契約見 dev/specs/directory-cache-and-refresh-design.md（D79–D85）。
// 以真實臨時目錄＋`vscode.workspace.fs` 驗證：
// 1. 快照只作 chevron 提示，不生成實際顯示列（D79）。
// 2. 寫入／刪除後 refresh 不保留舊結果（D83）。
// 3. 代次守護：refresh／setScope 之後，舊代次列舉不得有跨代副作用（含 filterMessage）。
// 4. `whenSettled()` 只保證已開始的讀取收斂（D84）；不承諾 renderer 已繪製。
// 可注入的快取一律用長記憶體 TTL，讓「refresh 前命中快取、refresh 後失效」可被確定性觀察；
// 只有自建快取的 revalidate 自動重繪案例需要等待預設 2 秒 TTL。

const textEncoder = new TextEncoder();

interface CacheHarness {
  cache: DirectoryCache;
  /** 每次實際打來源的 URI key（依序）；失敗時附加 `#error` 標記。 */
  reads: string[];
  /** 背景 revalidate 實際改變內容而通知的 URI key。 */
  revalidated: string[];
  readsOf: (uri: vscode.Uri) => number;
  /** 讓之後的目錄讀取等待，直到 `releaseGate()`；用於構造確定性的併發交錯。 */
  armGate: () => void;
  releaseGate: () => void;
  dispose: () => void;
}

/** 以 `workspace.fs` 為來源建立可注入 provider 的快取（記憶體 TTL 拉長到 600 秒）。 */
function createCacheHarness(): CacheHarness {
  const reads: string[] = [];
  const revalidated: string[] = [];
  let gated = false;
  const waiters: (() => void)[] = [];
  const readDirectory = async (uri: string): Promise<DirectoryEntry[]> => {
    reads.push(uri);
    if (gated) {
      await new Promise<void>(resolve => waiters.push(resolve));
    }
    try {
      return await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri));
    } catch (error) {
      reads.push(`${uri}#error`);
      throw error;
    }
  };
  const cache = new DirectoryCache({
    readDirectory,
    limits: { memoryTtlMs: 600_000 },
    onDidRevalidate: uri => revalidated.push(uri),
  });
  return {
    cache,
    reads,
    revalidated,
    readsOf: uri => reads.filter(entry => entry === uri.toString()).length,
    armGate: () => { gated = true; },
    releaseGate: () => {
      gated = false;
      waiters.splice(0, waiters.length).forEach(resolve => resolve());
    },
    dispose: () => cache.dispose(),
  };
}

/** 建立臨時目錄樹；值為 null 時建立空資料夾。 */
function makeTree(entries: Record<string, string | null>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-folder-spaces-dircache-'));
  for (const [relative, content] of Object.entries(entries)) {
    const target = path.join(root, relative);
    if (content === null) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

interface PaneFixture {
  state: PaneStateStore;
  provider: SpaceTreeDataProvider;
  /** 換根後以 pane 狀態重建 scope 並同步 provider（語意同 extension.ts 的 applyPaneScope）。 */
  setRoot: (root: string) => Promise<void>;
  dispose: () => void;
}

async function createPaneFixture(root: string, cache: DirectoryCache | undefined): Promise<PaneFixture> {
  const store = new SpaceStore();
  const { state } = createPaneStateHarness();
  await seedPane(state, 'pane1', { roots: [root] });
  const scopeFor = (): PaneProviderScope => {
    const scope = paneScopeFor(store, state, 'pane1');
    if (!scope) throw new Error('pane1 沒有 root，無法建立 provider scope');
    return scope;
  };
  const provider = new SpaceTreeDataProvider(store, state, scopeFor(), cache);
  return {
    state,
    provider,
    setRoot: async (nextRoot: string) => {
      await state.switchRoot('pane1', nextRoot);
      provider.setScope(scopeFor());
    },
    dispose: () => {
      provider.dispose();
      store.dispose();
    },
  };
}

/** 取得未渲染的根 scope，供測試內部呼叫根列舉分支。 */
async function rootOf(provider: SpaceTreeDataProvider): Promise<SpaceNode> {
  const definition = provider.scope?.definitions[0];
  assert.ok(definition, 'pane 必須有一個根定義');
  return new SpaceRootNode(definition, provider.scope!.paneId);
}

function labels(nodes: readonly SpaceNode[]): string[] {
  return nodes.map(node => String(node.label));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(check: () => boolean, timeoutMilliseconds = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (check()) return true;
    await delay(50);
  }
  return check();
}

suite('F-44 目錄快取與 refresh 一致性', () => {
  const temporaryRoots: string[] = [];
  function tree(entries: Record<string, string | null>): string {
    const root = makeTree(entries);
    temporaryRoots.push(root);
    return root;
  }
  suiteTeardown(async () => {
    for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
    await clearGlobalSettings();
  });

  test('快照只作 chevron 提示：顯示列不出現快照幽靈檔，revalidate 後目錄提示收斂', async () => {
    const root = tree({ 'root-note.md': 'note', 'phantom-hint': null });
    const rootUri = vscode.Uri.file(root);
    const hintDirUri = vscode.Uri.joinPath(rootUri, 'phantom-hint');
    const harness = createCacheHarness();
    // 預載快照：根目錄宣稱有一個磁碟上不存在的 ghost.md，空目錄宣稱有子項。
    harness.cache.loadSnapshot({
      version: 1,
      entries: [
        { uri: rootUri.toString(), time: Date.now(), children: [['root-note.md', 1], ['phantom-hint', 2], ['ghost.md', 1]] },
        { uri: hintDirUri.toString(), time: Date.now(), children: [['ghost-child.md', 1]] },
      ],
    });
    const fixture = await createPaneFixture(root, harness.cache);
    try {
      const rootNode = await rootOf(fixture.provider);
      const children = await fixture.provider.getChildren(rootNode) as SpaceNode[];
      // 顯示列一律 allowSnapshot=false：只有磁碟上的真實內容。
      assert.deepEqual(labels(children), ['phantom-hint', 'root-note.md']);
      assert.ok(!children.some(node => node.label === 'ghost.md'), '快照中的幽靈檔案不得進入顯示列');

      const hintRow = children.find(node => node.label === 'phantom-hint')!;
      // D79：目錄列可先用快照提示顯示「可展開」，即使實際是空目錄。
      assert.equal(hintRow.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

      await fixture.provider.whenSettled();
      assert.ok(harness.revalidated.includes(hintDirUri.toString()), 'revalidate 內容改變時應通知該目錄');

      const settled = await fixture.provider.getChildren(rootNode) as SpaceNode[];
      const settledHint = settled.find(node => node.label === 'phantom-hint')!;
      assert.equal(settledHint.collapsibleState, vscode.TreeItemCollapsibleState.None, '收斂後空目錄不可展開');
      assert.deepEqual(labels(settled), ['phantom-hint', 'root-note.md']);
      assert.deepEqual(await fixture.provider.getChildren(settledHint), []);
      // 每個目錄只打來源一次：背景 revalidate 的結果已被記憶化，沒有重複讀取／通知循環（D82）。
      assert.equal(harness.readsOf(rootUri), 1);
      assert.equal(harness.readsOf(hintDirUri), 1);
    } finally {
      fixture.dispose();
      harness.dispose();
    }
  });

  test('寫入檔案後 refresh 能看到新檔案；refresh 前仍命中快取', async () => {
    const root = tree({ 'a.md': 'a' });
    const rootUri = vscode.Uri.file(root);
    const harness = createCacheHarness();
    const fixture = await createPaneFixture(root, harness.cache);
    try {
      const rootNode = await rootOf(fixture.provider);
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md']);

      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(rootUri, 'b.md'), textEncoder.encode('b'));
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md'], '快取新鮮時不应憑空出現新檔（證明快取在讀取路徑上）');
      assert.equal(harness.readsOf(rootUri), 1);

      // D83：refresh 必須失效快取，否則新檔會遺漏到 TTL 過期。
      fixture.provider.refresh();
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md', 'b.md']);
      assert.equal(harness.readsOf(rootUri), 2);
      fixture.provider.refresh();
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md', 'b.md'], '再次 refresh 仍不得遺失新檔');
    } finally {
      fixture.dispose();
      harness.dispose();
    }
  });

  test('刪除檔案後 refresh 不復活舊項目', async () => {
    const root = tree({ 'a.md': 'a', 'gone.md': 'gone' });
    const rootUri = vscode.Uri.file(root);
    const harness = createCacheHarness();
    const fixture = await createPaneFixture(root, harness.cache);
    try {
      const rootNode = await rootOf(fixture.provider);
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md', 'gone.md']);

      await vscode.workspace.fs.delete(vscode.Uri.joinPath(rootUri, 'gone.md'));
      fixture.provider.refresh();
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md'], 'refresh 後不得保留已刪除項目');

      // 再列舉（快取新鮮）也不能讓舊檔復活。
      fixture.provider.refresh();
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md']);
      assert.equal(await fixture.provider.findNodeByPath(path.join(root, 'gone.md')), undefined);
    } finally {
      fixture.dispose();
      harness.dispose();
    }
  });

  test('setScope 換根後只列新根項目，舊代次列舉結果被丢棄', async () => {
    const rootA = tree({ 'alpha.md': 'a' });
    const rootB = tree({ 'beta.md': 'b' });
    const harness = createCacheHarness();
    const fixture = await createPaneFixture(rootA, harness.cache);
    try {
      const rootANode = await rootOf(fixture.provider);
      assert.deepEqual(labels(await fixture.provider.getChildren(rootANode) as SpaceNode[]), ['alpha.md']);

      await fixture.setRoot(rootB);
      const rootBNode = await rootOf(fixture.provider);
      const childrenOfB = await fixture.provider.getChildren(rootBNode) as SpaceNode[];
      assert.deepEqual(labels(childrenOfB), ['beta.md']);
      assert.ok(!childrenOfB.some(node => node.label === 'alpha.md'), '舊根項目不得出現在新根下');
      assert.equal(fixture.provider.filterMessage, '');

      // 換根前已開始的列舉（舊代次）必須被丢棄，不得把舊根結果帶回新代次。
      // 先 refresh 失效快取，確保接下來的列舉真的會打來源而被 gate 擋住（不依赖時序巧合）。
      fixture.provider.refresh();
      harness.armGate();
      const staleList = fixture.provider.getChildren(rootBNode);
      await fixture.setRoot(rootA);
      harness.releaseGate();
      assert.deepEqual(await staleList, [], '舊代次的列舉不得回傳結果');
      const rootANodeAgain = await rootOf(fixture.provider);
      assert.deepEqual(labels(await fixture.provider.getChildren(rootANodeAgain) as SpaceNode[]), ['alpha.md']);
    } finally {
      harness.releaseGate();
      fixture.dispose();
      harness.dispose();
    }
  });

  test('setScope（refresh）不清除快照提示（審查 F1 回歸）', async () => {
    const root = tree({ 'a.md': 'a', 'dir-x': null });
    const rootUri = vscode.Uri.file(root);
    const dirXUri = vscode.Uri.joinPath(rootUri, 'dir-x');
    const harness = createCacheHarness();
    const fixture = await createPaneFixture(root, harness.cache);
    try {
      await rootOf(fixture.provider);
      harness.cache.loadSnapshot({
        version: 1,
        entries: [{ uri: dirXUri.toString(), time: Date.now(), children: [['hinted.txt', 1]] }],
      });
      // 模擬 activate 序列：setScope 觸發 refresh；refresh 只失效 memory、保留提示層（D83 修訂）。
      await fixture.setRoot(root);
      // 擋住所有來源讀取：只有提示存活才可能同步回傳；若有缺陷（提示被清）會讀來源而阻塞逾時。
      harness.armGate();
      harness.reads.length = 0;
      const hinted = await harness.cache.read(dirXUri.toString(), true);
      assert.deepEqual(hinted, [['hinted.txt', 1]], 'setScope 後提示層必須仍在');
    } finally {
      harness.releaseGate();
      fixture.dispose();
      harness.dispose();
    }
  });

  test('filterMessage 只由當代列舉寫入；併發交錯與 refresh 後計數仍正確', async () => {
    const root = tree({ 'alpha.md': 'a', 'beta.md': 'b', 'note.txt': 'c' });
    const harness = createCacheHarness();
    const fixture = await createPaneFixture(root, harness.cache);
    try {
      const rootNode = await rootOf(fixture.provider);
      const messages: string[] = [];
      const messageListener = fixture.provider.onDidChangeFilterMessage(message => messages.push(message));
      await fixture.state.setFilter('pane1', 'alpha');
      harness.armGate();

      // 舊代次：以 filter=alpha 開始列舉，但目錄讀取被 gate 擋住。
      const staleList = fixture.provider.getChildren(rootNode);
      await fixture.state.setFilter('pane1', 'beta');
      fixture.provider.refresh();
      // 新代次：同一目錄以 filter=beta 再列舉一次。
      const currentList = fixture.provider.getChildren(rootNode);
      harness.releaseGate();

      const current = await currentList as SpaceNode[];
      await staleList;
      assert.deepEqual(labels(current), ['beta.md'], '新代次的列舉結果必須正確');
      // 舊代次完成時不得覆寫 filterMessage；只有新代次（1 個符合／3 個總數）能寫入。
      assert.equal(fixture.provider.filterMessage, '1 / 3 matches');

      await fixture.state.setFilter('pane1', 'nothing-matches');
      fixture.provider.refresh();
      // 審查 F2：refresh 不清橫幅，保留上一代計數直到新列舉完成（並以事件即時更新）。
      assert.equal(fixture.provider.filterMessage, '1 / 3 matches', 'refresh 後保留上一代計數');
      assert.deepEqual(await fixture.provider.getChildren(rootNode) as SpaceNode[], []);
      assert.equal(fixture.provider.filterMessage, '0 / 3 matches');

      await fixture.state.clearFilter('pane1');
      fixture.provider.refresh();
      assert.equal((await fixture.provider.getChildren(rootNode) as SpaceNode[]).length, 3);
      assert.equal(fixture.provider.filterMessage, '');
      messageListener.dispose();
      assert.deepEqual(messages, ['1 / 3 matches', '0 / 3 matches', ''], 'onDidChangeFilterMessage 需依序反映每次列舉結果');
    } finally {
      harness.releaseGate();
      fixture.dispose();
      harness.dispose();
    }
  });

  test('注入的共用 cache 不被 provider dispose；dispose 後不再發事件', async () => {
    const root = tree({ 'a.md': 'a' });
    const rootUri = vscode.Uri.file(root);
    const harness = createCacheHarness();
    const fixture = await createPaneFixture(root, harness.cache);
    let repaints = 0;
    const listener = fixture.provider.onDidChangeTreeData(() => { repaints += 1; });
    try {
      const rootNode = await rootOf(fixture.provider);
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['a.md']);

      fixture.provider.dispose();
      fixture.provider.refresh();
      await fixture.setRoot(root);
      await fixture.provider.whenSettled();
      assert.equal(repaints, 0, 'dispose 後 refresh／setScope 不得再發 onDidChangeTreeData');

      // 注入的共享實例仍可用：再讀同一目錄命中記憶體快取，沒有第二次打來源。
      const entries = await harness.cache.read(rootUri.toString(), false);
      assert.deepEqual(entries.map(([name]) => name), ['a.md']);
      assert.equal(harness.readsOf(rootUri), 1);
    } finally {
      listener.dispose();
      fixture.dispose();
      harness.dispose();
    }
  });

  test('自建 cache：revalidate 內容改變自動重繪本 provider，dispose 後不再觸發', async () => {
    const root = tree({ 'note.md': 'n', 'sub': null });
    const subUri = vscode.Uri.joinPath(vscode.Uri.file(root), 'sub');
    // 未注入 cache → provider 自建預設 DirectoryCache（記憶體 TTL＝defaultDirectoryCacheLimits.memoryTtlMs）。
    const fixture = await createPaneFixture(root, undefined);
    let repaints = 0;
    const listener = fixture.provider.onDidChangeTreeData(() => { repaints += 1; });
    try {
      const rootNode = await rootOf(fixture.provider);
      assert.deepEqual(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]), ['sub', 'note.md']);
      assert.equal(repaints, 0, '列舉本身不應觸發重繪');

      // 記憶體過期但快照仍在 → 目錄探測改用快照提示並背景 revalidate。
      await delay(defaultDirectoryCacheLimits.memoryTtlMs + 400);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(subUri, 'late.md'), textEncoder.encode('late'));
      await fixture.provider.getChildren(rootNode);
      assert.ok(await waitFor(() => repaints > 0), '自建 cache 的內容改變通知應重繪本 provider');

      const settled = await fixture.provider.getChildren(rootNode) as SpaceNode[];
      const subRow = settled.find(node => node.label === 'sub')!;
      assert.equal(subRow.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, '收斂後 sub 應顯示為有子項');
      assert.deepEqual(labels(await fixture.provider.getChildren(subRow) as SpaceNode[]), ['late.md']);

      // dispose 後即使目錄內容再變，已失效的自建 cache 與 provider 都不得再觸發重繪（D83）。
      const repaintsAtDispose = repaints;
      fixture.provider.dispose();
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(subUri, 'late2.md'), textEncoder.encode('late2'));
      await delay(defaultDirectoryCacheLimits.memoryTtlMs + 400);
      await fixture.provider.getChildren(rootNode);
      await fixture.provider.whenSettled();
      fixture.provider.refresh();
      assert.equal(repaints, repaintsAtDispose, 'dispose 後 cache 事件與 refresh 都不應再觸發');
      // 讀取路徑在 dispose 後仍可用（cache 直通讀取），不會留下未處理的 rejection。
      assert.ok(labels(await fixture.provider.getChildren(rootNode) as SpaceNode[]).includes('sub'));
    } finally {
      listener.dispose();
      fixture.dispose();
    }
  });
});
