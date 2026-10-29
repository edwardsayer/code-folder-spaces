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
  // tooling/R2 TH-01：locale 名稱格式（避免 zh_TW 這種底線寫法被靜默忽略）。
  it('rejects a locale name that is not BCP 47 shaped', () => {
    const root = fixture();
    writeJson(root, 'package.nls.zh_TW.json', { 'command.title': '命令' });
    writeJson(root, 'l10n/bundle.l10n.zh_TW.json', { 'Moving {0} to {1}': '{0} → {1}' });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('locale 名稱格式不合法');
  });
  it('warns about upper-case locales without failing', () => {
    const root = fixture();
    writeJson(root, 'package.nls.zh-CN.json', { 'command.title': '命令' });
    writeJson(root, 'l10n/bundle.l10n.zh-CN.json', { 'Moving {0} to {1}': '{0} → {1}' });
    const result = check(root);
    expect(result.output).toContain('locale 名稱含大寫字母');
    // 大寫只是建議：不得因此讓檢查失敗（成對比對已用小寫正規化）。
    expect(result.status).toBe(0);
  });
  // tooling/R2 TH-01：兩類 catalog 的語系集合必須成對（只有一邊等於該語系半套）。
  it('rejects a locale that only has a manifest catalog', () => {
    const root = fixture();
    writeJson(root, 'package.nls.ja.json', { 'command.title': 'コマンド' });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('package.nls.<locale>.json 但缺少 l10n/bundle.l10n.<locale>.json：ja');
  });
  it('rejects a locale that only has a runtime catalog', () => {
    const root = fixture();
    writeJson(root, 'l10n/bundle.l10n.ko.json', { 'Moving {0} to {1}': '{0} → {1}' });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('l10n/bundle.l10n.<locale>.json 但缺少 package.nls.<locale>.json：ko');
  });
  // tooling/R2 TH-02：l10n/ 缺目錄要走錯誤彙整，不得變成未捕捉例外。
  it('reports a missing l10n directory instead of crashing', () => {
    const root = fixture();
    fs.rmSync(path.join(root, 'l10n'), { recursive: true, force: true });
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain('[check-project] FAIL');
    expect(result.output).toContain('找不到 l10n/ 目錄');
    expect(result.output).not.toContain('ENOENT');
    expect(result.output).not.toContain('readdirSync');
  });
});
