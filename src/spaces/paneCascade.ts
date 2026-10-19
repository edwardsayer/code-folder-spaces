import * as vscode from 'vscode';
import { isPaneRootDirectory } from './paneRules';
export interface PaneCascadeScope { paneId: string; root: string | null; }
export interface PaneCascadeRuntime {
  id: string; scope?: PaneCascadeScope; provider: { refresh(): void };
  treeView: { message?: string }; staleRoot?: string;
}
export interface PaneCascadeSelection { uri?: vscode.Uri; isDirectory: boolean; }
export interface PaneCascadeStateAdapter {
  getMode(): 'tree' | 'dual'; getPaneRoots(paneId: string): string[];
  switchRoot(paneId: string, root: string): Promise<void>;
}
export interface PaneCascadeOptions {
  state: PaneCascadeStateAdapter; getRuntime(id: string): PaneCascadeRuntime | undefined;
  isAllowedRoot(paneRoots: readonly string[], candidate: string): boolean;
  stat(uri: vscode.Uri): Promise<vscode.FileStat>; directoryType: vscode.FileType;
  onError?(error: unknown): void; onEmptyChild?(childPaneId: string): void; debounceMs?: number;
}
interface CascadeTask { generation: number; timer?: ReturnType<typeof setTimeout>; }
/** Dual 模式下僅由 pane1 的資料夾選取帶動 pane2。 */
export class PaneCascadeController implements vscode.Disposable {
  private readonly tasks = new Map<string, CascadeTask>();
  private readonly listeners = new Map<string, vscode.Disposable>();
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  constructor(private readonly options: PaneCascadeOptions) {}
  attach(paneId: string, subscribe: (listener: (selection: PaneCascadeSelection | undefined) => void) => vscode.Disposable): vscode.Disposable {
    if (paneId !== 'pane1' || this.disposed) return new vscode.Disposable(() => undefined);
    this.listeners.get(paneId)?.dispose(); this.detach(paneId);
    const listener = subscribe(selection => this.handleSelection(paneId, selection));
    this.listeners.set(paneId, listener);
    return new vscode.Disposable(() => {
      if (this.listeners.get(paneId) === listener) this.listeners.delete(paneId);
      listener.dispose(); this.detach(paneId);
    });
  }
  handleSelection(paneId: string, selection: PaneCascadeSelection | undefined): void {
    if (this.disposed || paneId !== 'pane1' || this.options.state.getMode() !== 'dual') return;
    const roots = this.options.state.getPaneRoots('pane1'), uri = selection?.uri;
    if (!uri || !selection.isDirectory || !roots.length || !this.options.isAllowedRoot(roots, uri.fsPath)) return;
    const task = this.tasks.get(paneId) ?? { generation: 0 };
    this.tasks.set(paneId, task);
    const generation = ++task.generation;
    if (task.timer) clearTimeout(task.timer);
    task.timer = setTimeout(() => { task.timer = undefined; void this.cascade(uri, task, generation); }, this.options.debounceMs ?? 100);
  }
  detach(paneId: string): void {
    this.listeners.get(paneId)?.dispose(); this.listeners.delete(paneId);
    const task = this.tasks.get(paneId);
    if (task?.timer) clearTimeout(task.timer);
    if (task) task.generation++; this.tasks.delete(paneId);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.listeners.keys()]) this.detach(id);
    for (const id of [...this.tasks.keys()]) this.detach(id);
  }
  private async cascade(uri: vscode.Uri, task: CascadeTask, generation: number): Promise<void> {
    if (!this.current(task, generation)) return;
    let stat: vscode.FileStat;
    try { stat = await this.options.stat(uri); } catch (error) { this.options.onError?.(error); return; }
    if (!this.current(task, generation) || !isPaneRootDirectory(stat.type, this.options.directoryType)) return;
    const write = this.writes.then(async () => {
      if (!this.current(task, generation) || this.options.state.getMode() !== 'dual') return;
      await this.options.state.switchRoot('pane2', uri.fsPath);
      if (!this.current(task, generation)) return;
      const child = this.options.getRuntime('pane2');
      if (!child?.scope) { this.options.onEmptyChild?.('pane2'); return; }
      child.staleRoot = undefined; child.provider.refresh(); child.treeView.message = '';
    });
    this.writes = write.catch(error => { this.options.onError?.(error); });
    await write.catch(() => undefined);
  }
  private current(task: CascadeTask, generation: number): boolean { return !this.disposed && task.generation === generation && this.tasks.get('pane1') === task; }
}
