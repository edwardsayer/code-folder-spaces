import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifestCommands = new Set((manifest.contributes?.commands ?? []).map(({ command }) => command));
const handlers = new Set();
const unresolved = new Set();

// 白名單目前為空；manifest 與 handler 必須完全對稱，避免靜默失效。
const exceptions = new Set();
const extensionPath = path.join(sourceRoot, 'extension.ts');
const extensionSource = fs.readFileSync(extensionPath, 'utf8');
const maxPaneMatch = extensionSource.match(/\bMAX_PANE_INDEX\s*=\s*(\d+)/);
const maxPaneIndex = maxPaneMatch ? Number(maxPaneMatch[1]) : undefined;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

for (const file of sourceFiles(sourceRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  const registerPattern = /registerCommand\(\s*(['"`])([^'"`]+)\1/g;
  for (const match of source.matchAll(registerPattern)) {
    const command = match[2];
    if (!command.includes('${')) {
      handlers.add(command);
      continue;
    }

    if (command.includes('${id}') && /^codeFolderSpaces\.\$\{id\}\./.test(command) && Number.isInteger(maxPaneIndex)) {
      for (let index = 1; index <= maxPaneIndex; index++) {
        handlers.add(command.replace('${id}', `pane${index}`));
      }
      continue;
    }
    unresolved.add(command);
  }
}

const manifestWithoutHandler = [...manifestCommands].filter((command) => !handlers.has(command) && !exceptions.has(command)).sort();
const handlerWithoutManifest = [...handlers].filter((command) => !manifestCommands.has(command) && !exceptions.has(command)).sort();
if (manifestWithoutHandler.length || handlerWithoutManifest.length) {
  console.log(`[check-command-parity] FAIL —`);
  for (const command of manifestWithoutHandler) console.log(`  ❌ manifest 有但無 handler：${command}`);
  for (const command of handlerWithoutManifest) console.log(`  ❌ handler 有但 manifest 無：${command}`);
} else {
  console.log(`[check-command-parity] PASS — ${manifestCommands.size} manifest / ${handlers.size} handlers`);
}
for (const pattern of [...unresolved].sort()) {
  console.log(`  ℹ️  無法靜態展開（未計入比對）：${pattern}`);
}
process.exitCode = manifestWithoutHandler.length || handlerWithoutManifest.length ? 1 : 0;
