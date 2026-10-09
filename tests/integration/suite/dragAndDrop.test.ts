import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SpaceDefinition } from '../../../src/types';
import { UndoStack } from '../../../src/spaces/spaceActions';
import { createTreeDragAndDropController } from '../../../src/spaces/treeDragAndDrop';
import { SpaceEntryNode, SpaceRootNode, type SpaceNode } from '../../../src/spaces/spaceTreeDataProvider';

suite('TreeView drag and drop controller', () => {
  async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-spaces-drag-'));
    try { return await run(root); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }

  function definition(basePath: string, sourceIndex = 0): SpaceDefinition {
    return { basePath, name: path.basename(basePath), showFiles: true, include: [], exclude: [], sourceIndex };
  }

  async function makeController(definitions: SpaceDefinition[], options: { trusted?: boolean } = {}) {
    const undoStack = new UndoStack();
    let changed = 0;
    let trustRequests = 0;
    let trustWarnings = 0;
    const errors: unknown[] = [];
    const drillStateSources: vscode.Uri[][] = [];
    const controller = createTreeDragAndDropController('pane2', {
      getDefinitions: () => definitions,
      undoStack,
      requireTrust: () => {
        trustRequests++;
        if (options.trusted ?? true) return true;
        trustWarnings++;
        return false;
      },
      clearDrillStateForMovedSources: async sources => { drillStateSources.push([...sources]); },
      onChanged: () => { changed++; },
      onError: error => { errors.push(error); },
    });
    return {
      controller, undoStack, errors, drillStateSources,
      get changed() { return changed; },
      get trustRequests() { return trustRequests; },
      get trustWarnings() { return trustWarnings; },
    };
  }

  function rootNode(folder: string): SpaceRootNode {
    return new SpaceRootNode(definition(folder), undefined);
  }

  function entryNode(uri: vscode.Uri, isDirectory: boolean, parent: SpaceRootNode): SpaceEntryNode {
    return new SpaceEntryNode(uri, isDirectory, parent.definition, parent, isDirectory);
  }

  async function drop(controller: vscode.TreeDragAndDropController<SpaceNode>, target: SpaceNode | undefined, items?: Record<string, string>): Promise<void> {
    const transfer = new vscode.DataTransfer();
    const tokenSource = new vscode.CancellationTokenSource();
    for (const [mime, value] of Object.entries(items ?? {})) transfer.set(mime, new vscode.DataTransferItem(value));
    try {
      assert.ok(controller.handleDrop);
      await controller.handleDrop(target, transfer, tokenSource.token);
    } finally { tokenSource.dispose(); }
  }

  const internalMime = 'application/vnd.code.tree.codeFolderSpaces.pane2';
  const pathKey = (value: string): string => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);

  test('drag serializes only file entries to both MIME types with escaped URI and CRLF', async () => withTempRoot(async root => {
    const space = path.join(root, 'space # one');
    const sourcePath = path.join(space, 'notes #1.txt');
    await fs.mkdir(space, { recursive: true });
    await fs.writeFile(sourcePath, 'drag');
    const context = await makeController([definition(space)]);
    const transfer = new vscode.DataTransfer();
    const tokenSource = new vscode.CancellationTokenSource();
    const spaceRoot = rootNode(space);
    const sourceNode = entryNode(vscode.Uri.file(sourcePath), false, spaceRoot);
    try {
      assert.ok(context.controller.handleDrag);
      await context.controller.handleDrag([spaceRoot, sourceNode], transfer, tokenSource.token);
    } finally { tokenSource.dispose(); }
    const expected = vscode.Uri.file(sourcePath).toString();
    assert.equal(await transfer.get('text/uri-list')?.asString(), expected);
    assert.equal(await transfer.get(internalMime)?.asString(), expected);
    assert.ok(expected.includes('%20') && expected.includes('%23'));
    const emptyTransfer = new vscode.DataTransfer();
    const emptyTokenSource = new vscode.CancellationTokenSource();
    try {
      await context.controller.handleDrag([spaceRoot], emptyTransfer, emptyTokenSource.token);
    } finally { emptyTokenSource.dispose(); }
    assert.equal(emptyTransfer.get('text/uri-list'), undefined);
    assert.equal(emptyTransfer.get(internalMime), undefined);
  }));

  test('internal source moves, is undoable, and URI list preserves escaped paths and CRLF entries', async () => withTempRoot(async root => {
    const space = path.join(root, 'space # one');
    const destinationPath = path.join(space, 'destination');
    const sourcePath = path.join(space, 'notes #1.txt');
    await fs.mkdir(destinationPath, { recursive: true });
    await fs.writeFile(sourcePath, 'internal');
    const source = vscode.Uri.file(sourcePath);
    const context = await makeController([definition(space)]);
    const payload = `${source.toString()}\r\n# comment\r\n${vscode.Uri.file(path.join(root, 'missing')).toString()}`;
    await drop(context.controller, entryNode(vscode.Uri.file(destinationPath), true, rootNode(space)), { [internalMime]: payload });
    assert.equal(await fs.readFile(path.join(destinationPath, 'notes #1.txt'), 'utf8'), 'internal');
    await assert.rejects(fs.stat(sourcePath));
    assert.equal(context.undoStack.size, 1);
    assert.equal(context.changed, 1);
    assert.equal(context.errors.length, 0);
    assert.deepEqual(context.drillStateSources.map(batch => batch.map(uri => pathKey(uri.fsPath))), [[pathKey(sourcePath)]]);
    const undo = context.undoStack.pop()!;
    await vscode.workspace.fs.rename(vscode.Uri.file(undo.to), vscode.Uri.file(undo.from), { overwrite: false });
    assert.equal(await fs.readFile(sourcePath, 'utf8'), 'internal');
  }));

  test('cross-space internal move uses the shared undo stack and drill-state callback', async () => withTempRoot(async root => {
    const sourceSpace = path.join(root, 'source');
    const destinationSpace = path.join(root, 'destination');
    const sourcePath = path.join(sourceSpace, 'move.txt');
    await fs.mkdir(sourceSpace);
    await fs.mkdir(destinationSpace);
    await fs.writeFile(sourcePath, 'cross-space');
    const context = await makeController([definition(sourceSpace), definition(destinationSpace, 1)]);
    await drop(context.controller, rootNode(destinationSpace), { [internalMime]: vscode.Uri.file(sourcePath).toString() });
    assert.equal(await fs.readFile(path.join(destinationSpace, 'move.txt'), 'utf8'), 'cross-space');
    assert.equal(pathKey(context.undoStack.peek()!.from), pathKey(sourcePath));
    assert.equal(pathKey(context.undoStack.peek()!.to), pathKey(path.join(destinationSpace, 'move.txt')));
    assert.deepEqual(context.drillStateSources.map(batch => batch.map(uri => pathKey(uri.fsPath))), [[pathKey(sourcePath)]]);
  }));

  test('external URI-list source remains in place and is copied without undo or drill-state clearing', async () => withTempRoot(async root => {
    const space = path.join(root, 'space');
    const external = path.join(root, 'outside', 'external.txt');
    const destinationPath = path.join(space, 'target');
    await fs.mkdir(path.dirname(external), { recursive: true });
    await fs.mkdir(destinationPath, { recursive: true });
    await fs.writeFile(external, 'external-copy');
    const context = await makeController([definition(space)]);
    await drop(context.controller, entryNode(vscode.Uri.file(destinationPath), true, rootNode(space)), { 'text/uri-list': `${vscode.Uri.file(external).toString()}\r\n` });
    assert.equal(await fs.readFile(external, 'utf8'), 'external-copy');
    assert.equal(await fs.readFile(path.join(destinationPath, 'external.txt'), 'utf8'), 'external-copy');
    assert.equal(context.undoStack.size, 0);
    assert.deepEqual(context.drillStateSources, []);
  }));

  test('unique naming, self/descendant protection, file targets and empty targets', async () => withTempRoot(async root => {
    const space = path.join(root, 'space');
    const folder = path.join(space, 'folder');
    const destination = path.join(space, 'destination');
    const untouched = path.join(folder, 'untouched.txt');
    await fs.mkdir(folder, { recursive: true });
    await fs.mkdir(destination);
    await fs.writeFile(path.join(folder, 'same.txt'), 'source');
    await fs.writeFile(untouched, 'untouched');
    await fs.writeFile(path.join(destination, 'same.txt'), 'existing');
    const context = await makeController([definition(space)]);
    const spaceRoot = rootNode(space);
    const movedSource = path.join(folder, 'same.txt');
    await drop(context.controller, entryNode(vscode.Uri.file(destination), true, spaceRoot), { [internalMime]: vscode.Uri.file(movedSource).toString() });
    assert.equal(await fs.readFile(path.join(destination, 'same 1.txt'), 'utf8'), 'source');
    assert.equal(await fs.readFile(path.join(destination, 'same.txt'), 'utf8'), 'existing');
    await assert.rejects(fs.stat(movedSource));
    await drop(context.controller, entryNode(vscode.Uri.file(folder), true, spaceRoot), { [internalMime]: vscode.Uri.file(folder).toString() });
    await drop(context.controller, entryNode(vscode.Uri.file(folder), true, spaceRoot), { [internalMime]: vscode.Uri.file(space).toString() });
    await drop(context.controller, entryNode(vscode.Uri.file(path.join(destination, 'same.txt')), false, spaceRoot), { [internalMime]: vscode.Uri.file(untouched).toString() });
    await drop(context.controller, undefined, { [internalMime]: vscode.Uri.file(untouched).toString() });
    assert.equal(await fs.readFile(untouched, 'utf8'), 'untouched');
    assert.equal(context.undoStack.size, 1);
  }));

  test('external ancestor directory cannot be copied into its configured descendant', async () => withTempRoot(async root => {
    const externalAncestor = path.join(root, 'ancestor');
    const space = path.join(externalAncestor, 'space');
    const destination = path.join(space, 'destination');
    const marker = path.join(externalAncestor, 'marker.txt');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(marker, 'keep');
    const context = await makeController([definition(space)]);
    await drop(context.controller, rootNode(destination), { 'text/uri-list': vscode.Uri.file(externalAncestor).toString() });
    assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
    assert.deepEqual(await fs.readdir(destination), []);
    assert.equal(context.undoStack.size, 0);
    assert.deepEqual(context.drillStateSources, []);
  }));

  test('no payload, missing/non-file targets, and non-file sources are no-ops without callback errors', async () => withTempRoot(async root => {
    const space = path.join(root, 'space');
    const destination = path.join(space, 'destination');
    const source = path.join(space, 'source.txt');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(source, 'unchanged');
    const context = await makeController([definition(space)]);
    const target = rootNode(destination);
    await drop(context.controller, target);
    await drop(context.controller, rootNode(path.join(root, 'does-not-exist')), { [internalMime]: vscode.Uri.file(source).toString() });
    const nonFileTarget = entryNode(vscode.Uri.parse('memfs:/destination'), true, target);
    await drop(context.controller, nonFileTarget, { [internalMime]: vscode.Uri.file(source).toString() });
    await drop(context.controller, target, { 'text/uri-list': vscode.Uri.parse('memfs:/not-supported.txt').toString() });
    assert.equal(await fs.readFile(source, 'utf8'), 'unchanged');
    assert.deepEqual(await fs.readdir(destination), []);
    assert.equal(context.undoStack.size, 0);
    assert.equal(context.changed, 0);
    assert.equal(context.errors.length, 0);
    assert.equal(context.trustRequests, 1);
    assert.equal(context.trustWarnings, 0);
  }));

  test('untrusted workspace refuses disk changes and invokes one trust warning gate', async () => withTempRoot(async root => {
    const space = path.join(root, 'space');
    const destination = path.join(space, 'destination');
    const source = path.join(space, 'source.txt');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(source, 'unchanged');
    const context = await makeController([definition(space)], { trusted: false });
    await drop(context.controller, rootNode(destination), { [internalMime]: vscode.Uri.file(source).toString() });
    assert.equal(await fs.readFile(source, 'utf8'), 'unchanged');
    assert.deepEqual(await fs.readdir(destination), []);
    assert.equal(context.undoStack.size, 0);
    assert.equal(context.changed, 0);
    assert.equal(context.errors.length, 0);
    assert.equal(context.trustRequests, 1);
    assert.equal(context.trustWarnings, 1);
  }));
});
