/**
 * S4.1R20（使用者需求）：讓 Folder Space 跟隨 VS Code 內建 Explorer 的隱藏規則。
 *
 * Explorer 實際使用的可見性規則（依 VS Code 官方行為整理）：
 * 1. **`files.exclude`**（物件，`pattern -> boolean`）：`true` 表示隱藏；預設值包含
 *    `.git`、`.svn`、`.hg`、`CVS`、`.DS_Store`、`Thumbs.db` 的遞迴樣式。
 * 2. **`explorer.excludeGitIgnore`**（布林，預設 false）：開啟時，被 `.gitignore` 忽略的
 *    檔案／資料夾也一併隱藏。此規則需讀取 `.gitignore` 並套用 git 的忽略語意。
 *
 * 本模組只做**純邏輯**（零 `vscode` 相依）：接收已解析的規則，回傳是否應隱藏。
 * 讀取設定與 `.gitignore` 檔案的 I/O 由呼叫端（provider／extension）負責。
 */

/** `files.exclude` 的正規化形式：pattern → 是否隱藏（只保留 true）。 */
export type ExcludePatterns = readonly string[];

/** 一組已解析的 `.gitignore` 規則。 */
export interface GitIgnoreRule {
  /** 原始樣式（已去除前後空白與註解）。 */
  pattern: string;
  /** 以 `!` 開頭的否定規則。 */
  negated: boolean;
  /** 以 `/` 結尾：只匹配目錄。 */
  directoryOnly: boolean;
  /** 以 `/` 開頭（或含中間 `/`）：相對於 gitignore 所在目錄的完整路徑。 */
  anchored: boolean;
}

/** 把 `files.exclude` 設定物件轉為只含 `true` 的樣式清單（保持宣告順序）。 */
export function normalizeExcludeSetting(value: unknown): ExcludePatterns {
  if (!value || typeof value !== 'object') return [];
  const patterns: string[] = [];
  for (const [pattern, enabled] of Object.entries(value as Record<string, unknown>)) {
    // VS Code 只隱藏值為 true 的項目；false 表示「明確不隱藏」（可用來覆寫預設）。
    if (enabled === true && typeof pattern === 'string' && pattern.length > 0) patterns.push(pattern);
  }
  return patterns;
}

/**
 * 解析 `.gitignore` 文字為規則清單。
 * 支援：註解（`#`）、空行、否定（`!`）、目錄限定（尾端 `/`）、錨定（開頭 `/` 或含中間 `/`）。
 * 不支援：`**` 之外的進階語法（與 git 的完整語意有細微差異，見 `matchesGitIgnoreRule`）。
 */
export function parseGitIgnore(text: string): GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // git 只跳過「行首」的空白；此處簡化為 trim，對常見 .gitignore 足夠。
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith('!')) { negated = true; pattern = pattern.slice(1); }
    if (!pattern) continue;
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    if (!pattern) continue;
    rules.push({ pattern, negated, directoryOnly, anchored });
  }
  return rules;
}

/**
 * 判斷 `relativePath`（相對於 gitignore 所在目錄、以 `/` 分隔、無前導斜線）
 * 是否被單一 gitignore 規則匹配。
 *
 * 語意對齊 git 的常見情形：
 * - 未錨定的樣式匹配**任一層**的同名項目（`node_modules/` 與遞迴形式等效）。
 * - 錨定樣式只相對於規則所在目錄。
 * - 雙星可跨目錄。
 */
export function matchesGitIgnoreRule(rule: GitIgnoreRule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  const path = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = path.split('/').filter(Boolean);
  const regex = gitIgnorePatternToRegExp(rule.pattern);
  if (rule.anchored) {
    return regex.test(path);
  }
  // 未錨定：逐層後綴比對（含完整路徑本身）
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    if (regex.test(candidate)) return true;
  }
  return false;
}

/** 把單一 gitignore 樣式（已去除 `!`／前導 `/`／尾端 `/`）轉為 RegExp。 */
function gitIgnorePatternToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // 雙星加斜線可匹配零或多層；單獨雙星可跨任意路徑
        if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 2; }
        else { source += '.*'; index += 1; }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

/**
 * 判斷項目是否應被「Explorer 等價規則」隱藏。
 * 套用順序：`files.exclude` 先，`gitignore` 後；任一命中即隱藏（gitignore 的 `!` 可解除
 * **同一份 gitignore 內**先前規則的隱藏，但不會解除 `files.exclude`——與 VS Code 行為一致）。
 */
export function shouldHideLikeExplorer(
  relativePath: string,
  isDirectory: boolean,
  excludePatterns: ExcludePatterns,
  gitIgnoreRules: readonly GitIgnoreRule[],
  matchesExclude: (pattern: string, relativePath: string, name: string, isDirectory: boolean) => boolean,
): boolean {
  const name = relativePath.split('/').filter(Boolean).pop() ?? relativePath;
  for (const pattern of excludePatterns) {
    if (matchesExclude(pattern, relativePath, name, isDirectory)) return true;
  }
  if (!gitIgnoreRules.length) return false;
  // gitignore：後面的規則覆寫前面的規則（含 `!` 否定）
  let hidden = false;
  for (const rule of gitIgnoreRules) {
    if (!matchesGitIgnoreRule(rule, relativePath, isDirectory)) continue;
    hidden = !rule.negated;
  }
  return hidden;
}
