#!/usr/bin/env node
/**
 * Folder Spaces 專案健康度檢查（zero-dependency，Node 20+）。
 *
 * 檢查必要檔案、manifest 契約（engines.vscode／main／publisher／capabilities／
 * @types/vscode 對齊）、i18n bundle 對稱及 src 中 l10n 訊息 key 覆蓋與打包進入點。
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

const listTypeScriptFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name);
  return entry.isDirectory() ? listTypeScriptFiles(fullPath) : entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
});

const decodeStringLiteral = (literal) => {
  if (literal.startsWith('`')) return literal.slice(1, -1);
  if (literal.startsWith('"')) return JSON.parse(literal);
  const body = literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '\\"');
  return JSON.parse(`"${body.replace(/\\/g, '\\\\').replace(/\\\\'/g, "'").replace(/"/g, '\\"')}"`);
};

// Parse a static string or a chain of adjacent string literals; dynamic expressions are intentionally unsupported.
const parseLiteralConcatenation = (expression) => {
  const tokenPattern = /\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[()+]))/gy;
  const meaningful = [];
  let cursor = 0;
  while (cursor < expression.length) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(expression);
    if (!match) return null;
    cursor = tokenPattern.lastIndex;
    const token = match[0].trim();
    if (token && !token.startsWith('//') && !token.startsWith('/*')) meaningful.push(token);
  }
  let index = 0;
  const primary = () => {
    if (meaningful[index] === '(') {
      index += 1;
      const value = sum();
      if (meaningful[index++] !== ')') throw new Error('unclosed parenthesis');
      return value;
    }
    const token = meaningful[index++];
    if (!token || !/^['"`]/.test(token) || (token.startsWith('`') && token.includes('${'))) throw new Error('not a static string');
    return decodeStringLiteral(token);
  };
  const sum = () => {
    let value = primary();
    while (meaningful[index] === '+') { index += 1; value += primary(); }
    return value;
  };
  try {
    const value = sum();
    return index === meaningful.length ? value : null;
  } catch { return null; }
};

const scanL10nMessages = (file, source) => {
  const messages = [];
  const call = /vscode\.l10n\.t\s*\(/g;
  let match;
  while ((match = call.exec(source))) {
    const start = call.lastIndex;
    let quote = '';
    let escaped = false;
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i += 1) {
      const character = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'" || character === '`') quote = character;
      else if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) { end = i; break; }
        depth -= 1;
      } else if (character === ',' && depth === 0) { end = i; break; }
    }
    const line = source.slice(0, match.index).split('\n').length;
    const message = end < 0 ? null : parseLiteralConcatenation(source.slice(start, end));
    if (message === null) warnings.push(`無法解析 l10n 訊息：${path.relative(root, file)}:${line}`);
    else messages.push({ file: path.relative(root, file), line, message });
  }
  return messages;
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
  '.vscode-test.mjs',
  'esbuild.tests.mjs',
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
  if (!pkg.scripts?.['test:integration']) {
    errors.push('package.json scripts 缺少 test:integration');
  }
  if (!pkg.scripts?.['build:tests']) {
    errors.push('package.json scripts 缺少 build:tests');
  }
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

  const vscodeignore = fs.existsSync(path.join(root, '.vscodeignore'))
    ? fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/).map((line) => line.trim())
    : [];
  if (!['out', 'out/', '/out/'].some((entry) => vscodeignore.includes(entry))) {
    errors.push('.vscodeignore 缺少 out 忽略規則，避免 VSIX 打包測試 bundle');
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

  for (const file of listTypeScriptFiles(path.join(root, 'src'))) {
    for (const { file: relative, line, message } of scanL10nMessages(file, fs.readFileSync(file, 'utf8'))) {
      if (!(message in bundle)) errors.push(`l10n/bundle.l10n.json 缺少 key：${relative}:${line} — ${message.slice(0, 100)}`);
    }
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
