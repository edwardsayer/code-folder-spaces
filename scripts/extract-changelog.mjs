// 從 CHANGELOG.md 擷取特定版本的更新說明
// 用法：node scripts/extract-changelog.mjs [tag-or-version]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');

if (!fs.existsSync(changelogPath)) {
  console.error(`Error: CHANGELOG.md not found at ${changelogPath}`);
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, 'utf8');
const rawArg = process.argv[2]?.trim() || '';
const version = rawArg.replace(/^v/, '');

function extractChangelog(ver) {
  if (!ver) {
    const firstSection = /## \[[^\]]+\][^\n]*\n([\s\S]*?)(?=\n## \[|\n## [^#]|$)/.exec(changelog);
    return firstSection ? firstSection[1].trim() : '';
  }

  const escaped = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`## \\['?v?${escaped}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|\\n## [^#]|$)`);
  const match = pattern.exec(changelog);
  return match ? match[1].trim() : '';
}

const result = extractChangelog(version);

if (result) {
  console.log(result);
} else {
  console.log(`Release ${rawArg || 'latest'}`);
}
