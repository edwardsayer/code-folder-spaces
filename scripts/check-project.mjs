#!/usr/bin/env node
/**
 * Folder Spaces 專案健康度檢查（zero-dependency，Node 20+）。
 *
 * 檢查必要檔案、manifest 契約（engines.vscode／main／publisher／capabilities／
 * @types/vscode 對齊）、i18n 檔案與打包進入點。
 * 用法：npm run check:project
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch {
    return null;
  }
};

const requiredPaths = [
  'src/extension.ts',
  'package.json',
  'package.nls.json',
  'package.nls.zh-tw.json',
  'l10n/bundle.l10n.json',
  'l10n/bundle.l10n.zh-tw.json',
  'README.md',
  'README.zh-TW.md',
  'CHANGELOG.md',
  'LICENSE',
  '.vscodeignore',
  'assets/icon.svg',
  'tsconfig.json',
  'esbuild.mjs',
  '.vscode/launch.json',
];

for (const relative of requiredPaths) {
  if (!fs.existsSync(path.join(root, relative))) {
    errors.push(`缺少必要檔案：${relative}`);
  }
}

const pkg = readJson('package.json');
if (!pkg) {
  errors.push('package.json 無法解析');
} else {
  if (!pkg.engines?.vscode) {
    errors.push('package.json 缺少 engines.vscode');
  }
  if (!pkg.main) {
    errors.push('package.json 缺少 main 進入點');
  }
  if (!pkg.publisher) {
    errors.push('package.json 缺少 publisher（Marketplace 發布必要）');
  }
  if (!pkg.capabilities?.untrustedWorkspaces) {
    errors.push('package.json 缺少 capabilities.untrustedWorkspaces 宣告');
  }
  if (!pkg.l10n) {
    errors.push('package.json 缺少 l10n 設定');
  }
  if (!Array.isArray(pkg.contributes?.commands) || pkg.contributes.commands.length === 0) {
    errors.push('package.json contributes.commands 為空');
  }

  const engines = String(pkg.engines?.vscode ?? '').replace(/^[\^~]/, '');
  const types = String(pkg.devDependencies?.['@types/vscode'] ?? '').replace(/^[\^~]/, '');
  const enginesMinor = engines.split('.').slice(0, 2).join('.');
  const typesMinor = types.split('.').slice(0, 2).join('.');
  if (engines && types && enginesMinor !== typesMinor) {
    errors.push(`engines.vscode (${pkg.engines.vscode}) 與 @types/vscode (${pkg.devDependencies['@types/vscode']}) 不一致`);
  }

  const nls = readJson('package.nls.json') ?? {};
  const nlsZh = readJson('package.nls.zh-tw.json') ?? {};
  const missing = Object.keys(nls).filter((key) => !(key in nlsZh));
  const extra = Object.keys(nlsZh).filter((key) => !(key in nls));
  if (missing.length) {
    errors.push(`package.nls.zh-tw.json 缺少 ${missing.length} 個 key：${missing.slice(0, 5).join(', ')}`);
  }
  if (extra.length) {
    errors.push(`package.nls.zh-tw.json 有 ${extra.length} 個多餘 key：${extra.slice(0, 5).join(', ')}`);
  }

  const bundle = readJson('l10n/bundle.l10n.json') ?? {};
  const bundleZh = readJson('l10n/bundle.l10n.zh-tw.json') ?? {};
  const bundleMissing = Object.keys(bundle).filter((key) => !(key in bundleZh));
  if (bundleMissing.length) {
    errors.push(`l10n/bundle.l10n.zh-tw.json 缺少 ${bundleMissing.length} 個訊息`);
  }

  if (!fs.existsSync(path.join(root, 'dist', 'extension.js'))) {
    warnings.push('尚未建置：dist/extension.js 不存在（執行 npm run build）');
  }
  if (!pkg.icon) {
    warnings.push('package.json 尚未設定 icon（Marketplace 需要 ≥128×128 PNG）');
  }
  if (!pkg.repository) {
    warnings.push('package.json 尚未設定 repository');
  }
}

const mode = errors.length ? 'FAIL' : warnings.length ? 'PASS (warnings)' : 'PASS';
console.log(`[check-project] ${mode} — ${root}`);
for (const error of errors) console.log(`  ❌ ${error}`);
for (const warning of warnings) console.log(`  ⚠️  ${warning}`);
if (!errors.length && !warnings.length) console.log('  ✅ 所有檢查通過');
process.exitCode = errors.length ? 1 : 0;
