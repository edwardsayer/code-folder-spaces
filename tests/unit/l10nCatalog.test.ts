import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const fixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-spaces-l10n-'));
  roots.push(root);
  // 建立最小產品結構，實際執行正式 checker，不在測試複製其驗證邏輯。
  const files = ['src/extension.ts', 'README.md', 'README.zh-TW.md', 'CHANGELOG.md', 'LICENSE',
    'assets/icon.svg', 'tsconfig.json', 'esbuild.mjs', '.vscode-test.mjs', 'esbuild.tests.mjs', '.vscode/launch.json'];
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.resolve('scripts/check-project.mjs'), path.join(root, 'scripts/check-project.mjs'));
  fs.writeFileSync(path.join(root, '.vscodeignore'), 'out/\n');
  const pkg = {
    scripts: { 'test:integration': 'test', 'build:tests': 'build' },
    engines: { vscode: '^1.85.0' }, devDependencies: { '@types/vscode': '^1.85.0' },
    main: './dist/extension.js', publisher: 'test', l10n: './l10n',
    capabilities: { untrustedWorkspaces: { supported: 'limited' } },
    contributes: { commands: [{ command: 'test.command', title: '%command.title%' }] },
  };
  writeJson(root, 'package.json', pkg);
  writeJson(root, 'package.nls.json', { 'command.title': 'Command' });
  writeJson(root, 'package.nls.zh-tw.json', { 'command.title': '命令' });
  writeJson(root, 'l10n/bundle.l10n.json', { 'Moving {0} to {1}': 'Moving {0} to {1}' });
  writeJson(root, 'l10n/bundle.l10n.zh-tw.json', { 'Moving {0} to {1}': '將 {0} 移至 {1}' });
  return root;
};
function writeJson(root: string, file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));
}
function check(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-project.mjs')], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}
afterEach(() => {
  // 只清理測試自行建立的實體暫存目錄，沒有 symlink／profile。
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('l10n catalog checker', () => {
  it('accepts symmetric catalogs and reordered placeholders', () => {
    const root = fixture();
    writeJson(root, 'l10n/bundle.l10n.zh-tw.json', { 'Moving {0} to {1}': '目的地 {1}，來源 {0}' });
    expect(check(root).status).toBe(0);
  });
  it('rejects extra translated bundle keys', () => {
    const root = fixture();
    writeJson(root, 'l10n/bundle.l10n.zh-tw.json', { 'Moving {0} to {1}': '{0} → {1}', extra: '多餘' });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('多餘 key');
  });
  // S6R4（R6）：語系 catalog 改為自動列舉，新增語系（zh-cn）也必須被同一套對稱與 placeholder 檢查涵蓋。
  it('checks every discovered locale, not just zh-tw', () => {
    const root = fixture();
    writeJson(root, 'package.nls.zh-cn.json', { 'command.title': '命令' });
    writeJson(root, 'l10n/bundle.l10n.zh-cn.json', { 'Moving {0} to {1}': '将 {2} 移动' });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('l10n/bundle.l10n.zh-cn.json placeholder 不一致');
  });
  it('rejects a locale catalog that misses keys', () => {
    const root = fixture();
    writeJson(root, 'package.nls.zh-cn.json', {});
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('package.nls.zh-cn.json 缺少 1 個 key');
  });
  it('rejects missing translated messages', () => {
    const root = fixture();
    writeJson(root, 'l10n/bundle.l10n.zh-tw.json', {});
    expect(check(root).status).toBe(1);
  });
  it('rejects changed placeholders and empty translations', () => {
    const root = fixture();
    writeJson(root, 'l10n/bundle.l10n.zh-tw.json', { 'Moving {0} to {1}': '移至 {2}' });
    expect(check(root).output).toContain('placeholder 不一致');
    writeJson(root, 'l10n/bundle.l10n.zh-tw.json', { 'Moving {0} to {1}': '' });
    expect(check(root).status).toBe(1);
  });
  it('rejects manifest references absent from the English catalog', () => {
    const root = fixture();
    writeJson(root, 'package.nls.json', {});
    writeJson(root, 'package.nls.zh-tw.json', {});
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('manifest 引用 key');
  });
});
