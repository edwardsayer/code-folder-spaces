import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activeRoot } from '../../../src/spaces/viewState';
import { VIEW_PRESETS } from '../../../src/spaces/viewPresets';
import { assertFixtureWorkspace, fixtureWorkspace, sameFixturePath, withPaneCascade, withPaneProviders } from './helpers';

suite('dual pane integration', () => {
  const alpha = path.join(fixtureWorkspace, 'spaces/alpha');
  const nested = path.join(alpha, 'nested');
  const arbitrary = path.join(fixtureWorkspace, 'spaces/logs');

  suiteSetup(() => assertFixtureWorkspace());

  async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for pane cascade.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  test('tree mode exposes pane1 only; dual mode adds pane2', async () => withPaneProviders(
    [{ path: alpha, name: 'alpha' }], [{ paneId: 'pane1', root: alpha }], async ({ state }) => {
      assert.deepEqual(state.getEnabledPaneIds(), ['pane1']);
      await state.setMode('dual');
      assert.deepEqual(state.getEnabledPaneIds(), ['pane1', 'pane2']);
    }
  ));

  test('pane2 can switch to an arbitrary root without changing pane1', async () => withPaneProviders(
    [{ path: alpha, name: 'alpha' }], [
      { paneId: 'pane1', root: alpha }, { paneId: 'pane2', root: alpha },
    ], async ({ state, provider, sync }) => {
      const before = activeRoot(state.get('pane1'));
      await state.switchRoot('pane2', arbitrary);
      sync('pane2');
      provider('pane2');
      assert.equal(activeRoot(state.get('pane1')), before);
      assert.equal(activeRoot(state.get('pane2')), arbitrary);
      assert.equal(provider('pane2').scope?.definitions[0]?.basePath, arbitrary);
      assert.equal(provider('pane1').scope?.definitions[0]?.basePath, alpha);
    }
  ));

  test('pane1 and pane2 keep separate filter, sort, view, and drill state', async () => withPaneProviders(
    [{ path: alpha, name: 'alpha' }], [
      { paneId: 'pane1', root: alpha }, { paneId: 'pane2', root: alpha },
    ], async ({ state }) => {
      const pane1 = state.get('pane1');
      const pane1Before = structuredClone(pane1);
      await state.setFilter('pane2', 'nested');
      await state.setSort('pane2', 'mtime', 'desc');
      await state.setView('pane2', VIEW_PRESETS.Contents);
      await state.drillDown('pane2', nested, VIEW_PRESETS.Files);
      assert.deepEqual(pane1.filter, pane1Before.filter);
      assert.deepEqual(pane1.sort, pane1Before.sort);
      assert.deepEqual(pane1.view, pane1Before.view);
      assert.deepEqual(pane1.drillStack, pane1Before.drillStack);
      const pane2State = structuredClone(state.get('pane2'));
      await state.setFilter('pane1', 'alpha');
      await state.setSort('pane1', 'ctime', 'desc');
      await state.setView('pane1', VIEW_PRESETS.List);
      await state.drillDown('pane1', nested, VIEW_PRESETS.Files);
      assert.deepEqual(state.get('pane2'), pane2State);
    }
  ));

  test('pane1 directory selection updates pane2 only in dual mode; file selection is a no-op', async () => withPaneCascade(
    [alpha], [
      { paneId: 'pane1', root: alpha },
      { paneId: 'pane2', root: alpha, parentPaneId: 'pane1', follow: true },
    ], async ({ state, runtimes, emit }) => {
      await state.setMode('dual');
      emit('pane1', { uri: vscode.Uri.file(nested), isDirectory: true });
      await waitFor(() => {
        const root = runtimes.get('pane2')!.scope?.root;
        return root !== null && root !== undefined && sameFixturePath(root, nested);
      });
      emit('pane1', { uri: vscode.Uri.file(path.join(alpha, 'deep.md')), isDirectory: false });
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(runtimes.get('pane2')!.scope?.root, nested);
      await state.setMode('tree');
      emit('pane1', { uri: vscode.Uri.file(alpha), isDirectory: true });
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.equal(runtimes.get('pane2')!.scope?.root, nested);
    }
  ));

  test('resetting pane1 drill before dual preserves roots and pane2 drill', async () => withPaneProviders(
    [{ path: alpha, name: 'alpha' }], [
      { paneId: 'pane1', root: alpha }, { paneId: 'pane2', root: alpha },
    ], async ({ state }) => {
      const rootsBefore = [...state.get('pane1').roots];
      await state.setMode('dual');
      await state.drillDown('pane2', nested, VIEW_PRESETS.Files);
      const pane2DrillStack = [...state.get('pane2').drillStack];
      await state.setMode('tree');
      await state.drillDown('pane1', nested, VIEW_PRESETS.Files);
      assert.equal(state.get('pane1').drillRoot, nested);
      await state.resetRoot('pane1');
      await state.setMode('dual');
      assert.equal(state.get('pane1').drillRoot, null);
      assert.deepEqual(state.get('pane1').drillStack, []);
      assert.deepEqual(state.get('pane1').roots, rootsBefore);
      assert.equal(state.get('pane2').drillRoot, nested);
      assert.deepEqual(state.get('pane2').drillStack, pane2DrillStack);
    }
  ));

  test('getEnabledPaneIds reflects mode after close/add', async () => withPaneProviders(
    [{ path: alpha, name: 'alpha' }], [{ paneId: 'pane1', root: alpha }], async ({ state }) => {
      await state.setMode('dual');
      assert.deepEqual(state.getEnabledPaneIds(), ['pane1', 'pane2']);
      await state.switchRoot('pane2', arbitrary);
      await state.setMode('tree');
      assert.deepEqual(state.getEnabledPaneIds(), ['pane1']);
      assert.equal(activeRoot(state.get('pane2')), arbitrary);
    }
  ));

  test('mode 切換與 pane2 close 自動套用 defaultPreset 設定', async () => {
    const ext = vscode.extensions.getExtension('edwardsayer.code-folder-spaces');
    assert.ok(ext);
    const api = await ext.activate() as { getPanes(): Array<{ id: string; view: unknown; mode: string }> };

    const config = vscode.workspace.getConfiguration('codeFolderSpaces');
    const origSingle = config.inspect('defaultPreset.singlePane')?.workspaceValue;
    const origDual1 = config.inspect('defaultPreset.dualPane.pane1')?.workspaceValue;
    const origDual2 = config.inspect('defaultPreset.dualPane.pane2')?.workspaceValue;

    try {
      // 1. 切換至 Dual：預設 pane1=Navigate, pane2=List
      await vscode.commands.executeCommand('codeFolderSpaces.pane1.mode.dual');
      let panes = api.getPanes();
      const dualP1 = panes.find(p => p.id === 'pane1');
      const dualP2 = panes.find(p => p.id === 'pane2');
      assert.deepEqual(dualP1?.view, VIEW_PRESETS.Navigate, 'Dual 模式 pane1 應套用預設 Navigate');
      assert.deepEqual(dualP2?.view, VIEW_PRESETS.List, 'Dual 模式 pane2 應套用預設 List');

      // 2. 切換至 Tree：pane1 切回預設 Explorer
      await vscode.commands.executeCommand('codeFolderSpaces.pane1.mode.tree');
      panes = api.getPanes();
      const treeP1 = panes.find(p => p.id === 'pane1');
      assert.deepEqual(treeP1?.view, VIEW_PRESETS.Explorer, 'Tree 模式 pane1 應套用預設 Explorer');

      // 3. 切至 Dual 後執行 pane2.close：pane1 亦需切為 Single 預設 Explorer
      await vscode.commands.executeCommand('codeFolderSpaces.pane1.mode.dual');
      await vscode.commands.executeCommand('codeFolderSpaces.pane2.close');
      panes = api.getPanes();
      const closedP1 = panes.find(p => p.id === 'pane1');
      assert.deepEqual(closedP1?.view, VIEW_PRESETS.Explorer, '關閉 pane2 後 pane1 應套用預設 Explorer');

      // 4. 自訂設定值：切換時套用使用者自訂 preset
      await config.update('defaultPreset.singlePane', 'Context', vscode.ConfigurationTarget.Workspace);
      await config.update('defaultPreset.dualPane.pane1', 'Columns', vscode.ConfigurationTarget.Workspace);
      await config.update('defaultPreset.dualPane.pane2', 'Files', vscode.ConfigurationTarget.Workspace);

      await vscode.commands.executeCommand('codeFolderSpaces.pane1.mode.dual');
      panes = api.getPanes();
      assert.deepEqual(panes.find(p => p.id === 'pane1')?.view, VIEW_PRESETS.Columns, '自訂 dualPane.pane1 Columns 應生效');
      assert.deepEqual(panes.find(p => p.id === 'pane2')?.view, VIEW_PRESETS.Files, '自訂 dualPane.pane2 Files 應生效');

      await vscode.commands.executeCommand('codeFolderSpaces.pane1.mode.tree');
      panes = api.getPanes();
      assert.deepEqual(panes.find(p => p.id === 'pane1')?.view, VIEW_PRESETS.Context, '自訂 singlePane Context 應生效');
    } finally {
      await config.update('defaultPreset.singlePane', origSingle, vscode.ConfigurationTarget.Workspace);
      await config.update('defaultPreset.dualPane.pane1', origDual1, vscode.ConfigurationTarget.Workspace);
      await config.update('defaultPreset.dualPane.pane2', origDual2, vscode.ConfigurationTarget.Workspace);
      // 還原為 tree 模式
      await vscode.commands.executeCommand('codeFolderSpaces.pane1.mode.tree');
    }
  });
});
