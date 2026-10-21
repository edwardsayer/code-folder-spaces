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

// VS Code 會將工作區設定寫回並正規化格式；為避免每次執行都弄髒 committed fixture（並觸發
// trust.test.ts 的汙染守門），改用專案內被 gitignore 的暫存複本作為 workspaceFolder。
const fixtureSource = path.resolve(root, './tests/integration/fixtures/workspace');
const workspaceCopy = path.resolve(root, './.vscode-test/workspace-copy');
fs.rmSync(workspaceCopy, { recursive: true, force: true });
fs.cpSync(fixtureSource, workspaceCopy, { recursive: true });
fs.mkdirSync(path.join(workspaceCopy, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(workspaceCopy, '.vscode', 'settings.json'), '{}\n');

// fromPath 模式不校驗 engines 最低版本；正式版本矩陣留待 S5 CI。
console.log(fromPath
  ? `[vscode-test] 使用本機 VS Code：${fromPath}`
  : `[vscode-test] 使用 test-electron 下載 VS Code：${process.env.VSCODE_TEST_VERSION ?? 'stable'}`);

// v21-R2：global roots 改存使用者層級檔案（預設 ~/.code-folder-spaces/global-roots.json）。
// 整合測試以環境變數把它導到暫存路徑，避免污染使用者真實設定，也避免跨次執行殘留。
const userGlobalRootsFile = path.resolve(root, './.vscode-test/global-roots.json');
fs.rmSync(userGlobalRootsFile, { force: true });
process.env.CODEFOLDERSPACES_GLOBAL_ROOTS_FILE = userGlobalRootsFile;

export default {
  tests: [{
    label: 'desktop',
    files: './out/integration/suite/**/*.test.js',
    workspaceFolder: workspaceCopy,
    extensionDevelopmentPath: root,
    ...(fromPath
      ? { useInstallation: { fromPath } }
      : { version: process.env.VSCODE_TEST_VERSION ?? 'stable' }),
    mocha: { timeout: 60000, color: true },
    env: { ...process.env, CODEFOLDERSPACES_GLOBAL_ROOTS_FILE: userGlobalRootsFile },
  }],
};
