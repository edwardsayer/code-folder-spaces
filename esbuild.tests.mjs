import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.join(root, 'tests/integration/suite');
const entryPoints = fs.readdirSync(suiteDir, { recursive: true })
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => path.join(suiteDir, file));

await esbuild.build({
  entryPoints,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  outbase: path.join(root, 'tests'),
  outdir: path.join(root, 'out'),
  sourcemap: true,
  sourcesContent: false,
});
