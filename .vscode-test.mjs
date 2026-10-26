import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const candidates = process.platform === 'win32'
  ? [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
      'C:/Program Files/Microsoft VS Code/Code.exe',
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
    : ['/usr/share/code/code', '/usr/bin/code', '/snap/bin/code'];
const fromPath = [process.env.VSCODE_EXE, ...candidates].find((candidate) => candidate && fs.existsSync(candidate));

// 明確指定 VSCODE_TEST_VERSION 時一律以下載版本為準（CI 的版本矩陣靠這個）。
// 否則本機安裝會静默地蓋掉指定版本，讓「測 1.85.1」實際上測到本機的 1.14x。
const requestedVersion = process.env.VSCODE_TEST_VERSION?.trim();
const useLocalInstall = Boolean(fromPath) && !requestedVersion;

// VS Code 會將工作區設定寫回並正規化格式；為避免每次執行都弄髒 committed fixture（並觸發
// trust.test.ts 的汙染守門），改用專案內被 gitignore 的暫存複本作為 workspaceFolder。
const fixtureSource = path.resolve(root, './tests/integration/fixtures/workspace');
const workspaceCopy = path.resolve(root, './.vscode-test/workspace-copy');
fs.rmSync(workspaceCopy, { recursive: true, force: true });
fs.cpSync(fixtureSource, workspaceCopy, { recursive: true });
fs.mkdirSync(path.join(workspaceCopy, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(workspaceCopy, '.vscode', 'settings.json'), '{}\n');

// fromPath 模式不校驗 engines 最低版本；要驗宣告的支援下限請設 VSCODE_TEST_VERSION。
console.log(useLocalInstall
  ? `[vscode-test] 使用本機 VS Code：${fromPath}`
  : `[vscode-test] 使用 test-electron 下載 VS Code：${requestedVersion ?? 'stable'}`);

// v21-R4：global roots 只存標準 user settings；舊的自訂檔只剩「一次性遷移」。
// 整合測試把遷移來源導到不存在的暫存路徑，確保不會讀到使用者真實檔案。
const legacyGlobalRootsFile = path.resolve(root, './.vscode-test/legacy-global-roots.json');
fs.rmSync(legacyGlobalRootsFile, { force: true });
process.env.CODEFOLDERSPACES_LEGACY_GLOBAL_ROOTS = legacyGlobalRootsFile;

export default {
  tests: [{
    label: 'desktop',
    files: './out/integration/suite/**/*.test.js',
    workspaceFolder: workspaceCopy,
    extensionDevelopmentPath: root,
    ...(useLocalInstall
      ? { useInstallation: { fromPath } }
      : { version: requestedVersion ?? 'stable' }),
    mocha: { timeout: 60000, color: true },
    env: { ...process.env, CODEFOLDERSPACES_LEGACY_GLOBAL_ROOTS: legacyGlobalRootsFile },
  }],
};
