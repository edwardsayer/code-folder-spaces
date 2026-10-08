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

// fromPath 模式不校驗 engines 最低版本；正式版本矩陣留待 S5 CI。
console.log(fromPath
  ? `[vscode-test] 使用本機 VS Code：${fromPath}`
  : `[vscode-test] 使用 test-electron 下載 VS Code：${process.env.VSCODE_TEST_VERSION ?? 'stable'}`);

export default {
  tests: [{
    label: 'desktop',
    files: './out/integration/suite/**/*.test.js',
    workspaceFolder: path.resolve(root, './tests/integration/fixtures/workspace'),
    extensionDevelopmentPath: root,
    ...(fromPath
      ? { useInstallation: { fromPath } }
      : { version: process.env.VSCODE_TEST_VERSION ?? 'stable' }),
    mocha: { timeout: 60000, color: true },
  }],
};
