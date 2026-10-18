import * as vscode from 'vscode';
import * as path from 'node:path';
import type { SpaceDefinition } from './types';
import { SpaceEntryNode, SpaceRootNode, SpaceTreeDataProvider, setLeafFolderIcon } from './spaces/spaceTreeDataProvider';
import type { SpaceNode } from './spaces/spaceTreeDataProvider';
import { SpaceStore } from './spaces/spaceStore';
import { DirectoryCache } from './spaces/directoryCache';
import { createRefreshScheduler } from './spaces/refreshScheduler';
import { VIEW_PRESETS, isViewPresetName, matchPresetName, resolveConfiguredDefaultPreset, resolveConfiguredDefaultChildPreset, resolveConfiguredCascadeParentPreset, type ViewAxisChange, type ViewContent, type ViewLevel, type ViewMode } from './spaces/viewPresets';
import { activeRoot, classifySpaceRename, effectiveView, normalizeSpaceKey, PaneStateStore, resolvePaneDefinitions } from './spaces/viewState';
import { canClosePane, describePaneLinkChain, isPaneRootDirectory, linkedChildPaneNumber, nextChildPaneId, panesToSyncWorkspaceRoots } from './spaces/paneLinks';
import { createLinkStatusSummary, LinkStatusBar } from './spaces/linkStatusBar';
import { DEFAULT_FLAT_MAX_DEPTH } from './spaces/flatListing';
import { PaneCascadeController } from './spaces/paneCascade';
import { diffWatchers, planWatchers } from './spaces/watcherPlan';
import { copyTreeEntry, createTreeDragAndDropController } from './spaces/treeDragAndDrop';
import { canModifyFiles, isAllowedSpaceRoot, isSafeMove, isSamePath, isValidEntryName, resolvePasteTarget, resolveOpenBeside, hasDrillStateWithinMovedSources, SpaceClipboard, UndoStack } from './spaces/spaceActions';
import { disposeLogChannel, getLogChannel } from './util/log';
import { resolveActiveTabUri, shouldFollowActiveFile } from './spaces/followActiveFile';
import { selectedQuickPickId, stableQuickPickItems } from './ui/stableQuickPick';
import { belongsToWorkspace, normalizeExpandModeProvenance, resolveAlignedProvenance, resolveExpandModeRestore, resolveExpandModeTarget, resolveWorkspaceIdentity, shouldWriteExpandModeRestore, type ExpandModeProvenance } from './spaces/clickBehavior';

const MAX_PANE_INDEX = 8;
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
  getSpaces(): Array<{ name: string; basePath: string }>;
  /** 目前啟用的窗格，供自動化驗證命令接線：id／root／roots／父窗格／follow／工作區目錄跟隨／預設集。 */
  getPanes(): Array<{ id: string; root: string | null; roots: string[]; parentPaneId: string | null; follow: boolean; followWorkspaceDirectory: boolean; preset: string }>;
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

  const store = new SpaceStore();
  const viewState = new PaneStateStore(context.globalState);
  const settings = () => vscode.workspace.getConfiguration('codeFolderSpaces');
  // OP-15：升級至 Global/Profile 級別儲存；若 globalState 尚無資料，嘗試自 workspaceState 平滑轉移
  await viewState.migrateFromWorkspaceStateIfEmpty(context.workspaceState, settings().get<boolean>('followWorkspaceDirectory', true));
  const paneInitContext = () => ({
    spaces: store.getDefinitions(),
    showFilesDefault: settings().get<boolean>('view.showFiles', true),
    configuredCount: settings().get<number>('panes.count', 2),
    followWorkspaceDirectoryDefault: settings().get<boolean>('followWorkspaceDirectory', true),
  });
  const layout = await viewState.initialize(paneInitContext());
  if (layout.kind === 'rebuilt') {
    log.warn(`Rebuilt default pane layout: ${layout.reason}`);
  } else {
    log.info(`Pane layout ${layout.kind}; ${'enabled' in layout ? layout.enabled : 0} pane(s)`);
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
  const refreshParentLinkRow = (childPaneId: string, previousParent?: string | null): void => {
    refreshLinkRows(previousParent, viewState.getEnabledPaneIds().includes(childPaneId)
      ? viewState.get(childPaneId).parentPaneId : undefined);
  };
  const cascadeDisposables = new Map<string, vscode.Disposable>();
  const cascadeController = new PaneCascadeController({
    state: {
      getPaneLinks: () => viewState.getPaneLinks(),
      // D74：父 pane 每次選取不同資料夾時寫入子 root（手動值自然被取代），不關閉 follow。
      switchRoot: async (paneId, root) => {
        await viewState.switchRoot(paneId, root);
        applyPaneScope(paneId);
        rebuildWatchers();
        await syncPaneContexts();
        refreshParentLinkRow(paneId);
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
    runtime.provider.expandRoot = Boolean(pane.parentPaneId);
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
    const provider = new SpaceTreeDataProvider(store, viewState, undefined, directoryCache, (parentPaneId, fsPath) => {
      const links = Object.fromEntries(viewState.getEnabledPaneIds().map(id => {
        const pane = viewState.get(id);
        return [id, { parentPaneId: pane.parentPaneId, follow: pane.follow, roots: pane.roots, drillRoot: pane.drillRoot }];
      }));
      for (const [childPaneId, link] of Object.entries(links)) {
        if (link.parentPaneId !== parentPaneId) continue;
        const childNumber = linkedChildPaneNumber(links, parentPaneId, childPaneId, fsPath);
        // 純邏輯層只回傳編號；UI 文字在此以 l10n 產生。
        if (childNumber !== undefined) return vscode.l10n.t('→ Folder Space {0}', childNumber);
      }
      return undefined;
    });
    const treeView = vscode.window.createTreeView(`codeFolderSpaces.${paneId}`, {
      treeDataProvider: provider,
      showCollapseAll: false, // S4.1R4：改用自訂「收合全部／展開」切換按鈕（paneN.collapseAll／expandAll）
      dragAndDropController: createPaneDragAndDrop(paneId),
    });
    // S4.1R17：把 `codeFolderSpaces.maxDepth` 注入 provider（建構後設定，避免改動既有建構子簽名）。
    provider.maxDepth = readMaxDepth();
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
    void setCollapsedContext(paneId);
  };

  const attachPaneCascade = (runtime: PaneRuntime): void => {
    if (cascadeDisposables.has(runtime.id)) return;
    const disposable = cascadeController.attach(runtime.id, listener => runtime.treeView.onDidChangeSelection(event => {
      const info = nodeInfo(event.selection[0]);
      listener(info ? { uri: info.uri, isDirectory: info.isDirectory } : undefined);
    }));
    cascadeDisposables.set(runtime.id, disposable);
  };


  /**
   * OP-15：Follow Workspace Directory。
   * 當開啟新專案或切換工作區時，若啟用此設定，主窗格（primary pane，通常為 pane1）
   * 的根目錄自動同步對齊目前工作區的第一個資料夾。
   */
    const syncWorkspaceDirectory = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map(folder => folder.uri.fsPath);
    const panes = Object.fromEntries(viewState.getEnabledPaneIds().map(paneId => [paneId, viewState.get(paneId)]));
    for (const paneId of panesToSyncWorkspaceRoots(panes, roots, isSamePath)) {
      await viewState.setPaneRoots(paneId, roots);
      await paneChanged(paneId);
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
    rebuildWatchers();
  };


  /**
   * OP-13：接龍自適應父面板模式（對齊 Obsidian handleAdaptiveCascadeParent）。
   * 檢查所有啟用的 pane：若有連動中的子 pane，父面板切換為 cascadeParentPreset；
   * 若無連動子 pane，父面板無損還原備份的獨立檢視。
   */
  const reconcileAdaptiveParents = async (): Promise<void> => {
    const adaptiveEnabled = settings().get<boolean>('adaptiveCascadeParent', true);
    const parentPreset = resolveConfiguredCascadeParentPreset(settings().get<string>('cascadeParentPreset'));
    const links = viewState.getPaneLinks();
    const enabledIds = viewState.getEnabledPaneIds();

    for (const paneId of enabledIds) {
      // 判定是否有子 pane 且其 parent 為當前 paneId 且正在 follow
      const hasFollowingChild = enabledIds.some(childId => {
        const link = links[childId];
        return link && link.parentPaneId === paneId && link.follow;
      });
      // 當設定關閉時，hasFollowingChild 視為 false，促使父面板自動還原並清除 backup
      const shouldBeAdaptive = adaptiveEnabled && hasFollowingChild;
      const changed = await viewState.handleAdaptiveCascadeParent(paneId, shouldBeAdaptive, parentPreset);
      if (changed) {
        repaintPane(paneId);
      }
    }
  };

  const syncPaneContexts = async (): Promise<void> => {
    const links = viewState.getPaneLinks();
    const enabled = viewState.getEnabledPaneIds();
    for (let index = 1; index <= MAX_PANE_INDEX; index++) {
      const id = `pane${index}`;
      const pane = links[id];
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.enabled`, Boolean(pane));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasRoot`, Boolean(pane && viewState.get(id).roots.length > 0));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.canRemoveRoot`, Boolean(pane && viewState.get(id).roots.length > 1));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasParent`, Boolean(pane?.parentPaneId));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.follow`, Boolean(pane?.follow));
      await vscode.commands.executeCommand('setContext', `codeFolderSpaces.${id}.hasChild`, enabled.some(childId => links[childId]?.parentPaneId === id));
    }
    // D65/D71：上下限只看 pane 狀態，不再看 spaces 數量。
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canAddPane', enabled.length < MAX_PANE_INDEX);
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.canRemovePane', enabled.length > 1);
    // S4.1R3：pane1 可關閉，其 `when` 改為 `!layoutReady || pane1.enabled`；啟動後才為 true，確保冷啟動時 pane1 恆可見（S4R6-D77）。
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.layoutReady', true);
    linkStatusBar?.update();
    await reconcileAdaptiveParents();
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
    refreshParentLinkRow(paneId);
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
  // S4.1R13：以 let 宣告，允許 syncPaneContexts（定義於上方）在賦值前呼叫時安全跳過（避免 TDZ）。
  let linkStatusBar: LinkStatusBar | undefined;
  linkStatusBar = new LinkStatusBar(() => {
    const links = Object.fromEntries(viewState.getEnabledPaneIds().map(id => {
      const pane = viewState.get(id);
      return [id, { parentPaneId: pane.parentPaneId, follow: pane.follow, roots: pane.roots, drillRoot: pane.drillRoot }];
    }));
    const chain = describePaneLinkChain(links, { mainPaneId: primaryPaneId() });
    if (chain.hidden) return { visible: false, text: '', tooltip: '', follow: [] };
    // check:project 只辨識字面形式；所有訊息在此逐字寫出，不經動態轉發。
    const labels = chain.segments.map(segment => vscode.l10n.t('Folder Space {0}', segment.paneIndex));
    const tooltip = chain.segments
      .map((segment, index) => segment.follow || index === 0 ? labels[index] : vscode.l10n.t('{0} (follow off)', labels[index]))
      .join(' → ');
    return createLinkStatusSummary(labels, tooltip, chain.segments.slice(1).map(segment => segment.follow));
  }, 'codeFolderSpaces.focusMainPane');
  context.subscriptions.push(linkStatusBar);

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
    if (event.affectsConfiguration('codeFolderSpaces.followWorkspaceDirectory')) {
      void (async () => {
        const enabled = settings().get<boolean>('followWorkspaceDirectory', true);
        for (const paneId of viewState.getEnabledPaneIds()) {
          await viewState.setPaneFollowWorkspaceDirectory(paneId, enabled);
        }
        await syncWorkspaceDirectory();
      })();
    }
    if (event.affectsConfiguration('codeFolderSpaces.adaptiveCascadeParent') || event.affectsConfiguration('codeFolderSpaces.cascadeParentPreset')) {
      void reconcileAdaptiveParents();
    }
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
    await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.mode', paneView.mode);
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
    items.push({ label: vscode.l10n.t('Browse for folder…'), rootPath: current });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Choose a folder for this folder space') });
    if (!picked) return undefined;
    if (picked.rootPath === current) return pickPaneRoot();
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

  const setPresetForPane = async (paneId: string, preset?: unknown): Promise<void> => {
    let selected = preset;
    if (!isViewPresetName(selected)) {
      const presets = stableQuickPickItems([
        { id: 'Explorer', label: vscode.l10n.t('Explorer') },
        { id: 'Navigate', label: vscode.l10n.t('Navigate') },
        { id: 'Columns', label: vscode.l10n.t('Columns') },
        { id: 'Context', label: vscode.l10n.t('Context') },
        { id: 'Contents', label: vscode.l10n.t('Contents') },
        { id: 'Files', label: vscode.l10n.t('Files') },
        { id: 'List', label: vscode.l10n.t('List') },
      ] as const);
      selected = selectedQuickPickId(await vscode.window.showQuickPick(presets, { placeHolder: vscode.l10n.t('Choose a view preset') }));
    }
    if (!isViewPresetName(selected)) return;
    await viewState.setPreset(paneId, selected);
    repaintPane(paneId);
    await syncContext();
  };

  const setSortForPane = async (paneId: string, key?: unknown, direction?: unknown): Promise<void> => {
    const fields = stableQuickPickItems([
      { id: 'name', label: vscode.l10n.t('Name') },
      { id: 'mtime', label: vscode.l10n.t('Modified') },
      { id: 'ctime', label: vscode.l10n.t('Created') },
    ] as const);
    const selectedKey = key === 'name' || key === 'mtime' || key === 'ctime'
      ? key
      : selectedQuickPickId(await vscode.window.showQuickPick(fields, { placeHolder: vscode.l10n.t('Choose sort field') }));
    if (!selectedKey) return;
    const directions = stableQuickPickItems([
      { id: 'asc', label: vscode.l10n.t('Ascending') },
      { id: 'desc', label: vscode.l10n.t('Descending') },
    ] as const);
    const selectedDirection = direction === 'desc' || direction === 'asc'
      ? direction
      : selectedQuickPickId(await vscode.window.showQuickPick(directions, { placeHolder: vscode.l10n.t('Choose sort direction') }));
    if (selectedDirection !== 'asc' && selectedDirection !== 'desc') return;
    await viewState.setSort(paneId, selectedKey as 'name' | 'mtime' | 'ctime', selectedDirection);
    repaintPane(paneId);
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

  const toggleModeForPane = async (paneId: string): Promise<void> => {
    // OP-14：只翻轉「模式」維度，層級與內容保持不變（組合不必落在預設集內）。
    const mode: ViewMode = effectiveView(viewState.get(paneId)).mode === 'tree' ? 'flat' : 'tree';
    await viewState.setViewAxis(paneId, { axis: 'mode', value: mode });
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

  const setRootForPane = async (paneId: string): Promise<void> => {
    const chosen = await pickPaneRoot();
    if (!chosen) return;
    // D61：手動換根不關閉 follow（暫時覆寫，父焦點事件仍是最終權威）。
    await viewState.switchRoot(paneId, chosen);
    await paneChanged(paneId);
  };

  const setFollowForPane = async (paneId: string, follow: boolean): Promise<void> => {
    const pane = viewState.get(paneId);
    if (!pane.parentPaneId || pane.follow === follow) return;
    await viewState.setPaneParent(paneId, pane.parentPaneId, follow);
    await syncPaneContexts();
  };

  const toggleFollowForPane = async (paneId: string): Promise<void> => {
    const pane = viewState.get(paneId);
    if (!pane.parentPaneId) return;
    await viewState.setPaneParent(paneId, pane.parentPaneId, !pane.follow);
    refreshParentLinkRow(paneId);
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

  /** 「在此開子 pane」（S4.1R12）：優先重用既有子窗格，否則配置可用插槽。 */
  const addChildPane = async (node: unknown, paneId = targetPaneId(node), options?: { alwaysCreate?: boolean }): Promise<void> => {
    const info = nodeInfo(node);
    const target = info?.isDirectory ? info.uri.fsPath : rootOf(paneId);
    if (!target) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Choose a folder inside this folder space first.'));
      return;
    }
    // 樹列的 Activate Child Space（無 options 或 alwaysCreate=false）保留 R12a 行為：已有子窗格則改換其根。
    // 「…」選單的 Add Child Space（alwaysCreate=true）名實相符：總是新增一個子空間。
    const existingChild = options?.alwaysCreate
      ? undefined
      : viewState.getEnabledPaneIds().find(id => viewState.get(id).parentPaneId === paneId);
    if (existingChild) {
      await viewState.switchRoot(existingChild, target);
      await paneChanged(existingChild);
      return;
    }
    const sourcePane = viewState.get(paneId);
    // 插槽決策抽為純函式（`nextChildPaneId`）以便單元測試。
    const childId = nextChildPaneId(paneId, viewState.getEnabledPaneIds());
    if (!childId) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Folder Spaces supports at most 8 folder space slots.'));
      return;
    }
    try {
      const childPreset = resolveConfiguredDefaultChildPreset(settings().get<string>('defaultChildPreset'));
      await viewState.enablePane(childId, {
        roots: [target],
        parentPaneId: paneId,
        follow: true,
        preset: childPreset,
        showFiles: sourcePane.showFiles,
        include: [...sourcePane.include],
        exclude: [...sourcePane.exclude],
      });
    } catch (error) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Invalid folder space link: {0}', String(error)));
      return;
    }
    syncPaneViews();
    // 標記出現在父 pane（paneId）的列上，必須刷新父自己。
    refreshLinkRows(paneId);
    await syncPaneContexts();
    await reconcilePaneRoots();
    await syncContext();
  };

  /** 關閉 pane（D71（S4.1R3 修訂）：任一窗格可關閉；子 pane 重掛到被關閉 pane 的父）。 */
  const closePane = async (paneId?: string): Promise<void> => {
    const enabled = viewState.getEnabledPaneIds();
    const target = paneId ?? enabled[enabled.length - 1];
    // 審查 F-11：關閉守門抽為純函式（`canClosePane`）以便單元測試。
    if (!target || !canClosePane(target, enabled)) return;
    const removed = viewState.get(target);
    // 被關閉窗格的父為唯一受影響列（子窗格重掛後仍指向同一個父）。
    const affectedParentIds = [removed.parentPaneId];
    await viewState.disablePane(target);
    syncPaneViews();
    refreshLinkRows(...affectedParentIds);
    await syncPaneContexts();
    await reconcilePaneRoots();
    await syncContext();
  };

  const addPane = async (presetRoot?: string): Promise<void> => {
    const paneId = viewState.allocatePaneId();
    if (!paneId) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Folder Spaces supports at most 8 folder space slots.'));
      return;
    }
    // S4.1R16（使用者要求）：Add Space 的選單項目與 Switch Root... 一致——
    // 列出「已設定的 spaces」＋「目前主窗格資料夾下的子目錄」＋「Browse for folder…」。
    const root = presetRoot ?? await browsePaneRoot(primaryPaneId());
    if (!root) return;
    const source = viewState.get(primaryPaneId());
    const initialPreset = resolveConfiguredDefaultPreset(settings().get<string>('defaultPreset'));
    // D64：頂層新 pane 的顯示設定繼承主 pane（最低編號啟用窗格）。
    await viewState.enablePane(paneId, {
      roots: [root],
      preset: initialPreset,
      showFiles: source.showFiles,
      include: [...source.include],
      exclude: [...source.exclude],
    });
    syncPaneViews();
    await syncPaneContexts();
    await reconcilePaneRoots();
    await syncContext();
  };

  /**
   * S4.1R5（OP-9）：Palette「Add Folder Space」寫入 spaces 設定後，同時讓該資料夾在窗格中可見——
   * 已有窗格以此為根則不重複；有空窗格（root 為 null）則填入；否則開新頂層窗格（滿 8 提示）。
   */
  const showRootInPane = async (root: string): Promise<void> => {
    const enabled = viewState.getEnabledPaneIds();
    if (enabled.some(id => rootOf(id) && isSamePath(rootOf(id) as string, root))) return;
    // 只填入頂層（無父窗格）的空窗格：鏈結子窗格的 root 會被父選取覆寫（D61/D74），新空間會看似消失。
    const emptyId = enabled.find(id => !rootOf(id) && !viewState.get(id).parentPaneId);
    if (emptyId) {
      await viewState.switchRoot(emptyId, root);
      await paneChanged(emptyId);
      return;
    }
    await addPane(root);
  };

  const clearFilterForPane = async (paneId: string): Promise<void> => {
    await viewState.clearFilter(paneId);
    repaintPane(paneId);
    const runtime = paneRuntime.get(paneId);
    if (runtime) runtime.treeView.message = '';
    await syncContext();
  };

  // S4.1R2：「…」改為原生下拉（view/title 非 navigation 群組）；每個動作以 pane 專屬命令 id 路由（D47）。
  const applyAxisForPane = async (paneId: string, change: Exclude<ViewAxisChange, { axis: 'mode' }>): Promise<void> => {
    await viewState.setViewAxis(paneId, change);
    repaintPane(paneId);
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
  const closePaneFromNode = (node?: unknown): Promise<void> => closePane(targetPaneId(node));

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

  context.subscriptions.push(
    // S4.1R13：狀態列點擊目標（manifest 已註冊並在 commandPalette 隱藏）。
    vscode.commands.registerCommand('codeFolderSpaces.focusMainPane', async () => {
      const runtime = paneRuntime.get(primaryPaneId());
      if (!runtime) return;
      const [root] = await runtime.provider.getChildren();
      if (root) void runtime.treeView.reveal(root, { select: false, focus: true, expand: false });
    }),
    vscode.commands.registerCommand('codeFolderSpaces.alignClickBehavior', async () => {
      const confirmation = vscode.l10n.t('Align Click Behavior');
      const accepted = await vscode.window.showWarningMessage(
        vscode.l10n.t('This is a window-level setting and affects all trees in this window, including the built-in File Explorer.'),
        { modal: true }, confirmation,
      );
      if (accepted !== confirmation) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Click behavior was not changed.'));
        return;
      }
      const targetName = resolveExpandModeTarget(Boolean(vscode.workspace.workspaceFolders?.length));
      const target = targetName === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      const configuration = vscode.workspace.getConfiguration('workbench');
      const inspected = configuration.inspect<unknown>('tree.expandMode');
      const previous = targetName === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue;
      const provenanceKey = 'codeFolderSpaces.expandModeOverride';
      const provenance = normalizeExpandModeProvenance(context.globalState.get(provenanceKey));
      const workspaceKey = resolveWorkspaceIdentity(vscode.workspace.workspaceFile?.toString(), vscode.workspace.workspaceFolders?.[0]?.uri.toString());
      const aligned = resolveAlignedProvenance(provenance[targetName], previous, workspaceKey);
      if (aligned) {
        provenance[targetName] = aligned;
        await context.globalState.update(provenanceKey, provenance);
      }
      await configuration.update('tree.expandMode', 'doubleClick', target);
      if (aligned) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Click behavior aligned to double-click. Use Reset Click Behavior to restore the previous setting.'));
      } else {
        void vscode.window.showInformationMessage(vscode.l10n.t('Click behavior is already set to double-click; no reset value was recorded.'));
      }
    }),
    vscode.commands.registerCommand('codeFolderSpaces.resetClickBehavior', async () => {
      const key = 'codeFolderSpaces.expandModeOverride';
      const provenance: ExpandModeProvenance = normalizeExpandModeProvenance(context.globalState.get(key));
      const workspaceKey = resolveWorkspaceIdentity(vscode.workspace.workspaceFile?.toString(), vscode.workspace.workspaceFolders?.[0]?.uri.toString());
      const entries = (['workspace', 'global'] as const).filter(target => provenance[target] !== undefined);
      const restorable = entries.filter(target => belongsToWorkspace(provenance[target]!, workspaceKey));
      const skipped = entries.filter(target => !belongsToWorkspace(provenance[target]!, workspaceKey));
      if (restorable.length === 0) {
        if (skipped.length) {
          void vscode.window.showInformationMessage(vscode.l10n.t('Click behavior records from other workspaces were skipped.'));
        } else {
          void vscode.window.showInformationMessage(vscode.l10n.t('No click behavior override was recorded; no setting was changed.'));
        }
        return;
      }
      const configuration = vscode.workspace.getConfiguration('workbench');
      for (const targetName of restorable) {
        const restore = resolveExpandModeRestore({ target: targetName, previous: provenance[targetName]!.previous });
        const target = restore.target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        const current = configuration.inspect<unknown>('tree.expandMode');
        const currentValue = targetName === 'workspace' ? current?.workspaceValue : current?.globalValue;
        if (shouldWriteExpandModeRestore(currentValue, restore.value)) {
          await configuration.update('tree.expandMode', restore.value, target);
        }
        delete provenance[targetName];
      }
      await context.globalState.update(key, Object.keys(provenance).length ? provenance : undefined);
      if (skipped.length) {
        void vscode.window.showInformationMessage(vscode.l10n.t('The previous click behavior setting was restored. Click behavior records from other workspaces were skipped.'));
      } else {
        void vscode.window.showInformationMessage(vscode.l10n.t('The previous click behavior setting was restored.'));
      }
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
      const beside = resolveOpenBeside(settings().get<string>('openFilesIn', 'current'));
      await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active });
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
    vscode.commands.registerCommand('codeFolderSpaces.pane.add', () => addPane()),
    // root 列的 inline X（view/item/context）：**單一項目**涵蓋所有 pane 的所有 root 列，
    // 故必須用 pane 無關的全域 id 並由**被點擊節點**解析 paneId（D47；審查 P1-1）。
    vscode.commands.registerCommand('codeFolderSpaces.root.remove', (node?: unknown) => {
      const candidate = node && typeof node === 'object' ? node as { paneId?: unknown; rootPath?: unknown } : undefined;
      const paneId = typeof candidate?.paneId === 'string' && /^pane[1-8]$/.test(candidate.paneId) ? candidate.paneId : targetPaneId(node);
      const root = typeof candidate?.rootPath === 'string' ? candidate.rootPath : undefined;
      return removeRootForPane(paneId, root);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.pane.close', (node?: unknown) => closePaneFromNode(node)),
    vscode.commands.registerCommand('codeFolderSpaces.pane.remove', (paneId?: unknown) => closePane(typeof paneId === 'string' ? paneId : undefined)),
    vscode.commands.registerCommand('codeFolderSpaces.pane.addChild', (node?: unknown) => addChildPane(node ?? pane1()?.treeView.selection[0])),
    vscode.commands.registerCommand('codeFolderSpaces.pane.setRoot', (node?: unknown) => setRootForPane(targetPaneId(node))),
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
      return [
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.toggleFollow`, () => toggleFollowForPane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.mode`, () => toggleModeForPane(id)),
        ...(Object.keys(VIEW_PRESETS) as Array<keyof typeof VIEW_PRESETS>).map(name =>
          vscode.commands.registerCommand(`codeFolderSpaces.${id}.preset.${name}`, () => setPresetForPane(id, name))),
        ...(([1, 2, 'all'] as ViewLevel[]).map(level =>
          vscode.commands.registerCommand(`codeFolderSpaces.${id}.level.${level}`, () => applyAxisForPane(id, { axis: 'level', value: level })))),
        ...(([ 'all', 'folders', 'files' ] as ViewContent[]).map(content =>
          vscode.commands.registerCommand(`codeFolderSpaces.${id}.content.${content}`, () => applyAxisForPane(id, { axis: 'content', value: content })))),
        ...(['name', 'mtime', 'ctime'] as const).flatMap(key => (['asc', 'desc'] as const).map(direction =>
          vscode.commands.registerCommand(`codeFolderSpaces.${id}.sort.${key}.${direction}`, () => setSortForPane(id, key, direction)))),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.switchRoot`, () => switchRootForPane(id)),
        // S4.1R11b：per-pane id 路由（D47——view/title 不提供 view id，全域 id 會操作錯 pane）。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.root.add`, (given?: unknown) => addRootForPane(id, typeof given === 'string' ? given : undefined)),
        // 兩個呼叫情境：
        //  (a) view/title 的「…」——**不帶節點**，以閉包 `id` 為 pane。
        //  (b) view/item/context 的 root 列 X——帶被點擊節點，**必須**以節點為準：
        //      該 menu 項目只有單一命令 id（pane1.root.remove）卻涵蓋 pane1..8，
        //      若用閉包 id 會讓 pane2..8 的 X 错路由到 pane1（審查 P1-1）。
        // 注意：不可改用 `targetPaneId(node)`——無節點時它會退化成主 pane，反而破壞 (a)。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.root.remove`, (node?: unknown) => {
          const candidate = node && typeof node === 'object' ? node as { paneId?: unknown; rootPath?: unknown } : undefined;
          const nodePaneId = typeof candidate?.paneId === 'string' && /^pane[1-8]$/.test(candidate.paneId)
            ? candidate.paneId : id;
          const root = typeof candidate?.rootPath === 'string' ? candidate.rootPath : undefined;
          return removeRootForPane(nodePaneId, root);
        }),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.addChild`, () => {
          const runtime = paneRuntime.get(id);
          const selected = runtime?.treeView.selection[0];
          const target = nodeInfo(selected)?.isDirectory ? selected : rootNodeForPane(id);
          // 「…」選單的 Add Child Space：名稱與行為一致——**總是新增**子空間（不重用既有的）。
          return addChildPane(target, id, { alwaysCreate: true });
        }),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.close`, () => closePane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.collapseAll`, () => collapseAllForPane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.expandAll`, () => expandAllForPane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.refresh`, () => repaintPane(id)),
        // S4.1：行內按鈕以 pane 專屬 id 路由（D47），各 pane 一致。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.filter`, () => filterForPane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.clearFilter`, () => clearFilterForPane(id)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.drillUp`, () => drillUpForPane(id)),
        // 審查 F-08：命令 id 描述的是**狀態**（follow 開／關），handler 則為切換，兩者故意相反。
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.followOn`, () => setFollowForPane(id, false)),
        vscode.commands.registerCommand(`codeFolderSpaces.${id}.followOff`, () => setFollowForPane(id, true)),
      ];
    }).flat(),
    vscode.commands.registerCommand('codeFolderSpaces.drillDown', async (node?: unknown) => {
      const info = nodeInfo(node ?? pane1()?.treeView.selection[0]);
      if (!info?.isDirectory || !info.paneId) return;
      // D67：下鑽以該 pane 自己的 root 為界（節點本質上在 pane root 內）。
      if (!isAllowedSpaceRoot(info.definition.basePath, info.uri.fsPath)) return;
      // 根列對自身下鑽為 no-op，避免幽靈歷史。
      if (isSamePath(activeRoot(viewState.get(info.paneId)) ?? '', info.uri.fsPath)) return;
      const childPreset = resolveConfiguredDefaultChildPreset(settings().get<string>('defaultChildPreset'));
      await viewState.drillDown(info.paneId, info.uri.fsPath, childPreset);
      await paneChanged(info.paneId);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.drillUp', (node?: unknown) => drillUpForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.switchRoot', (node?: unknown) => switchRootForPane(targetPaneId(node))),
    vscode.commands.registerCommand('codeFolderSpaces.setPreset', (preset?: unknown) => setPresetForPane(primaryPaneId(), preset)),
    vscode.commands.registerCommand('codeFolderSpaces.filter', () => filterForPane(primaryPaneId())),
    vscode.commands.registerCommand('codeFolderSpaces.clearFilter', async () => {
      await viewState.clearFilter(primaryPaneId());
      repaintPane(primaryPaneId());
      const runtime = pane1();
      if (runtime) runtime.treeView.message = '';
      await vscode.commands.executeCommand('setContext', 'codeFolderSpaces.hasFilter', false);
    }),
    vscode.commands.registerCommand('codeFolderSpaces.setSort', (key?: unknown, direction?: unknown) => setSortForPane(primaryPaneId(), key, direction)),
    vscode.commands.registerCommand('codeFolderSpaces.toggleMode', () => toggleModeForPane(primaryPaneId())),
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
      await addPane(uri.fsPath);
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
    vscode.commands.registerCommand('codeFolderSpaces.expandLevel', () => expandLevelForPane(primaryPaneId())),
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
    getSpaces: () => store.getDefinitions().map((definition) => ({ name: definition.name, basePath: definition.basePath })),
    getPanes: () => viewState.getEnabledPaneIds().map((id) => {
      const pane = viewState.get(id);
      return { id, root: rootOf(id), roots: [...pane.roots], parentPaneId: pane.parentPaneId, follow: pane.follow, followWorkspaceDirectory: pane.followWorkspaceDirectory, preset: matchPresetName(effectiveView(pane)) ?? 'Custom' };
    }),
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
