import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceConfigEntry } from '../../../src/types';
import { SpaceStore } from '../../../src/spaces/spaceStore';
import { SpaceRootNode, SpaceTreeDataProvider } from '../../../src/spaces/spaceTreeDataProvider';
import type { PaneProviderScope } from '../../../src/spaces/spaceTreeDataProvider';
import { activeRoot, PaneStateStore, resolvePaneDefinitions } from '../../../src/spaces/viewState';
import type { MementoLike, PaneState } from '../../../src/spaces/viewState';
import { PaneCascadeController } from '../../../src/spaces/paneCascade';
import type { PaneCascadeRuntime, PaneCascadeSelection, PaneCascadeStateAdapter } from '../../../src/spaces/paneCascade';
import { isAllowedSpaceRoot } from '../../../src/spaces/spaceActions';

export const fixtureWorkspace = path.resolve(__dirname, '../../../tests/integration/fixtures/workspace');

export function assertFixtureWorkspace(): void {
  if (!fs.existsSync(fixtureWorkspace)) {
    throw new Error(`找不到整合測試 fixture 工作區：${fixtureWorkspace}`);
  }
}

/** 平台大小寫語意的路徑比較（Windows 不區分大小寫）。 */
export function sameFixturePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

/** 清除整合測試使用的 Global 設定，作為 suite 結束時的殘留保險。 */
export async function clearGlobalSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('codeFolderSpaces');
  await config.update('spaces', undefined, vscode.ConfigurationTarget.Global);
  await config.update('view.showFiles', undefined, vscode.ConfigurationTarget.Global);
  await config.update('followActiveFile', undefined, vscode.ConfigurationTarget.Global);
}

/** 僅操作 Global 設定，完成後逐項還原，不寫入工作區設定。 */
export async function withGlobalSettings<T>(
  values: { spaces?: SpaceConfigEntry[]; showFiles?: boolean; followActiveFile?: boolean },
  run: () => Promise<T>
): Promise<T> {
  const config = vscode.workspace.getConfiguration('codeFolderSpaces');
  const previousSpaces = config.inspect<SpaceConfigEntry[]>('spaces')?.globalValue;
  const previousShowFiles = config.inspect<boolean>('view.showFiles')?.globalValue;
  const previousFollowActiveFile = config.inspect<boolean>('followActiveFile')?.globalValue;
  try {
    if (values.spaces !== undefined) {
      await config.update('spaces', values.spaces, vscode.ConfigurationTarget.Global);
    }
    if (values.showFiles !== undefined) {
      await config.update('view.showFiles', values.showFiles, vscode.ConfigurationTarget.Global);
    }
    if (values.followActiveFile !== undefined) {
      await config.update('followActiveFile', values.followActiveFile, vscode.ConfigurationTarget.Global);
    }
    return await run();
  } finally {
    await config.update('spaces', previousSpaces, vscode.ConfigurationTarget.Global);
    await config.update('view.showFiles', previousShowFiles, vscode.ConfigurationTarget.Global);
    await config.update('followActiveFile', previousFollowActiveFile, vscode.ConfigurationTarget.Global);
  }
}

// ---------------------------------------------------------------------------
// Pane 狀態 harness（S4R6 起以 paneId 為 key；S4.1R11 起持久化為 panes.v3）
// ---------------------------------------------------------------------------

export interface PaneStateHarness {
  state: PaneStateStore;
  memento: MementoLike;
  /** 以同一份 memento 再建立 store，用於驗證重載後的持久化結果（PD-I4）。 */
  reload: () => PaneStateStore;
}

/** 以記憶體 memento 建立 PaneStateStore；模擬 workspaceState 的 undefined＝移除語意。 */
export function createPaneStateHarness(initial?: Record<string, unknown>): PaneStateHarness {
  const values = new Map<string, unknown>(Object.entries(initial ?? {}));
  const memento: MementoLike = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
  return { state: new PaneStateStore(memento), memento, reload: () => new PaneStateStore(memento) };
}

/** 將 pane fixture 寫入 LayoutStore（pane2 對應 dual 模式）。 */
export async function seedPane(state: PaneStateStore, paneId: string, pane: Partial<PaneState>): Promise<void> {
  if (paneId !== 'pane1') await state.setMode('dual');
  const roots = pane.roots ?? ((pane as { root?: unknown }).root ? [(pane as { root: string }).root] : []);
  await state.setPaneRoots(paneId, roots);
  const target = state.get(paneId);
  Object.assign(target, pane);
}

/**
 * 以生產等價的規則建立 pane：root 命中已配置 space 時複製其顯示設定（S4R6-D64/D70），
 * 否則使用全域 `view.showFiles` 預設與空 include／exclude；overrides 最後蓋入。
 */
export async function seedPaneFromRoot(
  store: SpaceStore,
  state: PaneStateStore,
  paneId: string,
  root: string,
  overrides: Partial<PaneState> = {}
): Promise<void> {
  const hit = store.getDefinitions().find(definition => sameFixturePath(definition.basePath, root));
  if (paneId !== 'pane1') await state.setMode('dual');
  await state.setPaneRoots(paneId, [root]);
  Object.assign(state.get(paneId), {
    icon: hit?.icon ?? null,
    include: hit?.include ?? [],
    exclude: hit?.exclude ?? [],
    ...overrides,
  });
}

/** 由目前 pane 狀態解析 provider scope；pane 沒有 root 時為 undefined（viewsWelcome 情境）。 */
export function paneScopeFor(store: SpaceStore, state: PaneStateStore, paneId: string): PaneProviderScope | undefined {
  const definitions = resolvePaneDefinitions(state.get(paneId), store.getDefinitions());
  return definitions.length ? { paneId, definitions } : undefined;
}

/** 建立綁定單一 pane 的 provider（未帶 scope 的 provider 不列舉任何節點）。 */
export function paneRootNode(provider: SpaceTreeDataProvider): SpaceRootNode {
  const scope = provider.scope;
  if (!scope?.definitions[0]) throw new Error(`pane ${scope?.paneId ?? 'unknown'} has no root definition`);
  return new SpaceRootNode(scope.definitions[0], scope.paneId);
}

export function createPaneProvider(store: SpaceStore, state: PaneStateStore, paneId: string): SpaceTreeDataProvider {
  const scope = paneScopeFor(store, state, paneId);
  if (!scope) throw new Error(`pane ${paneId} 沒有 root，無法建立 provider scope`);
  return new SpaceTreeDataProvider(store, state, scope);
}

/** 根／顯示設定變更後同步 provider scope，語意同 extension.ts 的 applyPaneScope。 */
export function syncPaneScope(store: SpaceStore, state: PaneStateStore, provider: SpaceTreeDataProvider, paneId: string): void {
  provider.setScope(paneScopeFor(store, state, paneId));
}

export interface PaneSeed {
  paneId: string;
  root: string;
  /** 直接蓋入 pane 狀態欄位（per-pane 顯示設定、鏈結、follow 等）。 */
  overrides?: Partial<PaneState>;
}

export interface PaneProviders {
  store: SpaceStore;
  state: PaneStateStore;
  providers: Map<string, SpaceTreeDataProvider>;
  /** 取得（必要時建立）該 pane 的 provider。 */
  provider: (paneId: string) => SpaceTreeDataProvider;
  /** 根／顯示設定變更後更新 provider scope。 */
  sync: (paneId: string) => void;
  /** 以生產規則再建立一個 pane（PD-I3「在此開子 pane」等流程）。 */
  openPane: (seed: PaneSeed) => Promise<void>;
}

/** 以真實設定＋pane 狀態建立一個或多個 pane 的 provider；run 結束後一律 dispose。 */
export async function withPaneProviders<T>(
  spaces: SpaceConfigEntry[],
  panes: PaneSeed[],
  run: (args: PaneProviders) => Promise<T>,
  globals?: { showFiles?: boolean }
): Promise<T> {
  return withGlobalSettings({ spaces, ...(globals?.showFiles === undefined ? {} : { showFiles: globals.showFiles }) }, async () => {
    const store = new SpaceStore();
    const { state } = createPaneStateHarness();
    const providers = new Map<string, SpaceTreeDataProvider>();
    const openPane = async (seed: PaneSeed): Promise<void> => {
      await seedPaneFromRoot(store, state, seed.paneId, seed.root, seed.overrides ?? {});
      providers.set(seed.paneId, createPaneProvider(store, state, seed.paneId));
    };
    try {
      for (const seed of panes) await openPane(seed);
      return await run({
        store,
        state,
        providers,
        provider: paneId => {
          let provider = providers.get(paneId);
          if (!provider) {
            provider = createPaneProvider(store, state, paneId);
            providers.set(paneId, provider);
          }
          return provider;
        },
        sync: paneId => {
          const provider = providers.get(paneId);
          if (provider) syncPaneScope(store, state, provider, paneId);
        },
        openPane,
      });
    } finally {
      for (const provider of providers.values()) provider.dispose();
      store.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Cascade harness（接線方式鏡像 extension.ts：state 寫入後同步 runtime scope）
// ---------------------------------------------------------------------------

export interface CascadePaneSeed {
  paneId: string;
  root: string | null;
  parentPaneId?: string | null;
  follow?: boolean;
  overrides?: Partial<PaneState>;
}

export interface PaneCascadeHarness {
  state: PaneStateStore;
  /** 以同一份 memento 重載 store（PD-I4：驗證持久化後可還原）。 */
  reload: () => PaneStateStore;
  /** 底層 memento：可直接讀取 `panes.v3` 原始文件做一致性斷言。 */
  memento: MementoLike;
  store: SpaceStore;
  /** 預設接線的 controller（已 attach 所有種子 pane 的 selection emitter）。 */
  controller: PaneCascadeController;
  runtimes: Map<string, PaneCascadeRuntime>;
  providers: SpaceTreeDataProvider[];
  /** 取得該 pane 的 provider（尚未建立時依 pane 狀態建立並掛上 runtime）。 */
  provider: (paneId: string) => SpaceTreeDataProvider;
  /** 同步 runtime scope 與 provider scope（root 變更後呼叫）。 */
  sync: (paneId: string) => void;
  /** 透過預設通道模擬 pane TreeView 的 selection event。 */
  emit: (paneId: string, selection: PaneCascadeSelection | undefined) => void;
  /** 預設 adapter（cascade 寫 root 後同步 scope）；自訂 controller 可包層後重用。 */
  adapter: PaneCascadeStateAdapter;
  /** 新啟用的 pane 補接預設 controller 的 listener（PD-I3）。 */
  attachCascade: (paneId: string) => void;
  /** 以自訂 state adapter／stat 另建 controller（用於 race／gate 類案例）。 */
  createController: (state?: PaneCascadeStateAdapter, overrides?: PaneCascadeControllerOverrides) => PaneCascadeController;
  /** 建立專屬 selection 通道並接到指定 controller（不會經過預設 controller）。 */
  makeChannel: (paneId: string, controller: PaneCascadeController) => SelectionChannel;
}

/** race／gate 案例可覆寫 stat（例如延後返回以模擬持久化進行中）。 */
export interface PaneCascadeControllerOverrides {
  stat?: (uri: vscode.Uri) => Promise<vscode.FileStat>;
  onError?: (error: unknown) => void;
}

export interface SelectionChannel {
  fire(selection: PaneCascadeSelection | undefined): void;
  dispose(): void;
}

/**
 * 建立 pane cascade 執行環境：每個 pane 有自己的 provider（scope = paneId＋definition）、
 * runtime scope（`{ paneId, root }`）與 selection emitter。adapter 寫入子 root 後同步兩處，
 * 語意與 extension.ts 的 cascade adapter（setPaneRoot → applyPaneScope）一致。
 */
export async function withPaneCascade<T>(
  spaces: SpaceConfigEntry[],
  seeds: CascadePaneSeed[],
  run: (args: PaneCascadeHarness) => Promise<T>
): Promise<T> {
  return withGlobalSettings({ spaces }, async () => {
    const store = new SpaceStore();
    const harness = createPaneStateHarness();
    const { state } = harness;
    const runtimes = new Map<string, PaneCascadeRuntime>();
    const providerMap = new Map<string, SpaceTreeDataProvider>();
    const providers: SpaceTreeDataProvider[] = [];
    const emitters = new Map<string, vscode.EventEmitter<PaneCascadeSelection | undefined>>();
    const listeners = new Map<string, (selection: PaneCascadeSelection | undefined) => void>();
    const extraChannels: SelectionChannel[] = [];

    const attachRuntime = (paneId: string): void => {
      const provider = new SpaceTreeDataProvider(store, state, paneScopeFor(store, state, paneId));
      providers.push(provider);
      providerMap.set(paneId, provider);
      const pane = state.get(paneId);
      runtimes.set(paneId, {
        id: paneId,
        scope: activeRoot(pane) ? { paneId, root: activeRoot(pane) } : undefined,
        provider,
        treeView: { message: '' },
      });
      if (!emitters.has(paneId)) {
        const emitter = new vscode.EventEmitter<PaneCascadeSelection | undefined>();
        emitters.set(paneId, emitter);
        emitter.event(selection => { listeners.get(paneId)?.(selection); });
      }
    };

    const sync = (paneId: string): void => {
      const runtime = runtimes.get(paneId);
      const provider = providerMap.get(paneId);
      if (!runtime || !provider) return;
      const pane = state.get(paneId);
      runtime.scope = activeRoot(pane) ? { paneId, root: activeRoot(pane) } : undefined;
      provider.setScope(paneScopeFor(store, state, paneId));
    };

    const adapter: PaneCascadeStateAdapter = {
      getMode: () => state.getMode(),
      switchRoot: async (paneId: string, root: string) => {
        await state.switchRoot(paneId, root);
        sync(paneId);
      },
      // S4.1R11-D6：守門以父 pane 的所有 root 判定（多 root cascade）。
      getPaneRoots: (paneId: string) => state.get(paneId).roots,
    };

    const createController = (override?: PaneCascadeStateAdapter, options?: PaneCascadeControllerOverrides): PaneCascadeController => new PaneCascadeController({
      state: override ?? adapter,
      getRuntime: paneId => runtimes.get(paneId),
      isAllowedRoot: (paneRoots, candidate) => paneRoots.some(root => isAllowedSpaceRoot(root, candidate)),
      stat: options?.stat ?? (async uri => await vscode.workspace.fs.stat(uri)),
      directoryType: vscode.FileType.Directory,
      ...(options?.onError ? { onError: options.onError } : {}),
    });

    let controller: PaneCascadeController | undefined;
    const attachToController = (target: PaneCascadeController, paneId: string): void => {
      target.attach(paneId, listener => {
        listeners.set(paneId, listener);
        return new vscode.Disposable(() => listeners.delete(paneId));
      });
    };
    try {
      for (const seed of seeds) {
        if (seed.paneId !== 'pane1') await state.setMode('dual');
        await state.setPaneRoots(seed.paneId, seed.root ? [seed.root] : []);
        Object.assign(state.get(seed.paneId), seed.overrides ?? {});
        attachRuntime(seed.paneId);
      }
      controller = createController();
      for (const paneId of runtimes.keys()) attachToController(controller, paneId);
      return await run({
        state,
        reload: harness.reload,
        memento: harness.memento,
        store,
        controller,
        runtimes,
        providers,
        provider: paneId => {
          const existing = providerMap.get(paneId);
          if (existing) return existing;
          attachRuntime(paneId);
          return providerMap.get(paneId)!;
        },
        sync,
        emit: (paneId, selection) => emitters.get(paneId)!.fire(selection),
        adapter,
        attachCascade: paneId => attachToController(controller!, paneId),
        createController,
        makeChannel: (paneId, target) => {
          const emitter = new vscode.EventEmitter<PaneCascadeSelection | undefined>();
          let listener: ((selection: PaneCascadeSelection | undefined) => void) | undefined;
          const attached = target.attach(paneId, handler => {
            listener = handler;
            return new vscode.Disposable(() => { listener = undefined; });
          });
          const subscription = emitter.event(selection => listener?.(selection));
          const channel: SelectionChannel = {
            fire: selection => emitter.fire(selection),
            dispose: () => { subscription.dispose(); attached.dispose(); emitter.dispose(); },
          };
          extraChannels.push(channel);
          return channel;
        },
      });
    } finally {
      controller?.dispose();
      for (const channel of extraChannels) channel.dispose();
      for (const emitter of emitters.values()) emitter.dispose();
      for (const provider of providers) provider.dispose();
      store.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// 任意資料夾 fixture（PD-I1／PD-I5：root 不必是已配置的 space）
// ---------------------------------------------------------------------------

/** 在系統暫存目錄建立一棵任意檔案樹，回傳根目錄路徑（工作區外，且不在 spaces 設定中）。 */
export function createTempTree(entries: Record<string, string>, prefix = 'code-folder-spaces-pane-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [relative, content] of Object.entries(entries)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

export function removeTempTree(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
