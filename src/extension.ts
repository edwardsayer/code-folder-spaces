import * as vscode from 'vscode';
import * as path from 'node:path';
import type { SpaceDefinition, SpaceOrigin } from './types';
import { SpaceEntryNode, SpaceRootNode, SpaceTreeDataProvider, setLeafFolderIcon } from './spaces/spaceTreeDataProvider';
import type { SpaceNode } from './spaces/spaceTreeDataProvider';
import { SpaceStore } from './spaces/spaceStore';
import { originOf } from './spaces/spaceConfig';
import { visibleWorkspaceRoots } from './spaces/workspaceRoots';
import { DirectoryCache } from './spaces/directoryCache';
import { createRefreshScheduler } from './spaces/refreshScheduler';
import { VIEW_PRESETS, matchPresetName } from './spaces/viewPresets';
import { activeRoot, classifySpaceRename, effectiveView, normalizeSpaceKey, PaneStateStore, resolvePaneDefinitions, toggleViewMode } from './spaces/viewState';
import { isDrillDownNoop, isPaneRootDirectory, paneSlotOf } from './spaces/paneRules';
import { DEFAULT_FLAT_MAX_DEPTH } from './spaces/flatListing';
import { normalizeExcludeSetting, parseGitIgnore, shouldHideLikeExplorer, type GitIgnoreRule } from './spaces/explorerVisibility';
import { matchesAnyPattern } from './spaces/spaceConfig';
import { PaneCascadeController } from './spaces/paneCascade';
import { diffWatchers, planWatchers } from './spaces/watcherPlan';
import { copyTreeEntry, createTreeDragAndDropController } from './spaces/treeDragAndDrop';
import { canModifyFiles, isAllowedSpaceRoot, isSafeMove, isSamePath, isValidEntryName, resolvePasteTarget, hasDrillStateWithinMovedSources, SpaceClipboard, UndoStack } from './spaces/spaceActions';
import { disposeLogChannel, getLogChannel } from './util/log';
import { resolveActiveTabUri, shouldFollowActiveFile } from './spaces/followActiveFile';
import { labelledValue, selectedQuickPickId, stableQuickPickItems } from './ui/stableQuickPick';
import { clearLegacySpacesSetting } from './spaces/legacySpaces';

const MAX_PANE_INDEX = 2;
const REFRESH_DEBOUNCE_MS = 200;
const FOLLOW_DEBOUNCE_MS = 250;
// S4R7-D85 啟動事件合併與 S4R7-D81 快照持久化的時間常數。
// STARTUP_WINDOW_MS／STARTUP_MAX_WAIT_MS 為參考值（Explorer Enhanced 2800ms），待 EDH 取證後定值；
// 若實測顯示不合適須調整並記錄於 handoff。
const STARTUP_WINDOW_MS = 2800;
const STARTUP_MAX_WAIT_MS = 1000;
const SNAPSHOT_WRITE_DEBOUNCE_MS = 800;
/** 目錄快照的獨立 workspaceState key（S4R7-D81：僅 chevron 提示，不放進 panes.v2、不寫 globalState／設定檔）。 */
const DIRECTORY_SNAPSHOT_KEY = 'codeFolderSpaces.directorySnapshot.v1';

/** Public surface returned from `activate()` for other extensions. */
export interface FolderSpacesApi {
  readonly version: string;
  /** 已設定的資料夾空間，包含其來源設定層。 */
  getSpaces(): Array<{ name: string; basePath: string; origin: SpaceOrigin }>;
  /** 目前啟用的窗格：id／root／roots／佈局模式／固定插槽。 */
  getPanes(): Array<{ id: string; root: string | null; roots: string[]; mode: 'tree' | 'dual'; slot: 'primary' | 'secondary' }>;
}

/** Runtime of one enabled pane: provider + TreeView + cascade scope (paneId-keyed, S4R6). */
interface PaneRuntime {
  id: string;
  provider: SpaceTreeDataProvider;
  treeView: vscode.TreeView<SpaceNode>;
  scope?: { paneId: string; root: string | null };
  staleRoot?: string;
  disposables: vscode.Disposable[];
}

interface NodeInfo {
  paneId: string;
  uri: vscode.Uri;
  isDirectory: boolean;
  definition: SpaceDefinition;
}

function paneIndexOf(paneId: string): number {
  const match = /^pane([1-8])$/.exec(paneId);
  return match ? Number(match[1]) : 0;
}

export async function activate(context: vscode.ExtensionContext): Promise<FolderSpacesApi> {
  setLeafFolderIcon(context.extensionUri);
  const log = getLogChannel();
  log.info('Activating Folder Spaces');

  // v2-R2（決策 c'）：必須在建立 SpaceStore 之前清除舊 `spaces`，否則它的空值會遮蔽
  // `spaces.workspace`／`spaces.global` 的讀取（詳見 legacySpaces.ts 的說明與實測）。
  await clearLegacySpacesSetting(
    vscode.workspace.getConfiguration('codeFolderSpaces'),
    { workspace: vscode.ConfigurationTarget.Workspace, global: vscode.ConfigurationTarget.Global },
    log,
  );

  const store = new SpaceStore();
  // S4.1R19（使用者要求：全部 per-workspace）：
  // pane 狀態（layout／preset／filter／root）**存在 workspaceState**（每個資料夾／專案各自保留）；
  // 無工作區（開啟單一檔案或空視窗）時才退回 globalState，避免狀態無處可存。
  const hasWorkspace = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  const viewState = new PaneStateStore(hasWorkspace ? context.workspaceState : context.globalState);
  const settings = () => vscode.workspace.getConfiguration('codeFolderSpaces');
  const hiddenWorkspaceRoots = (): string[] => {
    const hidden = context.workspaceState.get<unknown>('codeFolderSpaces.hiddenWorkspaceRoots', []);
    return Array.isArray(hidden) ? hidden.filter((root): root is string => typeof root === 'string') : [];
  };
  const paneInitContext = () => ({
    primaryRoot: store.getDefinitions()[0]?.basePath,
    primaryView: VIEW_PRESETS.Explorer,
  });
  const layout = await viewState.initialize(paneInitContext());
  if (layout.kind === 'rebuilt') {
    log.warn(`Rebuilt default pane layout: ${layout.reason}`);
  } else {
    log.info(`Pane layout ${layout.kind}; ${viewState.getEnabledPaneIds().length} pane(s)`);
  }
  // S4.1R17（OP-6）：首次安裝且無已配置 space 時，以**工作區根**作為主窗格預設根，
  // 使上方窗格內容與內建 File Explorer 一致。
  // 只寫入 pane 狀態（globalState），**不**寫入使用者設定；且僅在「該窗格 root 為空且無已配置 space」時套用。
  if (layout.kind === 'created' || layout.kind === 'rebuilt') {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const primaryId = viewState.getEnabledPaneIds()[0];
    if (workspaceRoot && primaryId && viewState.get(primaryId).roots.length === 0 && store.getDefinitions().length === 0) {
      await viewState.switchRoot(primaryId, workspaceRoot);
      log.info(`Seeded primary pane root from workspace folder: ${workspaceRoot}`);
    }
  }

  // 所有 pane 與命令共用 session-only undo；回呼延後取用後方建立的服務。
  const undoStack = new UndoStack();
  const clipboard = new SpaceClipboard();

  // --- 共享目錄快取與快照持久化（S4R7 W3，D79–D83） -------------------------

  const directoryCache = new DirectoryCache({
    // URI 以 toString／parse 往返：cache key 為完整序列化 URI（D80），provider 端同樣用 uri.toString()。
    readDirectory: async uri => await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri)),
    onError: (uri, error) => log.error(`Directory listing failed for ${uri}: ${String(error)}`),
    // cache 為跨 pane 共享，revalidate 一律重繪所有 pane（provider 注入時不自接預設回呼）。
    onDidRevalidate: () => {
      repaintAllPanes();
      void reconcilePaneRoots();
      scheduleSnapshotWrite();
    },
    // D81：成功驗證並記憶化後排定持久化（800ms debounce，避免展開期間頻繁寫入）。
    onDidStore: () => scheduleSnapshotWrite(),
  });
  // 啟動先載入快照（僅提示用途）再建立 pane（D79：不引入舊的可操作檔案列）。
  const loadedSnapshot = context.workspaceState.get(DIRECTORY_SNAPSHOT_KEY);
  const loadedSnapshotEntries = (loadedSnapshot && typeof loadedSnapshot === 'object' && Array.isArray((loadedSnapshot as { entries?: unknown[] }).entries))
    ? (loadedSnapshot as { entries: unknown[] }).entries.length
    : 0;
  directoryCache.loadSnapshot(loadedSnapshot);

  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshotJson = '';
  let lastSnapshotHadEntries = loadedSnapshotEntries > 0;
  const writeSnapshot = (): void => {
    // exportSnapshot 內建 1MiB 上限（D81）；內容未變不重複寫入；失敗只記錄、不拋出。
    const snapshot = directoryCache.exportSnapshot();
    const entries = Array.isArray((snapshot as { entries?: unknown[] }).entries) ? (snapshot as { entries: unknown[] }).entries : [];
    if (entries.length === 0 && lastSnapshotHadEntries) {
      // 審查 F4：不以空集合覆寫既有非空提示（提示會在使用時背景 revalidate，D79）。
      return;
    }
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshotJson) {
      return;
    }
    lastSnapshotJson = json;
    lastSnapshotHadEntries = entries.length > 0;
    void context.workspaceState.update(DIRECTORY_SNAPSHOT_KEY, snapshot)
      .then(undefined, error => log.error(`Failed to persist directory snapshot: ${String(error)}`));
  };
  const scheduleSnapshotWrite = (): void => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      writeSnapshot();
    }, SNAPSHOT_WRITE_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void syncWorkspaceDirectory();
    })
  );
  context.subscriptions.push(new vscode.Disposable(() => {
    // deactivate 無法 await：debounce 尚未觸發時同步排定最後一次寫入（接受丟失 800ms 內變動的取捨，快照僅提示）。
    // 與 cache.dispose 合併為單一註冊：無論 subscriptions 處置順序，寫入必在 dispose 前（dispose 會清空 stores，造成匯出空快照覆寫好資料）。
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
      writeSnapshot();
    }
    directoryCache.dispose();
  }));

  const paneRuntime = new Map<string, PaneRuntime>();

  /** S4.1R17：讀取並夾限 `codeFolderSpaces.maxDepth`（1–100，預設 10）。
   *  非法值（非整數／NaN／越界）一律回退到預設，不讓設定值弄壞列舉。 */
  const readMaxDepth = (): number => {
    const raw = settings().get<number>('maxDepth', DEFAULT_FLAT_MAX_DEPTH);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_FLAT_MAX_DEPTH;
    const rounded = Math.floor(raw);
    if (rounded < 1) return 1;
    // 硬上限 100：與 min/max 宣告一致，亦避免遞迴爆棧。
    return Math.min(100, rounded);
  };

  /** S4.1R13：只重繪指定的 pane（避免全樹重繪）；重複 id 去重、null／undefined 忽略。
   *  宣告提前至 cascadeController 之前，供其 switchRoot callback（延遲執行）安全引用。 */
  const refreshLinkRows = (...paneIds: Array<string | null | undefined>): void => {
    for (const paneId of new Set(paneIds.filter((id): id is string => Boolean(id)))) {
      paneRuntime.get(paneId)?.provider.refresh();
    }
  };

  /** 子窗格鏈結變更後，重繪它的父窗格（父列上的「→ Folder Space n」標記所在）。 */
  const refreshParentLinkRow = (): void => refreshLinkRows('pane1');
  const cascadeDisposables = new Map<string, vscode.Disposable>();
  const cascadeController = new PaneCascadeController({
    state: {
      getMode: () => viewState.getMode(),
      // D74：父 pane 每次選取不同資料夾時寫入子 root（手動值自然被取代），不關閉 follow。
      switchRoot: async (paneId, root) => {
        await viewState.switchRoot(paneId, root);
        applyPaneScope(paneId);
        rebuildWatchers();
        await syncPaneContexts();
        refreshParentLinkRow();
      },
      // S4.1R11-D6：守門以父 pane 的**全部** root 判定（審查 P1-2），
      // 否則多 root pane 選取 roots[1..N] 內的資料夾時 follow 不會連動。
      getPaneRoots: (paneId: string) => viewState.get(paneId).roots,
    },
    getRuntime: paneId => paneRuntime.get(paneId),
    // D67：選取項必須位於父 pane 自己的 root 之內（防禦性；不再要求位於子 pane 舊 root 內）。
    isAllowedRoot: (paneRoots, candidate) => paneRoots.some(paneRoot => isAllowedSpaceRoot(paneRoot, candidate)),
    stat: async uri => await vscode.workspace.fs.stat(uri),
    directoryType: vscode.FileType.Directory,
    onError: error => { void vscode.window.showErrorMessage(vscode.l10n.t('Invalid folder space link: {0}', String(error))); },
    // S4.1R19（Bug C）：子窗格還沒設根時提示一次，而不是讓使用者「點了以為壞了」。
    onEmptyChild: childPaneId => {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Folder Space {0} has no folder yet: use Switch Root to pick one.', paneIndexOf(childPaneId)),
      );
    },
  });
  context.subscriptions.push(cascadeController);

  const nodeInfo = (node: unknown): NodeInfo | undefined => {
    // 審查 F-02：改為**結構型**判定（不再用 instanceof），讓命令可被可注入的節點驅動
    // （整合測試跨 bundle 時 instanceof 會失敗，使命令接線失去自動化覆蓋）。
    if (!node || typeof node !== 'object') return undefined;
    const candidate = node as {
      uri?: vscode.Uri;
      isDirectory?: unknown;
      paneId?: unknown;
      definition?: SpaceDefinition;
      space?: SpaceDefinition;
    };
    if (!candidate.uri || typeof candidate.uri.fsPath !== 'string') return undefined;
    if (typeof candidate.paneId !== 'string' || candidate.paneId.length === 0) return undefined;
    const isRoot = Boolean(candidate.definition);
    const definition = candidate.definition ?? candidate.space;
    if (!definition) return undefined;
    return {
      paneId: candidate.paneId,
      uri: candidate.uri,
      isDirectory: isRoot ? true : candidate.isDirectory === true,
      definition,
    };
  };

  const requireTrust = (): boolean => {
    if (canModifyFiles(vscode.workspace.isTrusted)) return true;
    void vscode.window.showWarningMessage(vscode.l10n.t('Trust the workspace before modifying files.'));
    return false;
  };
  const operationError = (error: unknown): void => {
    log.error(`File operation failed: ${String(error)}`);
    void vscode.window.showErrorMessage(vscode.l10n.t('File operation failed: {0}', String(error)));
  };

  // --- pane runtimes ------------------------------------------------------

  const paneDefinitionsFor = (paneId: string): SpaceDefinition[] => resolvePaneDefinitions(viewState.get(paneId), store.getDefinitions());
  const paneDefinitionFor = (paneId: string): SpaceDefinition | null => paneDefinitionsFor(paneId)[0] ?? null;

  const applyPaneScope = (paneId: string): void => {
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    const pane = viewState.get(paneId);
    const definitions = paneDefinitionsFor(paneId);
    const root = activeRoot(pane);
    runtime.scope = root ? { paneId, root } : undefined;
    runtime.provider.expandRoot = paneSlotOf(paneId) === 'secondary';
    runtime.provider.setScope(definitions.length > 0 ? { paneId, definitions } : undefined);
    // S4.1：pane 標題一律為「Folder Space <n>」（根路徑由 description 顯示）。
    runtime.treeView.title = vscode.l10n.t('Folder Space {0}', paneIndexOf(paneId));
    runtime.treeView.description = definitions.length === 1
      ? root ?? paneDefinitionFor(paneId)?.basePath ?? definitions[0].basePath
      : definitions.length > 1 ? vscode.l10n.t('{0} folders', definitions.length) : '';
  };

  const createPaneDragAndDrop = (paneId: string) => createTreeDragAndDropController(paneId, {
    // 拖放內部／外部判斷以目前所有 pane 的 root 為界（D67/D68：pane 即獨立空間）。
    getDefinitions: () => [...paneRuntime.values()].flatMap(runtime => runtime.provider.scope?.definitions ?? []),
    undoStack,
    requireTrust: () => requireTrust(),
    clearDrillStateForMovedSources: sources => clearDrillStateForMovedSources(sources),
    onChanged: () => { for (const runtime of paneRuntime.values()) runtime.provider.refresh(); rebuildWatchers(); void syncContext(); },
    onError: error => operationError(error),
  });

  // S4.1R4：標題列「收合全部／展開」切換——樹無 expandAll API，「展開」＝展開目前層級一層（expandLevelForPane）。
  const collapsedPanes = new Set<string>();
  // S4.1R5（OP-8）：記錄各 pane 已展開節點 id，供「Expand level」判斷下一個尚未展開的層級（逐次加深）。
  const expandedIds = new Map<string, Set<string>>();
  const expandedSet = (paneId: string): Set<string> => {
    let set = expandedIds.get(paneId);
    if (!set) { set = new Set(); expandedIds.set(paneId, set); }
    return set;
  };
  const setCollapsedContext = async (paneId: string): Promise<void> => {
    await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${paneId}.collapsed`, collapsedPanes.has(paneId));
  };

  const createPane = (paneId: string): PaneRuntime => {
    // 第 4 參注入共享 cache（W2 凍結的簽名：store, viewState, scope?, directoryCache?）；注入時 provider 不 dispose 它。
    // 第 5 參（S4.1R13）：父側鏈路標記；僅 follow 子窗格目前指向的資料夾會標示。
    const provider = new SpaceTreeDataProvider(store, viewState, undefined, directoryCache, undefined);
    const treeView = vscode.window.createTreeView(`codeFolderSpaces.${paneId}`, {
      treeDataProvider: provider,
      showCollapseAll: false, // S4.1R4：改用自訂「收合全部／展開」切換按鈕（paneN.collapseAll／expandAll）
      dragAndDropController: createPaneDragAndDrop(paneId),
    });
    // S4.1R17：把 `codeFolderSpaces.maxDepth` 注入 provider（建構後設定，避免改動既有建構子簽名）。
    provider.maxDepth = readMaxDepth();
    // S4.1R20（使用者）：跟隨 Explorer 的隱藏規則（files.exclude + explorer.excludeGitIgnore）。
    provider.explorerVisibility = explorerVisibility.check;
    const runtime: PaneRuntime = { id: paneId, provider, treeView, disposables: [] };
    runtime.disposables.push(
      provider,
      treeView,
      treeView.onDidExpandElement(event => {
        const id = (event.element as vscode.TreeItem).id;
        if (id) expandedSet(paneId).add(id);
        if (collapsedPanes.delete(paneId)) void setCollapsedContext(paneId);
      }),
      treeView.onDidCollapseElement(event => {
        const id = (event.element as vscode.TreeItem).id;
        if (id) expandedSet(paneId).delete(id);
      }),
      provider.onDidChangeTreeData(() => {
        if (!runtime.staleRoot) treeView.message = provider.filterMessage;
        // D81：樹活動後排定快照寫入——展開／重繪觸發的列舉完成後，持久化最新快照（800ms debounce）。
        scheduleSnapshotWrite();
      }),
      // 審查 F2：列舉完成後即時更新過濾橫幅（fire 時機在列舉前，僅靠 onDidChangeTreeData 會讀到舊值）。
      provider.onDidChangeFilterMessage(() => {
        if (!runtime.staleRoot) treeView.message = provider.filterMessage;
      }),
    );
    // active-file follow 跟「主 pane」（最低編號啟用窗格，S4.1R3-D：pane1 可關閉）；每個 pane 的可見性變化都重新排程。
    runtime.disposables.push(treeView.onDidChangeVisibility(scheduleFollow));
    context.subscriptions.push(new vscode.Disposable(() => { for (const disposable of runtime.disposables) disposable.dispose(); }));
    paneRuntime.set(paneId, runtime);
    return runtime;
  };

  const rootOriginAttached = new Set<string>();
  // v2-R2：`root.isGlobal` context listener 只註冊一次／pane（插槽重用時於 disposePane 清除）。
  const disposePane = (paneId: string): void => {
    cascadeDisposables.get(paneId)?.dispose();
    cascadeDisposables.delete(paneId);
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    for (const disposable of runtime.disposables.reverse()) disposable.dispose();
    paneRuntime.delete(paneId);
    // 插槽可能被重用：清除該 pane 的收合狀態與 context key，避免新 pane 顯示舊狀態。
    collapsedPanes.delete(paneId);
    expandedIds.delete(paneId);
    rootOriginAttached.delete(paneId);
    void setCollapsedContext(paneId);
  };

  const attachPaneCascade = (runtime: PaneRuntime): void => {
    if (cascadeDisposables.has(runtime.id)) return;
    const disposable = cascadeController.attach(runtime.id, listener => runtime.treeView.onDidChangeSelection(event => {
      const selection = event.selection[0];
      const info = nodeInfo(selection);
      listener(info ? { uri: info.uri, isDirectory: info.isDirectory } : undefined);
    }));
    cascadeDisposables.set(runtime.id, disposable);
  };

  /**
   * v2-R2：`codeFolderSpaces.root.isGlobal` context key 必須由**所有** pane 的選取驅動。
   * 不可依附在 `attachPaneCascade` 內——`PaneCascadeController.attach` 對非 pane1 會 early-return，
   * 導致在 pane2 選取 root 時右鍵選單（Mark／Unmark Global）依舊值顯示錯誤項目。
   */
  const attachRootOriginContext = (runtime: PaneRuntime): void => {
    if (rootOriginAttached.has(runtime.id)) return;
    rootOriginAttached.add(runtime.id);
    runtime.disposables.push(runtime.treeView.onDidChangeSelection(event => {
      const selection = event.selection[0];
      void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.root.isGlobal',
        selection instanceof SpaceRootNode && originOf(selection.definition) === 'global');
    }));
  };


  /**
   * OP-15：Follow Workspace Directory。
   * 當開啟新專案或切換工作區時，若啟用此設定，主窗格（primary pane，通常為 pane1）
   * 的根目錄自動同步對齊目前工作區的第一個資料夾。
   */
    const syncWorkspaceDirectory = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const hidden = hiddenWorkspaceRoots();
    const visible = visibleWorkspaceRoots(folders.map(folder => folder.uri.fsPath), hidden);
    const current = viewState.get('pane1').roots;
    if (settings().get<boolean>('followWorkspaceDirectory', true) &&
        (current.length !== visible.length || current.some((root, index) => !isSamePath(root, visible[index])))) {
      if (visible.length === 0 && current.length > 0) {
        getLogChannel().info('All workspace roots are hidden; keeping current pane1 roots.');
        return;
      }
      await viewState.setPaneRoots('pane1', visible);
      await paneChanged('pane1');
    }
  };

  const syncPaneViews = (): void => {
    const enabled = new Set(viewState.getEnabledPaneIds());
    for (const paneId of [...paneRuntime.keys()]) {
      if (!enabled.has(paneId)) disposePane(paneId);
    }
    for (const paneId of enabled) {
      if (!paneRuntime.has(paneId)) createPane(paneId);
    }
    for (const paneId of enabled) applyPaneScope(paneId);
    for (const runtime of paneRuntime.values()) attachPaneCascade(runtime);
    for (const runtime of paneRuntime.values()) attachRootOriginContext(runtime);
    rebuildWatchers();
  };


  const syncPaneContexts = async (): Promise<void> => {
    const enabled = new Set(viewState.getEnabledPaneIds());
    for (let index = 1; index <= MAX_PANE_INDEX; index++) {
      const id = `pane${index}`;
      const active = enabled.has(id);
      const pane = active ? viewState.get(id) : undefined;
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.enabled`, active);
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasRoot`, Boolean(pane && pane.roots.length > 0));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.canRemoveRoot`, Boolean(pane && pane.roots.length > 1));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasParent`, id === 'pane2' && active);
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.follow`, id === 'pane2' && active);
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasChild`, active && id === 'pane1' && enabled.has('pane2'));
    }
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', viewState.getMode());
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canAddPane', false);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canRemovePane', false);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.layoutReady', true);
  };

  const reconcilePaneRoots = async (): Promise<void> => {
    for (const runtime of paneRuntime.values()) {
      const roots = viewState.get(runtime.id).roots;
      const stale: string[] = [];
      for (const root of roots) {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(root));
          if (!isPaneRootDirectory(stat.type, vscode.FileType.Directory)) stale.push(root);
        } catch { stale.push(root); }
      }
      const staleRoot = stale.join('\n');
      if (!staleRoot) {
        if (runtime.staleRoot) {
          runtime.staleRoot = undefined;
          runtime.treeView.message = '';
          runtime.provider.refresh();
        }
        continue;
      }
      runtime.treeView.message = vscode.l10n.t('Folder space folder is stale: {0}. Select a folder in its parent folder space or reset the layout.', stale.join(', '));
      if (runtime.staleRoot !== staleRoot) void vscode.window.showWarningMessage(runtime.treeView.message);
      runtime.staleRoot = staleRoot;
    }
  };

  const paneChanged = async (paneId: string): Promise<void> => {
    expandedIds.delete(paneId); // 換根／重繪後節點展開狀態不再可靠，重新由「Expand level」逐層建立。
    applyPaneScope(paneId);
    rebuildWatchers();
    await syncPaneContexts();
    refreshParentLinkRow();
    await reconcilePaneRoots();
    await syncContext();
  };

  const repaintPane = (paneId: string): void => {
    paneRuntime.get(paneId)?.provider.refresh();
    void syncContext();
  };

  /** S4.1R13：只重繪指定的 pane（避免全樹重繪）；重複 id 去重、null／undefined 忽略。 */
  const repaintAllPanes = (): void => {
    for (const runtime of paneRuntime.values()) runtime.provider.refresh();
    void syncContext();
  };

  // --- watchers (D68: per pane root, deduplicated) ------------------------

  let watchers = new Map<string, vscode.FileSystemWatcher>();
  // D83：FS 事件立即失效快取（跨 pane 共享，全量 invalidate），UI 重繪仍走 debounce。
  const invalidateCacheAndRefresh = (): void => {
    directoryCache.invalidate();
    scheduleRefresh();
  };
  const rebuildWatchers = (): void => {
    // MR-I5：去重與建立／dispose 的決策抽至純函式 watcherPlan，使行為可單元測試（本函式只負責接線 VS Code API）。
    const desired = planWatchers([...paneRuntime.values()].map(runtime => ({
      paneId: runtime.id,
      roots: (runtime.provider.scope?.definitions ?? []).map(definition => definition.basePath),
    })));
    const plan = diffWatchers(watchers.keys(), desired);
    for (const key of plan.dispose) {
      watchers.get(key)?.dispose();
      watchers.delete(key);
    }
    const createKeys = new Set(plan.create.map(root => normalizeSpaceKey(root)));
    for (const [key, root] of desired) {
      if (!createKeys.has(key) || watchers.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
      watcher.onDidCreate(invalidateCacheAndRefresh);
      watcher.onDidDelete(invalidateCacheAndRefresh);
      watcher.onDidChange(invalidateCacheAndRefresh);
      watchers.set(key, watcher);
    }
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    for (const watcher of watchers.values()) watcher.dispose();
    watchers = new Map();
  }));

  // --- follow active file (與鏈結 follow 是不同概念，維持既有行為) ----------

  let followTimer: ReturnType<typeof setTimeout> | undefined;
  let followGeneration = 0;
  // S4.1R3：pane1 可關閉，原本寫死 pane1 的全域命令／follow 改以「主 pane」（最低編號啟用窗格）為標的。
  const primaryPaneId = (): string => viewState.getEnabledPaneIds()[0] ?? 'pane1';
  const pane1 = (): PaneRuntime | undefined => paneRuntime.get(primaryPaneId());
  /**
   * D84：reveal 前等待已開始的列舉收斂。whenSettled 內部已吸收 rejection，理論不 reject；
   * 防御性 try/catch 確保 settle 失敗不會讓 follow／命令抛出。
   */
  const settleProvider = async (provider: SpaceTreeDataProvider): Promise<void> => {
    try {
      await provider.whenSettled();
    } catch {
      // 忽略：不因 settle 失敗阻斷後續 reveal。
    }
  };

  const followActiveFile = async (generation: number, uri: vscode.Uri | undefined): Promise<void> => {
    const runtime = pane1();
    const canFollow = (): boolean => shouldFollowActiveFile({
      enabled: settings().get<boolean>('followActiveFile', true),
      generation,
      currentGeneration: followGeneration,
      visible: runtime?.treeView.visible ?? false,
    });
    if (!uri || !runtime || !canFollow()) return;
    const node = await runtime.provider.findNodeByPath(uri.fsPath);
    if (!canFollow() || !sameUri(uri, getActiveTabUri())) return;
    if (!node) return;
    // D84：reveal 前 settle；await 後重查 pane 仍啟用、root（scope 物件身份）未變、filter 未變。
    const scopeBefore = runtime.provider.scope;
    const filterBefore = viewState.get(runtime.id).filter;
    await settleProvider(runtime.provider);
    if (!canFollow() || !sameUri(uri, getActiveTabUri())) return;
    if (paneRuntime.get(runtime.id) !== runtime || runtime.provider.scope !== scopeBefore) return;
    if (viewState.get(runtime.id).filter !== filterBefore) return;
    await runtime.treeView.reveal(node, { select: true, focus: false, expand: true });
  };
  const scheduleFollow = (): void => {
    followGeneration++;
    if (followTimer) clearTimeout(followTimer);
    if (!settings().get<boolean>('followActiveFile', true)) return;
    const generation = followGeneration;
    followTimer = setTimeout(() => {
      followTimer = undefined;
      void followActiveFile(generation, getActiveTabUri());
    }, FOLLOW_DEBOUNCE_MS);
  };
  /** S4.1R20：讀取 Explorer 等價隱藏規則並回傳判斷函式。
   *  來源：`files.exclude`（值為 true 的樣式）＋（選用）`explorer.excludeGitIgnore` 開啟時的 `.gitignore`。
   *  結果快取到下次設定變更／檔案變更為止，避免每次列舉都重讀。 */
  const createExplorerVisibility = (): { check: (relativePath: string, isDirectory: boolean) => boolean; refresh: () => void } => {
    let excludePatterns: readonly string[] = [];
    let gitIgnoreRules: readonly GitIgnoreRule[] = [];
    let loaded = false;

    const load = async (): Promise<void> => {
      loaded = true;
      excludePatterns = normalizeExcludeSetting(vscode.workspace.getConfiguration('files').get<unknown>('exclude'));
      const useGitIgnore = vscode.workspace.getConfiguration('explorer').get<boolean>('excludeGitIgnore', false);
      const rules: GitIgnoreRule[] = [];
      if (useGitIgnore) {
        // 以工作區根目錄的 .gitignore 為主（多根時逐一收集）。
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          try {
            const uri = vscode.Uri.joinPath(folder.uri, '.gitignore');
            const bytes = await vscode.workspace.fs.readFile(uri);
            rules.push(...parseGitIgnore(Buffer.from(bytes).toString('utf8')));
          } catch { /* 沒有 .gitignore 是常態 */ }
        }
      }
      gitIgnoreRules = rules;
    };

    return {
      check: (relativePath, isDirectory) => {
        if (!loaded) void load();
        if (!excludePatterns.length && !gitIgnoreRules.length) return false;
        return shouldHideLikeExplorer(relativePath, isDirectory, excludePatterns, gitIgnoreRules,
          (pattern, path, name) => matchesAnyPattern(name, path, [pattern]));
      },
      refresh: () => { loaded = false; },
    };
  };
  const explorerVisibility = createExplorerVisibility();

  const followConfiguration = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codeFolderSpaces.maxDepth')) {
      // S4.1R17：設定變更後套用到所有 provider 並重繪（扁平列舉深度由 provider 持有）。
      const depth = readMaxDepth();
      for (const runtime of paneRuntime.values()) {
        runtime.provider.maxDepth = depth;
        runtime.provider.refresh();
      }
    }
    if (event.affectsConfiguration('codeFolderSpaces.followActiveFile')) {
      void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', settings().get<boolean>('followActiveFile', true));
      scheduleFollow();
    }
    if (event.affectsConfiguration('codeFolderSpaces.followWorkspaceDirectory')) void syncWorkspaceDirectory();
  });
  context.subscriptions.push(
    followConfiguration,
    vscode.window.tabGroups.onDidChangeTabs(scheduleFollow),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleFollow),
    vscode.window.onDidChangeVisibleTextEditors(scheduleFollow),
    new vscode.Disposable(() => { if (followTimer) clearTimeout(followTimer); followGeneration++; })
  );
  void vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', settings().get<boolean>('followActiveFile', true));

  // --- refresh debounce（S4R7-D85：啟動窗口內有上限合併，純邏輯在 refreshScheduler.ts） ---

  const fireRefresh = (): void => {
    for (const runtime of paneRuntime.values()) {
      runtime.provider.refresh();
      if (!runtime.staleRoot) runtime.treeView.message = runtime.provider.filterMessage;
    }
    void reconcilePaneRoots();
    scheduleFollow();
  };

  const refreshScheduler = createRefreshScheduler({
    fire: fireRefresh,
    debounceMs: REFRESH_DEBOUNCE_MS,
    startupWindowMs: STARTUP_WINDOW_MS,
    startupMaxWaitMs: STARTUP_MAX_WAIT_MS,
  });
  const scheduleRefresh = (): void => refreshScheduler.schedule();
  context.subscriptions.push(new vscode.Disposable(() => refreshScheduler.dispose()));

  // --- context keys（各 pane 的 title bar 按鈕狀態；pane1 另保留舊全域 key 供外部相容） ---

  const syncContext = async (): Promise<void> => {
    const definitions = store.getDefinitions();
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasSpaces', definitions.length > 0);
    const pane = viewState.get(primaryPaneId());
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', Boolean(pane.filter));
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canDrillUp', pane.drillStack.length > 0);
    const paneView = effectiveView(pane);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.preset', matchPresetName(paneView) ?? 'Custom');
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.viewMode', paneView.mode);
    // S4.1：每個 pane 自己的 title bar 按鈕狀態（行內按鈕一致、不再只服務 pane1）。
    const enabledIds = new Set(viewState.getEnabledPaneIds());
    for (let index = 1; index <= MAX_PANE_INDEX; index++) {
      const id = `pane${index}`;
      const state = enabledIds.has(id) ? viewState.get(id) : undefined;
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasFilter`, Boolean(state?.filter));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.canDrillUp`, Boolean(state && state.drillStack.length > 0));
      // 子選單的勾選狀態（toggled condition）。
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.preset`, state ? (matchPresetName(effectiveView(state)) ?? 'Custom') : '');
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.mode`, state ? effectiveView(state).mode : '');
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.level`, state ? String(effectiveView(state).level) : '');
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.content`, state ? effectiveView(state).content : '');
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.sort`, state ? `${state.sort.key}:${state.sort.direction}` : '');
    }
  };

  // --- file operations ------------------------------------------------------

  const getEntry = (node: unknown): { paneId: string; uri: vscode.Uri; isDirectory: boolean; basePath: string } | undefined => {
    const info = nodeInfo(node);
    return info && { paneId: info.paneId, uri: info.uri, isDirectory: info.isDirectory, basePath: info.definition.basePath };
  };
  const exists = async (uri: vscode.Uri): Promise<boolean> => { try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; } };
  const clearDrillStateForMovedSources = async (sources: vscode.Uri[]): Promise<void> => {
    const sourcePaths = sources.map(source => path.resolve(source.fsPath));
    for (const paneId of viewState.getEnabledPaneIds()) {
      const pane = viewState.get(paneId);
      const paths = [...pane.roots, ...(pane.drillRoot ? [pane.drillRoot] : []), ...pane.drillStack.map(snapshot => snapshot.root)].map(value => path.resolve(value));
      if (hasDrillStateWithinMovedSources(paths, sourcePaths)) {
        await viewState.resetRoot(paneId);
        applyPaneScope(paneId);
      }
    }
  };
  // 鍵盤快捷鍵以 keybinding `args: { paneId }` 指明焦點 pane（keybinding 不帶節點；S4.1R3），其餘沿用節點或主 pane 的選取項。
  const rootNodeForPane = (paneId: string): SpaceRootNode | undefined => {
    const root = rootOf(paneId);
    if (!root) return undefined;
    const definition = paneRuntime.get(paneId)?.provider.effectiveDefinitions().find(item => isSamePath(item.basePath, root));
    if (!definition) {
      log.warn(`No effective root definition for ${paneId}: ${root}`);
      return undefined;
    }
    return new SpaceRootNode(definition, paneId);
  };
  const selectionTarget = (node?: unknown): unknown => {
    if (node && !nodeInfo(node) && typeof (node as { paneId?: unknown }).paneId === 'string') {
      const paneId = (node as { paneId: string }).paneId;
      return paneRuntime.get(paneId)?.treeView.selection[0] ?? rootNodeForPane(paneId);
    }
    return node ?? pane1()?.treeView.selection[0] ?? rootNodeForPane(primaryPaneId());
  };
  const fileActionTarget = (node?: unknown): unknown => {
    if (nodeInfo(node)) return node;
    if (typeof (node as { paneId?: unknown } | undefined)?.paneId === 'string') return selectionTarget(node);
    return rootNodeForPane(targetPaneId(node));
  };
  const pasteEntries = async (node?: unknown): Promise<void> => {
    const payload = clipboard.get();
    const target = selectionTarget(node);
    const destinationEntry = getEntry(target);
    if (!payload || !destinationEntry) return;
    const destinationPath = resolvePasteTarget({ path: destinationEntry.uri.fsPath, isDirectory: destinationEntry.isDirectory, isRoot: target instanceof SpaceRootNode });
    // D67：允許根＝該 pane 自己的 root。
    if (!destinationPath || !isAllowedSpaceRoot(destinationEntry.basePath, destinationPath)) return;
    const destination = vscode.Uri.file(destinationPath);
    try {
      const destinationStat = await vscode.workspace.fs.stat(destination);
      if (!(destinationStat.type & vscode.FileType.Directory)) return;
      if (!requireTrust()) return;
      for (const sourcePath of payload.uris) {
        const source = vscode.Uri.parse(sourcePath);
        if (source.scheme !== destination.scheme || source.authority !== destination.authority) { void vscode.window.showErrorMessage(vscode.l10n.t('Cannot paste between different file system providers.')); continue; }
        const stat = await vscode.workspace.fs.stat(source);
        const target = vscode.Uri.joinPath(destination, path.basename(source.fsPath));
        if (!isSafeMove(source.fsPath, target.fsPath, Boolean(stat.type & vscode.FileType.Directory))) { void vscode.window.showErrorMessage(vscode.l10n.t('A folder cannot be pasted into itself or one of its subfolders.')); continue; }
        if (isSamePath(source.fsPath, target.fsPath)) continue;
        if (await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); continue; }
        if (payload.mode === 'cut') {
          await vscode.workspace.fs.rename(source, target, { overwrite: false });
          undoStack.push({ kind: 'move', from: source.fsPath, to: target.fsPath });
          clipboard.consume(sourcePath);
          await clearDrillStateForMovedSources([source]);
        } else {
          await copyTreeEntry(source, target);
        }
      }
      repaintAllPanes();
      rebuildWatchers();
    } catch (error) { operationError(error); }
  };
  const createEntry = async (node: unknown, directory: boolean): Promise<void> => {
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    const destination = entry.isDirectory ? entry.uri : vscode.Uri.file(path.dirname(entry.uri.fsPath));
    const name = await vscode.window.showInputBox({ prompt: directory ? vscode.l10n.t('Enter folder name') : vscode.l10n.t('Enter file name') });
    if (name === undefined) return;
    if (!isValidEntryName(name)) { void vscode.window.showErrorMessage(vscode.l10n.t('Enter a valid single file or folder name.')); return; }
    const target = vscode.Uri.joinPath(destination, name);
    if (!isAllowedSpaceRoot(entry.basePath, target.fsPath)) { void vscode.window.showErrorMessage(vscode.l10n.t('The destination is outside the folder space.')); return; }
    try {
      if (await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); return; }
      if (directory) await vscode.workspace.fs.createDirectory(target);
      else await vscode.workspace.fs.writeFile(target, new Uint8Array());
      repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };
  const renameEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject pane roots as defense in depth.
    if (node instanceof SpaceRootNode) return;
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    // flat Contents 的「.」群組代表 pane root 本身：同樣拒絕（S4.1R6 審查 P1）。
    if (isSamePath(entry.uri.fsPath, entry.basePath)) return;
    const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter a new name'), value: path.basename(entry.uri.fsPath) });
    if (name === undefined) return;
    if (!isValidEntryName(name)) { void vscode.window.showErrorMessage(vscode.l10n.t('Enter a valid single file or folder name.')); return; }
    const target = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(entry.uri.fsPath)), name);
    if (!isAllowedSpaceRoot(entry.basePath, target.fsPath)) { void vscode.window.showErrorMessage(vscode.l10n.t('The destination is outside the folder space.')); return; }
    try {
      await vscode.workspace.fs.stat(entry.uri);
      if (!isSamePath(entry.uri.fsPath, target.fsPath) && await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); return; }
      await vscode.workspace.fs.rename(entry.uri, target, { overwrite: false });
      undoStack.push({ kind: 'rename', from: entry.uri.fsPath, to: target.fsPath }); repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };
  const moveEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject pane roots as defense in depth.
    if (node instanceof SpaceRootNode) return;
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    // flat Contents 的「.」群組代表 pane root 本身：同樣拒絕（S4.1R6 審查 P1）。
    if (isSamePath(entry.uri.fsPath, entry.basePath)) return;
    const folders: Array<vscode.QuickPickItem & { uri: vscode.Uri }> = [];
    const pending = [vscode.Uri.file(entry.basePath)];
    try {
      while (pending.length) {
        const folder = pending.pop()!;
        const stat = await vscode.workspace.fs.stat(folder);
        if (!(stat.type & vscode.FileType.Directory)) continue;
        folders.push({ label: folder.fsPath === entry.basePath ? path.basename(entry.basePath) : path.relative(entry.basePath, folder.fsPath), description: folder.fsPath, uri: folder });
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
          if (type & vscode.FileType.Directory) pending.push(vscode.Uri.joinPath(folder, name));
        }
      }
    } catch (error) { operationError(error); return; }
    const selected = await vscode.window.showQuickPick(folders, { placeHolder: vscode.l10n.t('Choose a destination folder within this space') });
    if (!selected) return;
    if (!isSafeMove(entry.uri.fsPath, selected.uri.fsPath, entry.isDirectory)) {
      void vscode.window.showErrorMessage(vscode.l10n.t('A folder cannot be moved into itself or one of its subfolders.')); return;
    }
    const target = vscode.Uri.joinPath(selected.uri, path.basename(entry.uri.fsPath));
    if (await exists(target)) { void vscode.window.showErrorMessage(vscode.l10n.t('The target already exists: {0}', target.fsPath)); return; }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Moving {0}', path.basename(entry.uri.fsPath)), cancellable: false }, async () => {
        await vscode.workspace.fs.stat(entry.uri);
        await vscode.workspace.fs.rename(entry.uri, target, { overwrite: false });
      });
      undoStack.push({ kind: 'move', from: entry.uri.fsPath, to: target.fsPath }); repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };
  const deleteEntry = async (node: unknown): Promise<void> => {
    // Command palette invocations have no node; reject pane roots as defense in depth.
    if (node instanceof SpaceRootNode) return;
    if (!requireTrust()) return;
    const entry = getEntry(node); if (!entry) return;
    // flat Contents 的「.」群組代表 pane root 本身：同樣拒絕（S4.1R6 審查 P1）。
    if (isSamePath(entry.uri.fsPath, entry.basePath)) return;
    try {
      await vscode.workspace.fs.stat(entry.uri);
      const confirmDelete = vscode.workspace.getConfiguration('explorer').get<boolean>('confirmDelete', true);
      if (confirmDelete) {
        const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Delete "{0}"?', path.basename(entry.uri.fsPath)), { modal: true }, vscode.l10n.t('Delete'));
        if (answer !== vscode.l10n.t('Delete')) return;
      }
      const useTrash = vscode.workspace.getConfiguration('files').get<boolean>('enableTrash', true);
      if (useTrash && entry.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage(vscode.l10n.t('This file system provider does not expose trash support; the item was not deleted.'));
        return;
      }
      await vscode.workspace.fs.delete(entry.uri, { recursive: entry.isDirectory, useTrash });
      repaintPane(entry.paneId);
    } catch (error) { operationError(error); }
  };

  // --- pane-scoped view actions（供 paneN.menu 與 pane1 命令共用） ----------

  const rootOf = (paneId: string): string | null => activeRoot(viewState.get(paneId));

  const pickPaneRoot = async (): Promise<string | undefined> => {
    type RootItem = vscode.QuickPickItem & { rootPath?: string; browse?: boolean };
    const items: RootItem[] = store.getDefinitions().map(space => ({ label: space.name, description: space.basePath, rootPath: space.basePath }));
    items.push({ label: vscode.l10n.t('Browse for folder…'), browse: true });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a folder for this folder space') });
    if (!picked) return undefined;
    if (picked.rootPath) return picked.rootPath;
    return pickFolderDialog();
  };

  /** S4.1R20：原生資料夾選擇對話框（本檔唯一入口，避免重複程式碼與雙擊問題）。 */
  const pickFolderDialog = async (): Promise<string | undefined> => {
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t('Choose a folder for this folder space'),
    });
    return folder?.[0]?.fsPath;
  };

  const browsePaneRoot = async (paneId: string): Promise<string | undefined> => {
    const current = rootOf(paneId);
    if (!current) return pickPaneRoot();
    const items: Array<vscode.QuickPickItem & { rootPath: string }> = store.getDefinitions()
      .filter(space => !isSamePath(space.basePath, current))
      .map(space => ({ label: space.name, description: space.basePath, rootPath: space.basePath }));
    try {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(current))) {
        if (type & vscode.FileType.Directory) items.push({ label: name, description: path.join(current, name), rootPath: path.join(current, name) });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not read folders: {0}', String(error)));
      return undefined;
    }
    // S4.1R20（使用者）：原本把 `rootPath` 設為 `current`，選中後再呼叫 pickPaneRoot()→又彈一層 QuickPick，
    // 造成「Browse for folder…」要點兩次才出資料夾對話框。改用獨立旗標一次直達 showOpenDialog。
    items.push({ label: vscode.l10n.t('Browse for folder…'), rootPath: '', browse: true } as never);
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a folder for this folder space') });
    if (!picked) return undefined;
    if ((picked as { browse?: boolean }).browse) return pickFolderDialog();
    let stat: vscode.FileStat | undefined;
    try { stat = await vscode.workspace.fs.stat(vscode.Uri.file(picked.rootPath)); } catch { /* missing paths are rejected below */ }
    if (!stat) {
      void vscode.window.showErrorMessage(vscode.l10n.t('The selected folder does not exist.'));
      return undefined;
    }
    if (!(stat.type & vscode.FileType.Directory)) {
      void vscode.window.showErrorMessage(vscode.l10n.t('The selected path is not a folder.'));
      return undefined;
    }
    return picked.rootPath;
  };

  const setSortForPane = async (paneId: string): Promise<void> => {
    // S4.1R20（方案 B）：欄位與方向合併在同一個 QuickPick（使用者：Mode 移到 Sort 上方，排序方向用箭頭）。
    const state = viewState.get(paneId);
    type SortId = 'name' | 'mtime' | 'ctime' | 'asc' | 'desc';
    const items = stableQuickPickItems<SortId>([
      { id: 'name', label: vscode.l10n.t('Name'), picked: state.sort.key === 'name' },
      { id: 'mtime', label: vscode.l10n.t('Modified'), picked: state.sort.key === 'mtime' },
      { id: 'ctime', label: vscode.l10n.t('Created'), picked: state.sort.key === 'ctime' },
      // 使用者要求：Ascending／Descending 改用向上／向下符號
      { id: 'asc', label: vscode.l10n.t('Ascending'), description: '↑', picked: state.sort.direction === 'asc' },
      { id: 'desc', label: vscode.l10n.t('Descending'), description: '↓', picked: state.sort.direction === 'desc' },
    ]);
    const selected = selectedQuickPickId(await vscode.window.showQuickPick(items, {
      placeHolder: labelledValue(vscode.l10n.t('Sort'), `${state.sort.key} ${state.sort.direction === 'asc' ? '↑' : '↓'}`, vscode.l10n.t('N/A')),
    }));
    if (!selected) return;
    if (selected === 'asc' || selected === 'desc') {
      await viewState.setSort(paneId, state.sort.key, selected);
    } else {
      await viewState.setSort(paneId, selected, state.sort.direction);
    }
    repaintPane(paneId);
    await syncContext();
  };

  const filterForPane = async (paneId: string): Promise<void> => {
    const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Filter by path substring'), value: viewState.get(paneId).filter });
    if (value === undefined) return;
    await viewState.setFilter(paneId, value.trim());
    // 審查 P2-1（D86 訂正）：在 repaint（generation++）**之前**同步清橫幅與 provider 計數——
    // 新列舉必以新 filter 計算，計數即使與上一 filter 相同也會因 ≠ '' 觸發事件；
    // 若樹收合尚未列舉，保持空白（未知）而非顯示舊 filter 的計數。
    const filterRuntime = paneRuntime.get(paneId);
    if (filterRuntime) {
      filterRuntime.provider.filterMessage = '';
      filterRuntime.treeView.message = '';
    }
    repaintPane(paneId);
    await syncContext();
  };

  const drillUpForPane = async (paneId: string): Promise<void> => {
    if (!await viewState.drillUp(paneId)) return;
    await paneChanged(paneId);
  };

  const switchRootForPane = async (paneId: string): Promise<void> => {
    const chosen = await browsePaneRoot(paneId);
    if (!chosen) return;
    await viewState.switchRoot(paneId, chosen);
    await paneChanged(paneId);
  };

  const addRootForPane = async (paneId: string, given?: string): Promise<void> => {
    // `given`＝明確路徑（比照 `addSpace` 的 given 參數，供自動化驗證命令接線）。
    const chosen = given ?? await browsePaneRoot(paneId);
    if (!chosen) return;
    if (given) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(chosen));
        if (!(stat.type & vscode.FileType.Directory)) return;
      } catch {
        return;
      }
    }
    if (!await viewState.addPaneRoot(paneId, chosen)) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Folder is already in this folder space.'));
      return;
    }
    await paneChanged(paneId);
    await syncPaneContexts();
  };

  const removeRootForPane = async (paneId: string, root?: string): Promise<void> => {
    const paneRoots = viewState.get(paneId).roots;
    let target = root;
    if (!target) {
      if (paneRoots.length === 1) target = paneRoots[0];
      else {
        void vscode.window.showInformationMessage(vscode.l10n.t('Select a folder from the root rows to remove it.'));
        return;
      }
    }
    // 守門（審查 P1-3）：唯一 root 不可移除——那不叫「移除資料夾」而是清空資料夾空間，
    // 選單已由 canRemoveRoot gate 隱藏；命令面板等路徑可繞過選單，故於此再擋一次。
    if (viewState.get(paneId).roots.length <= 1) {
      void vscode.window.showInformationMessage(vscode.l10n.t('A folder space needs at least one folder. Use Close Folder Space instead.'));
      return;
    }
    if (!await viewState.removePaneRoot(paneId, target)) return;
    await paneChanged(paneId);
    await syncPaneContexts();
  };

  const expandLevelForPane = async (paneId: string): Promise<void> => {
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    // D84：先收斂進行中的列舉；settle 後確認 pane 仍啟用且 scope（root）未變，
    // 避免換根後把舊節點 reveal 到新樹。
    const scopeBefore = runtime.provider.scope;
    await settleProvider(runtime.provider);
    if (paneRuntime.get(paneId) !== runtime || runtime.provider.scope !== scopeBefore) return;
    const selection = runtime.treeView.selection[0];
    const info = nodeInfo(selection);
    // OP-8：從選取的資料夾（無則 pane root）起，逐層找出「最淺且尚未展開」的資料夾並展開；
    // 每按一次加深一層（全部已展開則 no-op）。
    const expanded = expandedSet(paneId);
    const isOpen = (node: vscode.TreeItem): boolean => !!node.id && expanded.has(node.id);
    let level: Array<SpaceRootNode | SpaceEntryNode> = selection && info?.isDirectory ? [selection as SpaceRootNode | SpaceEntryNode] : await runtime.provider.getChildren();
    for (let depth = 0; depth < 64 && level.length > 0; depth++) {
      const toExpand = level.filter(node => node.collapsibleState !== vscode.TreeItemCollapsibleState.None && !isOpen(node));
      if (toExpand.length > 0) {
        for (const node of toExpand) {
          await runtime.treeView.reveal(node, { select: false, focus: false, expand: true });
          if (node.id) expanded.add(node.id);
        }
        return;
      }
      const next: Array<SpaceRootNode | SpaceEntryNode> = [];
      for (const node of level) next.push(...await runtime.provider.getChildren(node));
      level = next;
    }
  };

  const closePane = async (paneId = 'pane2'): Promise<void> => {
    if (paneId === 'pane1') {
      void vscode.window.showInformationMessage(vscode.l10n.t('Folder Space 1 cannot be closed.'));
      return;
    }
    await viewState.setMode('tree');
    syncPaneViews();
    await syncPaneContexts();
  };

  /**
   * pane2 的 root 只能由 cascade 或 adoptChild（S4）改變；一般開啟／新增 root 一律寫入 pane1。
   * 將指定資料夾加入 pane1 roots，不擅自切換 Dual 模式。
   */
  const openRootInPane1 = async (presetRoot?: string): Promise<void> => {
    const root = presetRoot ?? await browsePaneRoot('pane1');
    if (!root) return;
    await viewState.addPaneRoot('pane1', root);
    await paneChanged('pane1');
  };

  /** 將新增的 space root 加入 pane1；pane2 僅由 pane cascade 切換 root。 */
  const showRootInPane = async (root: string): Promise<void> => {
    const roots = viewState.get('pane1').roots;
    if (roots.some(existing => isSamePath(existing, root))) return;
    await viewState.addPaneRoot('pane1', root);
    await paneChanged('pane1');
  };

  const clearFilterForPane = async (paneId: string): Promise<void> => {
    await viewState.clearFilter(paneId);
    repaintPane(paneId);
    const runtime = paneRuntime.get(paneId);
    if (runtime) runtime.treeView.message = '';
    await syncContext();
  };

  const collapseAllForPane = async (paneId: string): Promise<void> => {
    const runtime = paneRuntime.get(paneId);
    if (!runtime) return;
    const [root] = await runtime.provider.getChildren();
    if (!root) return; // 無 root／scope 時不送出作用於「目前焦點 list」的全域命令
    await runtime.treeView.reveal(root, { select: false, focus: true });
    await vscode.commands.executeCommand('list.collapseAll');
    expandedSet(paneId).clear();
    collapsedPanes.add(paneId);
    await setCollapsedContext(paneId);
  };
  const expandAllForPane = async (paneId: string): Promise<void> => {
    collapsedPanes.delete(paneId);
    await setCollapsedContext(paneId);
    await expandLevelForPane(paneId);
  };
  const selectedUri = (node: unknown): vscode.Uri | undefined => nodeInfo(node)?.uri ?? (() => {
    const paneId = targetPaneId(node);
    const root = rootOf(paneId);
    return root ? vscode.Uri.file(root) : undefined;
  })();
  const targetPaneId = (node?: unknown): string => nodeInfo(node)?.paneId ?? (typeof (node as { paneId?: unknown } | undefined)?.paneId === 'string' ? (node as { paneId: string }).paneId : primaryPaneId());

  // --- wiring ---------------------------------------------------------------

  store.onDidChange(
    () => {
      // D70：spaces 設定變更不回寫既有 pane，只刷新 pane 定義解析與视图。
      for (const paneId of paneRuntime.keys()) applyPaneScope(paneId);
      void syncContext();
    },
    undefined,
    context.subscriptions
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      // F-42：explorer.fileNesting.* 是嵌套設定的唯一來源（D53），變更時刷新所有 pane。
      if (event.affectsConfiguration('explorer.fileNesting')) scheduleRefresh();
    }),
    vscode.workspace.onDidRenameFiles(async event => {
      // D83：更名事件不得保留舊列舉結果；立即失效，UI 重繪仍走既有刷新路徑。
      directoryCache.invalidate();
      for (const file of event.files) {
        // pane 為單位改寫 root 與 drillStack（S4R6：更名處理改以 pane 為界）。
        await viewState.rewriteRoots(file.oldUri.fsPath, file.newUri.fsPath);
        for (const definition of store.getDefinitions()) {
          const impact = classifySpaceRename([definition.basePath], file.oldUri.fsPath);
          if (impact.kind === 'space-root') {
            const message = vscode.l10n.t('Space path is stale: {0}. Update the space path to restore it.', file.oldUri.fsPath);
            const action = vscode.l10n.t('Update space path');
            void vscode.window.showInformationMessage(message, action).then(async selected => {
              if (selected !== action) return;
              try {
                await store.updateSpacePath(file.oldUri.fsPath, file.newUri.fsPath);
                for (const paneId of paneRuntime.keys()) applyPaneScope(paneId);
              } catch (error) {
                void vscode.window.showErrorMessage(vscode.l10n.t('Could not update space path: {0}', String(error)));
              }
            });
          }
        }
      }
      for (const paneId of paneRuntime.keys()) applyPaneScope(paneId);
      rebuildWatchers();
      await reconcilePaneRoots();
      await syncPaneContexts();
    })
  );

  syncPaneViews();
  await syncPaneContexts();
  await reconcilePaneRoots();
  await syncContext();
  
  await syncWorkspaceDirectory();


  // --- commands --------------------------------------------------------------

  const toggleWorkspaceRoots = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no workspace folders to display.'));
      return;
    }
    const hidden = hiddenWorkspaceRoots();
    const items = folders.map(folder => ({
      label: folder.name,
      description: folder.uri.fsPath,
      picked: !hidden.some(root => isSamePath(root, folder.uri.fsPath)),
      path: folder.uri.fsPath,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: vscode.l10n.t('Select workspace folders to display'),
    });
    if (!picked) return;
    const visible = new Set(picked.map(item => item.path));
    await context.workspaceState.update('codeFolderSpaces.hiddenWorkspaceRoots',
      folders.map(folder => folder.uri.fsPath).filter(root => !visible.has(root)));
    await syncWorkspaceDirectory();
  };

  const setPane1Sort = async (key: 'name' | 'mtime' | 'ctime', direction: 'asc' | 'desc'): Promise<void> => {
    await viewState.setSort('pane1', key, direction);
    repaintPane('pane1');
    await syncContext();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeFolderSpaces.pane1.mode.tree', async () => {
      if (viewState.getMode() === 'tree') return;
      await viewState.setMode('tree');
      // 切換 mode 刻意覆寫 pane1 檢視，讓 Tree 模式固定回到 Explorer。
      await viewState.setView('pane1', VIEW_PRESETS.Explorer);
      syncPaneViews();
      await syncPaneContexts();
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.mode.dual', async () => {
      if (viewState.getMode() === 'dual') return;
      // R6 曾因 pane2 drillUp 未顯示而放寬 pane1 條件；本輪按最新指示，dual 的 pane1 不顯示 drillUp（pane2 保留）。
      // 使用者要求：切入 dual 時 pane1 回到原 roots；pane2 保留自己的 drill 狀態。
      if (viewState.get('pane1').drillStack.length > 0) await viewState.resetRoot('pane1');
      await viewState.setMode('dual');
      // 切換 mode 刻意覆寫 pane1 檢視，讓 Dual 模式固定使用 Navigate。
      await viewState.setView('pane1', VIEW_PRESETS.Navigate);
      // pane2 的角色固定是 pane1 選取資料夾的鏡像，內容一律 Contents（flat/all/all）。
      // v2-R7 起 pane2 已有 `pane2.toggleNested` 可改顯示，故這行只是「進入 Dual 時的初始檢視」；
      // cascade 只換 root 不改 view，使用者本次 session 的扁平／巢狀選擇不會被覆寫。
      await viewState.setView('pane2', VIEW_PRESETS.Contents);
      syncPaneViews();
      await syncPaneContexts();
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.activateChild', async () => {
      const runtime = paneRuntime.get('pane1');
      if (!runtime) return;
      // 選取資料夾用自身，選取檔案用父目錄；沒有選取時使用 pane1 目前的 root。
      const info = nodeInfo(runtime.treeView.selection[0]);
      const target = info?.isDirectory ? info.uri.fsPath
        : info?.uri ? path.dirname(info.uri.fsPath)
        : activeRoot(viewState.get('pane1'));
      if (!target) return;
      await viewState.switchRoot('pane2', target);
      applyPaneScope('pane2');
      paneRuntime.get('pane2')?.provider.refresh();
      await syncPaneContexts();
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.pane2.toggleNested', async () => {
      const view = effectiveView(viewState.get('pane2'));
      await viewState.setView('pane2', toggleViewMode(view));
      repaintPane('pane2');
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.sort.name.asc', () => setPane1Sort('name', 'asc')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.sort.name.desc', () => setPane1Sort('name', 'desc')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.sort.mtime.asc', () => setPane1Sort('mtime', 'asc')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.sort.mtime.desc', () => setPane1Sort('mtime', 'desc')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.sort.ctime.asc', () => setPane1Sort('ctime', 'asc')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.sort.ctime.desc', () => setPane1Sort('ctime', 'desc')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.workspaceFolders', () => toggleWorkspaceRoots()),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.switchRoot', () => switchRootForPane('pane1')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.resetLayout', () => vscode.commands.executeCommand('codeFolderSpaces.pane.resetLayout')),
    vscode.commands.registerCommand('codeFolderSpaces.pane1.addRoot', () => addRootForPane('pane1')),
    vscode.commands.registerCommand('codeFolderSpaces.focusMainPane', async () => {
      const runtime = paneRuntime.get(primaryPaneId());
      if (!runtime) return;
      const [root] = await runtime.provider.getChildren();
      if (root) void runtime.treeView.reveal(root, { select: false, focus: true, expand: false });
    }),
    vscode.commands.registerCommand('codeFolderSpaces.revealInExplorer', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('revealInExplorer', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.revealFileInOS', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('revealFileInOS', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.copyFilePath', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('copyFilePath', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.copyRelativeFilePath', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('copyRelativeFilePath', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.openInTerminal', async (node?: unknown) => { const uri = selectedUri(node); if (uri) await vscode.commands.executeCommand('openInIntegratedTerminal', { cwd: uri.fsPath }); }),
    vscode.commands.registerCommand('codeFolderSpaces.findInFolder', (node?: unknown) => { const uri = selectedUri(node); if (uri) void vscode.commands.executeCommand('filesExplorer.findInFolder', uri); }),
    vscode.commands.registerCommand('codeFolderSpaces.openEntry', async (node?: unknown) => {
      const uri = node instanceof vscode.Uri ? node : selectedUri(node);
      if (!uri) return;
      // S4.1R19：移除 `openFilesIn` 設定（使用者：對 VS Code 不適用）；一律在**當前編輯器群組**開啟。
      await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Active });
    }),
    vscode.commands.registerCommand('codeFolderSpaces.copyEntry', (node?: unknown) => { const targetNode = selectionTarget(node); const entry = getEntry(targetNode); if (entry && !(targetNode instanceof SpaceRootNode)) clipboard.set([entry.uri.toString()], 'copy'); }),
    vscode.commands.registerCommand('codeFolderSpaces.cutEntry', (node?: unknown) => { const targetNode = selectionTarget(node); const entry = getEntry(targetNode); if (entry && !(targetNode instanceof SpaceRootNode) && !isSamePath(entry.uri.fsPath, entry.basePath)) clipboard.set([entry.uri.toString()], 'cut'); }),
    vscode.commands.registerCommand('codeFolderSpaces.pasteEntries', (node?: unknown) => pasteEntries(node)),
    vscode.commands.registerCommand('codeFolderSpaces.newFile', (node?: unknown) => createEntry(fileActionTarget(node), false)),
    vscode.commands.registerCommand('codeFolderSpaces.newFolder', (node?: unknown) => createEntry(fileActionTarget(node), true)),
    vscode.commands.registerCommand('codeFolderSpaces.renameEntry', (node?: unknown) => renameEntry(selectionTarget(node))),
    vscode.commands.registerCommand('codeFolderSpaces.moveTo', (node?: unknown) => moveEntry(node)),
    vscode.commands.registerCommand('codeFolderSpaces.deleteEntry', (node?: unknown) => deleteEntry(selectionTarget(node))),
    vscode.commands.registerCommand('codeFolderSpaces.undoFileOperation', async () => {
      if (!requireTrust()) return;
      const entry = undoStack.peek();
      if (!entry) { void vscode.window.showInformationMessage(vscode.l10n.t('There is no file operation to undo.')); return; }
      const source = vscode.Uri.file(entry.from); const target = vscode.Uri.file(entry.to);
      try {
        await vscode.workspace.fs.stat(target);
        try { await vscode.workspace.fs.stat(source); void vscode.window.showErrorMessage(vscode.l10n.t('Cannot undo: the original path already exists: {0}', entry.from)); return; } catch { /* source is available */ }
        await vscode.workspace.fs.rename(target, source, { overwrite: false });
        undoStack.pop(); repaintAllPanes();
      } catch (error) { operationError(error); }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.refresh', () => repaintAllPanes()),
    // root 列的 inline X（view/item/context）：**單一項目**涵蓋所有 pane 的所有 root 列，
    // 故必須用 pane 無關的全域 id 並由**被點擊節點**解析 paneId（D47；審查 P1-1）。
    vscode.commands.registerCommand('codeFolderSpaces.root.markAsGlobal', async (node?: unknown) => {
      if (!(node instanceof SpaceRootNode)) return;
      if (!await store.markAsGlobal(node.definition.basePath)) {
        // v2-R6：root 可能只是 pane 手動加入的任意資料夾（不在 spaces 設定的任何一層，
        // sourceIndex 為 -1），此時 store.moveSpace 找不到來源而回 false。
        // 補 fallback：直接把它加入 spaces.global，否則使用者點了「Mark as Global」毫無反應。
        if (!await store.addSpace(node.definition.basePath, node.definition.name, 'global')) return;
      }
      for (const runtime of paneRuntime.values()) applyPaneScope(runtime.id);
      for (const runtime of paneRuntime.values()) runtime.provider.refresh();
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.root.isGlobal', true);
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.root.unmarkGlobal', async (node?: unknown) => {
      if (!(node instanceof SpaceRootNode)) return;
      if (!await store.unmarkGlobal(node.definition.basePath)) return;
      for (const runtime of paneRuntime.values()) applyPaneScope(runtime.id);
      for (const runtime of paneRuntime.values()) runtime.provider.refresh();
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.root.isGlobal', false);
      await syncContext();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.pane.resetLayout', async () => {
      await viewState.resetToDefaults(paneInitContext());
      syncPaneViews();
      await syncPaneContexts();
      await syncContext();
      await reconcilePaneRoots();
      await syncWorkspaceDirectory();
    }),
    ...Array.from({ length: MAX_PANE_INDEX }, (_, index) => {
      const id = `pane${index + 1}`;
      const paneCommand = (handler: (...args: any[]) => unknown) => (...args: any[]): unknown => {
        if (!viewState.getEnabledPaneIds().includes(id)) return;
        return handler(...args);
      };
      return [
        // S4.1R11b：per-pane id 路由（D47——view/title 不提供 view id，全域 id 會操作錯 pane）。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.root.add`, paneCommand((given?: unknown) => addRootForPane(id, typeof given === 'string' ? given : undefined))),
        // 兩個呼叫情境：
        //  (a) view/title 的按鈕／子選單——**不帶節點**，以閉包 `id` 為 pane。
        //  (b) view/item/context 的 root 列 X——帶被點擊節點，**必須**以節點為準：
        //      該 menu 項目只有單一命令 id（pane1.root.remove）卻涵蓋 pane1／pane2，
        //      若用閉包 id 會讓 pane2 的 X 错路由到 pane1（審查 P1-1）。
        // 注意：不可改用 `targetPaneId(node)`——無節點時它會退化成主 pane，反而破壞 (a)。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.root.remove`, paneCommand((node?: unknown) => {
          const candidate = node && typeof node === 'object' ? node as { paneId?: unknown; rootPath?: unknown } : undefined;
          const nodePaneId = typeof candidate?.paneId === 'string' && /^pane[1-8]$/.test(candidate.paneId)
            ? candidate.paneId : id;
          const root = typeof candidate?.rootPath === 'string' ? candidate.rootPath : undefined;
          return removeRootForPane(nodePaneId, root);
        })),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.collapseAll`, paneCommand(() => collapseAllForPane(id))),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.expandAll`, paneCommand(() => expandAllForPane(id))),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.refresh`, paneCommand(() => repaintPane(id))),
        // S4.1：行內按鈕以 pane 專屬 id 路由（D47），各 pane 一致。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.filter`, paneCommand(() => filterForPane(id))),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.clearFilter`, paneCommand(() => clearFilterForPane(id))),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.drillUp`, paneCommand(() => drillUpForPane(id))),
      ];
    }).flat(),
    vscode.commands.registerCommand('codeFolderSpaces.pane2.close', () => {
      if (!viewState.getEnabledPaneIds().includes('pane2')) return;
      return closePane('pane2');
    }),
    vscode.commands.registerCommand('codeFolderSpaces.drillDown', async (node?: unknown) => {
      const info = nodeInfo(node ?? pane1()?.treeView.selection[0]);
      if (!info?.isDirectory || !info.paneId) return;
      // D67：下鑽以該 pane 自己的 root 為界（節點本質上在 pane root 內）。
      if (!isAllowedSpaceRoot(info.definition.basePath, info.uri.fsPath)) return;
      // v2-R6 修正：no-op 守門只看「目前的下鑽根」，不可用 activeRoot（= drillRoot ?? roots[0]）。
      // 舊寫法在多 root 時會把 roots[0] 誤判為「已在該根」而擋掉下鑽，造成第一個 root 無法 drill down。
      if (isDrillDownNoop(viewState.get(info.paneId).drillRoot, info.uri.fsPath, isSamePath)) return;
      // v2-redesign D4（使用者 2026-10-18）：就地下鑽只做root 切換＋返回堆疊，**不再切換 preset/view**。
      // 舊行為（S4.1R8／OP-12 自動套用 `Contents`）已由 spec §8「就地導航 ✅ 保留（不再動 preset）」推翻。
      await viewState.drillDown(info.paneId, info.uri.fsPath);
      await paneChanged(info.paneId);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.drillUp', (node?: unknown) => drillUpForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.switchRoot', (node?: unknown) => switchRootForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.filter', () => filterForPane(primaryPaneId())),
    vscode.commands.registerCommand('codeFolderSpaces.clearFilter', async () => {
      await viewState.clearFilter(primaryPaneId());
      repaintPane(primaryPaneId());
      const runtime = pane1();
      if (runtime) runtime.treeView.message = '';
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', false);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.setSort', () => setSortForPane(primaryPaneId())),
    // S4.1R17（F-46）：從 Explorer 右鍵「Open in Folder Spaces」——只開新頂層 pane，**不寫入 spaces 設定**。
    // 與 addSpace 的差異：addSpace 會把資料夾加入 `codeFolderSpaces.spaces`；本命令僅建立 pane。
    vscode.commands.registerCommand('codeFolderSpaces.openInFolderSpaces', async (target?: unknown) => {
      const uri = target instanceof vscode.Uri ? target
        : typeof target === 'string' ? vscode.Uri.file(target)
        : !Array.isArray(target) && (target as { resourceUri?: vscode.Uri } | undefined)?.resourceUri instanceof vscode.Uri
          ? (target as { resourceUri: vscode.Uri }).resourceUri
          : undefined;
      if (!uri) return;
      // 未經原生對話框，先確認是既有資料夾（不寫磁碟、不需 trust gating）。
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (!(stat.type & vscode.FileType.Directory)) return;
      } catch {
        return;
      }
      await openRootInPane1(uri.fsPath);
    }),
    // 可選參數（資料夾路徑字串或 Uri）供自動化／其他命令略過原生對話框。
    vscode.commands.registerCommand('codeFolderSpaces.addSpace', async (target?: unknown) => {
      const given = typeof target === 'string' ? vscode.Uri.file(target) : target instanceof vscode.Uri ? target : undefined;
      const picked = given ? [given] : await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Select a folder to add as a folder space'),
      });
      const uri = picked?.[0];
      if (!uri) {
        return;
      }
      if (given) {
        // 參數路徑未經原生對話框，寫入前確認是既有資料夾。
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (!(stat.type & vscode.FileType.Directory)) return;
        } catch {
          return;
        }
      }
      const added = await store.addSpace(uri.fsPath);
      if (added) {
        log.info(`Added folder space: ${uri.fsPath}`);
        void vscode.window.showInformationMessage(vscode.l10n.t('Added folder space: {0}', uri.fsPath));
      }
      // OP-9：新增（或重複選取既有）空間後，確保它在窗格中顯示。
      await showRootInPane(uri.fsPath);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.removeSpace', async (node?: unknown) => {
      const runtime = pane1();
      const target = node instanceof SpaceRootNode ? node : runtime?.treeView.selection.find((item): item is SpaceRootNode => item instanceof SpaceRootNode);
      if (!runtime || !target) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t('Remove folder space "{0}"?', target.definition.name),
        { modal: true },
        vscode.l10n.t('Remove')
      );
      if (confirmed !== vscode.l10n.t('Remove')) {
        return;
      }
      await store.removeSpace(target.definition.basePath);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.toggleFollowActiveFile', async () => {
      const config = settings();
      const enabled = !config.get<boolean>('followActiveFile', true);
      await config.update('followActiveFile', enabled, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.followActiveFile', enabled);
      scheduleFollow();
    }),
    vscode.commands.registerCommand('codeFolderSpaces.revealActiveFile', async () => {
      const uri = getActiveTabUri();
      const runtime = pane1();
      if (!uri || !runtime) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No active file to reveal.'));
        return;
      }
      // D84：reveal 前 settle；settle 後重查 pane 仍啟用且 root 未變，避免 reveal 到新樹。
      const scopeBefore = runtime.provider.scope;
      await settleProvider(runtime.provider);
      if (paneRuntime.get(runtime.id) !== runtime || runtime.provider.scope !== scopeBefore) return;
      const node = await runtime.provider.findNodeByPath(uri.fsPath);
      if (!node) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No folder space contains the active file: {0}', uri.fsPath)
        );
        return;
      }
      await runtime.treeView.reveal(node, { select: true, focus: true, expand: true });
    })
  );

  scheduleFollow();
  // D81：初始啟動後排定一次快照寫入（涵蓋啟動期间的新鲜列舉結果）。
  scheduleSnapshotWrite();
  log.info('Folder Spaces activated');

  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  return {
    version,
    getSpaces: () => store.getDefinitions().map((definition) => ({ name: definition.name, basePath: definition.basePath, origin: originOf(definition) })),
    getPanes: () => viewState.getEnabledPaneIds().map(id => ({
      id, root: rootOf(id), roots: [...viewState.get(id).roots], mode: viewState.getMode(), slot: paneSlotOf(id),
    })),
  };
}

function getActiveTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return resolveActiveTabUri({ kind: 'text', uri: input.uri });
  if (input instanceof vscode.TabInputCustom) return resolveActiveTabUri({ kind: 'custom', uri: input.uri });
  if (input instanceof vscode.TabInputNotebook) return resolveActiveTabUri({ kind: 'notebook', uri: input.uri });
  if (input instanceof vscode.TabInputTextDiff) return resolveActiveTabUri({ kind: 'text-diff', modified: input.modified });
  if (input instanceof vscode.TabInputNotebookDiff) return resolveActiveTabUri({ kind: 'notebook-diff', modified: input.modified });
  return undefined;
}

function sameUri(left: vscode.Uri, right: vscode.Uri | undefined): boolean {
  return Boolean(right && left.toString() === right.toString());
}

export function deactivate(): void {
  disposeLogChannel();
}
