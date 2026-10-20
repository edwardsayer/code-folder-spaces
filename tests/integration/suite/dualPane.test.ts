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
});
