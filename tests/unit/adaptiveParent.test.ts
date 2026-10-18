import { describe, expect, it } from 'vitest';
import { PaneStateStore } from '../../src/spaces/viewState';
import { effectiveView } from '../../src/spaces/viewState';
import {
  resolveConfiguredDefaultPreset,
  resolveConfiguredDefaultChildPreset,
  resolveConfiguredCascadeParentPreset
} from '../../src/spaces/viewPresets';

describe('OP-13 接龍自適應父面板模式與四項原版設定 (Adaptive parent panel mode & 4 Obsidian settings)', () => {
  const createStore = async () => {
    const map = new Map<string, unknown>();
    const store = new PaneStateStore({
      get: (key) => map.get(key) as never,
      update: async (key, val) => { map.set(key, val); },
    });
    await store.initialize({ spaces: [], showFilesDefault: true, configuredCount: 2, followWorkspaceDirectoryDefault: false });
    return { store };
  };

  it('四項設定解析器具有正確的預設 fallback 與型別校驗', () => {
    expect(resolveConfiguredDefaultPreset(undefined)).toBe('Explorer');
    expect(resolveConfiguredDefaultPreset('Files')).toBe('Files');
    expect(resolveConfiguredDefaultPreset('invalid')).toBe('Explorer');

    expect(resolveConfiguredDefaultChildPreset(undefined)).toBe('Contents');
    expect(resolveConfiguredDefaultChildPreset('List')).toBe('List');
    expect(resolveConfiguredDefaultChildPreset('invalid')).toBe('Contents');

    expect(resolveConfiguredCascadeParentPreset(undefined)).toBe('Navigate');
    expect(resolveConfiguredCascadeParentPreset('Columns')).toBe('Columns');
    expect(resolveConfiguredCascadeParentPreset('invalid')).toBe('Navigate');
  });

  it('當父面板擁有連動子面板時，自動備份並切換為 Navigate；子面板解除時無損還原', async () => {
    const { store } = await createStore();
    // 初始 pane1 為 Explorer
    expect(store.get('pane1').preset).toBe('Explorer');
    expect(effectiveView(store.get('pane1')).mode).toBe('tree');
    expect(effectiveView(store.get('pane1')).content).toBe('all');

    // 子窗格連動加入：父面板進入自適應模式
    const changed = await store.handleAdaptiveCascadeParent('pane1', true, 'Navigate');
    expect(changed).toBe(true);
    // 自動切換為導覽預設集 (Navigate: tree/all/folders)
    expect(store.get('pane1').preset).toBe('Navigate');
    expect(effectiveView(store.get('pane1')).content).toBe('folders');

    // 重複觸發不會覆蓋備份
    const noop = await store.handleAdaptiveCascadeParent('pane1', true, 'Navigate');
    expect(noop).toBe(false);

    // 子窗格解除/關閉：父面板還原原檢視
    const restored = await store.handleAdaptiveCascadeParent('pane1', false);
    expect(restored).toBe(true);
    expect(store.get('pane1').preset).toBe('Explorer');
    expect(effectiveView(store.get('pane1')).content).toBe('all');
    expect(store.get('pane1').adaptiveParentBackup).toBeNull();
  });

  it('父面板處於自訂組合時，自適應模式同樣能完整備份並精確還原自訂 view', async () => {
    const { store } = await createStore();
    // 設為自訂組合（必須是**不命中**任何預設集的組合；OP-21 後 `flat+1+all` 已成為 `Items`，故改用 flat+2+all）
    await store.setViewAxis('pane1', { axis: 'mode', value: 'flat' });
    await store.setViewAxis('pane1', { axis: 'level', value: 2 });
    expect(store.get('pane1').view).toBeDefined();

    // 進入自適應
    await store.handleAdaptiveCascadeParent('pane1', true, 'Columns');
    expect(store.get('pane1').preset).toBe('Columns');
    expect(store.get('pane1').view).toBeUndefined();

    // 還原
    await store.handleAdaptiveCascadeParent('pane1', false);
    expect(store.get('pane1').view).toEqual({ mode: 'flat', level: 2, content: 'all' });
  });
});
