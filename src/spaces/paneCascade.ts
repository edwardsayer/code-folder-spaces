import * as vscode from 'vscode';
import { isPaneRootDirectory, type PaneLinkState } from './paneRules';

/** v2 過渡（R1 S2）：固定 pane1→pane2，等價於原 getFollowingChildPaneIds 的單子情境。 */
function followingChildPaneIds(links: Record<string, PaneLinkState>, parentPaneId: string): string[] {
  return Object.keys(links).filter(id => links[id].parentPaneId === parentPaneId && links[id].follow);
}

/** Pane cascade scope (S4R6): keyed by pane id; `root` is the pane's own root. */
export interface PaneCascadeScope {
  paneId: string;
  root: string | null;
}

export interface PaneCascadeRuntime {
  id: string;
  scope?: PaneCascadeScope;
  provider: {
    refresh(): void;
  };
  treeView: { message?: string };
  staleRoot?: string;
}

export interface PaneCascadeSelection {
  uri?: vscode.Uri;
  isDirectory: boolean;
}

export interface PaneCascadeStateAdapter {
  getPaneLinks(): Record<string, PaneLinkState>;
  /**
   * Write the child pane root when the parent selects a different folder
   * (S4R6-D74). Must not change `follow`; manual child root switches are
   * temporary overrides that the next parent selection replaces.
   */
  switchRoot(paneId: string, root: string): Promise<void>;
  /**
   * 父 pane 目前的所有 root（S4.1R11-D6）。多 root pane 選取任一 root 內的資料夾
   * 都必須能驅動子 pane，因此守門不可只看 `activeRoot`（審查 P1-2）。
   */
  getPaneRoots(paneId: string): string[];
}

export interface PaneCascadeOptions {
  state: PaneCascadeStateAdapter;
  getRuntime(id: string): PaneCascadeRuntime | undefined;
  /** S4R6-D67: the boundary is the pane's own root, not a configured space. */
  isAllowedRoot(paneRoots: readonly string[], candidate: string): boolean;
  stat(uri: vscode.Uri): Promise<vscode.FileStat>;
  directoryType: vscode.FileType;
  onError?(error: unknown): void;
  /** S4.1R19：follow 中的子窗格尚無 root（scope 為空）時回呼，供上層提示而非靜默略過。 */
  onEmptyChild?(childPaneId: string): void;
  debounceMs?: number;
  expectedRootMs?: number;
}

interface ParentSnapshot {
  runtime: PaneCascadeRuntime;
  paneId: string;
  root: string | null;
  /** S4.1R11-D6：父 pane 的全部 root，供守門判定（審查 P1-2）。 */
  roots: readonly string[];
}

interface PaneTask {
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  expectedRoot?: string;
  expectedRootTimer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
}

/** 維持單向 pane 鏈；TreeView selection event 由 attach() 真正接入。 */
export class PaneCascadeController implements vscode.Disposable {
  private readonly tasks = new Map<string, PaneTask>();
  private readonly listeners = new Map<string, vscode.Disposable>();
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: PaneCascadeOptions) {}

  attach(
    paneId: string,
    subscribe: (listener: (selection: PaneCascadeSelection | undefined) => void) => vscode.Disposable
  ): vscode.Disposable {
    if (this.disposed) throw new Error('Pane cascade controller has been disposed.');
    this.listeners.get(paneId)?.dispose();
    this.listeners.delete(paneId);
    this.detach(paneId);
    const listener = subscribe(selection => this.handleSelection(paneId, selection));
    this.listeners.set(paneId, listener);
    return new vscode.Disposable(() => {
      if (this.listeners.get(paneId) === listener) this.listeners.delete(paneId);
      listener.dispose();
      this.detach(paneId);
    });
  }

  /** Tree selection endpoint is public for wiring; production callers use attach(). */
  handleSelection(paneId: string, selection: PaneCascadeSelection | undefined): void {
    if (this.disposed) return;
    const task = this.taskFor(paneId);
    const selectedUri = selection?.uri;
    if (task.expectedRoot !== undefined) {
      const suppress = selectedUri?.fsPath === task.expectedRoot;
      task.expectedRoot = undefined;
      if (task.expectedRootTimer) clearTimeout(task.expectedRootTimer);
      task.expectedRootTimer = undefined;
      if (suppress) return;
    }
    const parent = this.options.getRuntime(paneId);
    if (!parent?.scope) return;
    const parentSnapshot: ParentSnapshot = {
      runtime: parent,
      paneId,
      root: parent.scope.root,
      roots: this.options.state.getPaneRoots(paneId),
    };
    const links = this.options.state.getPaneLinks();
    if (!followingChildPaneIds(links, paneId).length) return;
    const generation = ++task.generation;
    if (task.timer) clearTimeout(task.timer);
    task.timer = setTimeout(() => {
      task.timer = undefined;
      void this.cascade(paneId, selection, generation, task, parentSnapshot);
    }, this.options.debounceMs ?? 100);
  }

  detach(paneId: string): void {
    const listener = this.listeners.get(paneId);
    if (listener) {
      this.listeners.delete(paneId);
      listener.dispose();
    }
    const task = this.tasks.get(paneId);
    if (!task) return;
    task.disposed = true;
    task.generation++;
    if (task.timer) clearTimeout(task.timer);
    if (task.expectedRootTimer) clearTimeout(task.expectedRootTimer);
    this.tasks.delete(paneId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const listener of this.listeners.values()) listener.dispose();
    this.listeners.clear();
    for (const id of this.tasks.keys()) this.detach(id);
  }

  private taskFor(paneId: string): PaneTask {
    let task = this.tasks.get(paneId);
    if (!task) {
      task = { generation: 0, disposed: false };
      this.tasks.set(paneId, task);
    }
    return task;
  }

  private async cascade(
    paneId: string,
    selection: PaneCascadeSelection | undefined,
    generation: number,
    task: PaneTask,
    parentSnapshot: ParentSnapshot
  ): Promise<void> {
    const selectedUri = selection?.uri;
    if (!selectedUri || !selection?.isDirectory || !this.isCurrent(paneId, task, generation, parentSnapshot)) return;
    // D61/D67：防禦性守門——選取項必須位於父 pane **任一** root 內（S4.1R11-D6）；
    // 不再要求位於子 pane 的舊 root 內，讓子 pane 可被帶到父 root 內任何資料夾。
    const parentRoots = parentSnapshot.roots.length ? parentSnapshot.roots : (parentSnapshot.root ? [parentSnapshot.root] : []);
    if (!parentRoots.length || !this.options.isAllowedRoot(parentRoots, selectedUri.fsPath)) return;
    let stat: vscode.FileStat;
    try { stat = await this.options.stat(selectedUri); } catch { return; }
    if (!this.isCurrent(paneId, task, generation, parentSnapshot) || !isPaneRootDirectory(stat.type, this.options.directoryType)) return;

    for (const childId of followingChildPaneIds(this.options.state.getPaneLinks(), paneId)) {
      if (!this.isCurrent(paneId, task, generation, parentSnapshot)) return;
      const child = this.options.getRuntime(childId);
      // S4.1R19（Bug C 修正）：子窗格還沒 root（scope 為空）時，沉靜 continue 會讓使用者覺得
      // 「點資料夾沒反應」。改為回報一次原因，讓呼叫端提示（父側照常運作）。
      if (!child?.scope) {
        this.options.onEmptyChild?.(childId);
        continue;
      }
      // 序列化狀態寫入，避免前一筆尚在持久化時，舊選取覆蓋後到的新根。
      const write = this.writes.then(async () => {
        if (!this.isCurrent(paneId, task, generation, parentSnapshot)) return;
        const links = this.options.state.getPaneLinks();
        const childLink = links[childId];
        if (!childLink || childLink.parentPaneId !== paneId || !childLink.follow) return;
        await this.options.state.switchRoot(childId, selectedUri.fsPath);
        if (!this.isCurrent(paneId, task, generation, parentSnapshot)) return;
        const current = this.options.getRuntime(childId);
        if (!current?.scope) return;
        const childTask = this.taskFor(childId);
        // D74：expectedRoot 抑制僅吸收自己寫入造成的回聲，不阻擋手動 switchRoot。
        childTask.expectedRoot = selectedUri.fsPath;
        if (childTask.expectedRootTimer) clearTimeout(childTask.expectedRootTimer);
        childTask.expectedRootTimer = setTimeout(() => {
          childTask.expectedRoot = undefined;
          childTask.expectedRootTimer = undefined;
        }, this.options.expectedRootMs ?? 500);
        current.staleRoot = undefined;
        current.provider.refresh();
        current.treeView.message = '';
      });
      this.writes = write.catch(error => { this.options.onError?.(error); });
      await write.catch(() => undefined);
    }
  }

  private isCurrent(paneId: string, task: PaneTask, generation: number, parent?: ParentSnapshot): boolean {
    if (this.disposed || task.disposed || this.tasks.get(paneId) !== task || task.generation !== generation) return false;
    if (!parent) return true;
    const current = this.options.getRuntime(paneId);
    return current === parent.runtime && current.scope?.paneId === parent.paneId && current.scope.root === parent.root;
  }
}
