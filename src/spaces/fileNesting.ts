import * as path from 'node:path';
import { globToRegExp } from './spaceConfig';

/**
 * Pure file-nesting logic for F-42 (see `dev/specs/file-nesting-design.md` §4).
 * Mirrors the built-in Explorer semantics: a parent pattern holds zero or one
 * `*` (D54 single-parent assignment, D57 exact-name parents); this module has
 * no `vscode` dependency.
 */
export interface FileNestingRule {
  readonly parentPattern: string;
  readonly childPatterns: readonly string[];
}

/** Parent file name → direct child file names (in rule declaration order). */
export interface NestingAssignment {
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** File names assigned as children somewhere; they must be hidden from the same level. */
  readonly nestedNames: ReadonlySet<string>;
}

/** Variables available in child patterns (`$(x)` and `${x}` both spellings). */
interface NestingVariables {
  readonly capture: string;
  readonly basename: string;
  readonly extname: string;
  readonly dirname: string;
}

/** Tokenizer identical to the built-in Explorer one: `\$[({](capture|basename|dirname|extname)[)}]`. */
const VARIABLE_TOKEN = /\$[({](capture|basename|dirname|extname)[)}]/g;

/** Detects a `${capture}`/`$(capture)` reference; such patterns need a wildcard parent. */
const CAPTURE_TOKEN = /\$[({]capture[)}]/;

/**
 * Normalizes raw `explorer.fileNesting.patterns` into rules.
 *
 * Parent keys are trimmed; keys with more than one `*` are skipped whole
 * (unsupported), while keys with zero or one `*` are kept (the built-in defaults
 * include exact-name parents such as `package.json`). Child values are split on
 * commas, trimmed, empty items dropped and duplicates removed. Declaration order
 * is preserved because it decides the winning parent (D54).
 */
export function parseNestingPatterns(patterns: Readonly<Record<string, string>> | undefined): FileNestingRule[] {
  if (!patterns || typeof patterns !== 'object') {
    return [];
  }
  const rules: FileNestingRule[] = [];
  for (const [rawParentPattern, value] of Object.entries(patterns)) {
    if (typeof value !== 'string') {
      continue;
    }
    const parentPattern = rawParentPattern.trim();
    if (parentPattern.length === 0) {
      continue;
    }
    // Zero stars = exact file name; one star = single capture; two or more = unsupported.
    if ((parentPattern.match(/\*/g) ?? []).length > 1) {
      continue;
    }
    const childPatterns = [...new Set(
      value.split(',').map(pattern => pattern.trim()).filter(pattern => pattern.length > 0)
    )];
    rules.push({ parentPattern, childPatterns });
  }
  return rules;
}

/** Translates a literal pattern segment via `globToRegExp`, dropping its anchors. */
function segmentSource(segment: string): string {
  return globToRegExp(segment).source.slice(1, -1);
}

/**
 * Compiles a validated parent pattern into a match regex. A pattern without `*`
 * matches the exact file name and has no capture group; a pattern with one `*`
 * exposes the wildcard match as group 1.
 */
function compileParentPattern(parentPattern: string): RegExp | undefined {
  const parts = parentPattern.split('*');
  if (parts.length === 1) {
    return new RegExp(`^${segmentSource(parentPattern)}$`);
  }
  if (parts.length !== 2) {
    return undefined;
  }
  return new RegExp(`^${segmentSource(parts[0] ?? '')}([^/]*)${segmentSource(parts[1] ?? '')}$`);
}

function expandVariables(pattern: string, variables: NestingVariables): string {
  return pattern.replace(VARIABLE_TOKEN, (_match, name: keyof NestingVariables) => variables[name] ?? '');
}

/**
 * Assigns same-level file names to nesting parents (spec §4 rules 2–7).
 * Deterministic: rules iterate in declaration order, parents in `fileNames`
 * order, first matching parent wins (D54); an assignment that would create a
 * cycle is skipped so the result stays finite and each file keeps ≤1 parent.
 * Child patterns that rely on `${capture}` are ignored for parents without a
 * wildcard (nothing to capture). On case-insensitive platforms callers pass
 * `caseInsensitive = true` and both pattern and candidate names are lower-cased
 * before compiling/matching.
 */
export function assignNestedChildren(
  fileNames: readonly string[],
  directoryName: string,
  rules: readonly FileNestingRule[],
  caseInsensitive: boolean
): NestingAssignment {
  const normalize = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const childrenOf = new Map<string, string[]>();
  // child → parent record: also marks names already claimed (single parent, D54).
  const parentOf = new Map<string, string>();
  // Compiled child matchers are reused across parents within this call (F-05).
  const childMatchers = new Map<string, RegExp>();

  const matcherFor = (pattern: string): RegExp => {
    const key = normalize(pattern);
    const cached = childMatchers.get(key);
    if (cached) {
      return cached;
    }
    const compiled = globToRegExp(key);
    childMatchers.set(key, compiled);
    return compiled;
  };

  for (const rule of rules) {
    // caseInsensitive 時模式與候選檔名一併轉小寫後再編譯（spec §4 規則 7）。
    const parentMatcher = compileParentPattern(normalize(rule.parentPattern));
    if (!parentMatcher || rule.childPatterns.length === 0) {
      continue;
    }
    for (const parentName of fileNames) {
      const match = parentMatcher.exec(normalize(parentName));
      if (!match) {
        continue;
      }
      // Group 1 exists only when the parent pattern contains a `*`.
      const hasCapture = match.length > 1;
      const parsed = path.parse(parentName);
      const variables: NestingVariables = {
        capture: match[1] ?? '',
        basename: parsed.name,
        // 上游 `getAttributes` 的 extname 不含前導點（`ts`，非 `.ts`）。
        extname: parsed.ext.replace(/^\./, ''),
        dirname: directoryName,
      };
      for (const childPattern of rule.childPatterns) {
        if (!hasCapture && CAPTURE_TOKEN.test(childPattern)) {
          continue;
        }
        // A child pattern that expands to an empty string is invalid (e.g. `${capture}` with no capture).
        const expanded = expandVariables(childPattern, variables);
        if (!expanded) {
          continue;
        }
        const childMatcher = matcherFor(expanded);
        for (const childName of fileNames) {
          if (parentOf.has(childName) || !childMatcher.test(normalize(childName))) {
            continue;
          }
          // Cycle truncation: refuse to nest a name that is already an ancestor of the parent
          // (this also covers the degenerate parent-as-its-own-child case).
          let blocksCycle: string | undefined = parentName;
          let isAncestor = false;
          while (blocksCycle !== undefined) {
            if (blocksCycle === childName) {
              isAncestor = true;
              break;
            }
            blocksCycle = parentOf.get(blocksCycle);
          }
          if (isAncestor) {
            continue;
          }
          parentOf.set(childName, parentName);
          const list = childrenOf.get(parentName);
          if (list) {
            list.push(childName);
          } else {
            childrenOf.set(parentName, [childName]);
          }
        }
      }
    }
  }

  return { childrenOf, nestedNames: new Set(parentOf.keys()) };
}
