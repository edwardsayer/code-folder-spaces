import * as path from 'node:path';
import { globToRegExp } from './spaceConfig';

/**
 * Pure file-nesting logic for F-42 (see `dev/specs/file-nesting-design.md` §4).
 * Mirrors the built-in Explorer semantics: parent pattern holds exactly one
 * `*` (D54 single-parent assignment); this module has no `vscode` dependency.
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

/**
 * Normalizes raw `explorer.fileNesting.patterns` into rules: parent patterns
 * without exactly one `*` are skipped whole; child values are split on commas,
 * trimmed, empty items dropped, duplicates removed. Declaration order is kept.
 */
export function parseNestingPatterns(patterns: Readonly<Record<string, string>> | undefined): FileNestingRule[] {
  if (!patterns || typeof patterns !== 'object') {
    return [];
  }
  const rules: FileNestingRule[] = [];
  for (const [parentPattern, value] of Object.entries(patterns)) {
    if (typeof value !== 'string') {
      continue;
    }
    // Exactly one `*` (spec §4 rule 1); zero or multiple stars → rule invalid.
    if (parentPattern.split('*').length !== 2) {
      continue;
    }
    const childPatterns = [...new Set(
      value.split(',').map(pattern => pattern.trim()).filter(pattern => pattern.length > 0)
    )];
    rules.push({ parentPattern, childPatterns });
  }
  return rules;
}

/**
 * Compiles a validated single-`*` parent pattern into a capture regex, reusing
 * `globToRegExp` translation semantics for the literal segments around the `*`.
 */
function compileParentPattern(parentPattern: string): RegExp | undefined {
  const parts = parentPattern.split('*');
  if (parts.length !== 2) {
    return undefined;
  }
  const anchors = (segment: string): string => globToRegExp(segment).source.slice(1, -1);
  return new RegExp(`^${anchors(parts[0] ?? '')}([^/]*)${anchors(parts[1] ?? '')}$`);
}

function expandVariables(pattern: string, variables: NestingVariables): string {
  return pattern.replace(VARIABLE_TOKEN, (_match, name: keyof NestingVariables) => variables[name] ?? '');
}

/**
 * Assigns same-level file names to nesting parents (spec §4 rules 2–7).
 * Deterministic: rules iterate in declaration order, parents in `fileNames`
 * order, first matching parent wins (D54); an assignment that would create a
 * cycle is skipped so the result stays finite and each file keeps ≤1 parent.
 * On case-insensitive platforms callers pass `caseInsensitive = true` and both
 * pattern and candidate names are lower-cased before compiling/matching.
 */
export function assignNestedChildren(
  fileNames: readonly string[],
  directoryName: string,
  rules: readonly FileNestingRule[],
  caseInsensitive: boolean
): NestingAssignment {
  const normalize = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const childrenOf = new Map<string, string[]>();
  // child → parent chain record: also marks names already claimed (single parent, D54).
  const parentOf = new Map<string, string>();

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
      const parsed = path.parse(parentName);
      const variables: NestingVariables = {
        capture: match[1] ?? '',
        basename: parsed.name,
        extname: parsed.ext,
        dirname: directoryName,
      };
      for (const childPattern of rule.childPatterns) {
        // A child pattern that expands to an empty string is invalid (e.g. `${capture}` with no capture).
        const expanded = expandVariables(childPattern, variables);
        if (!expanded) {
          continue;
        }
        const childMatcher = globToRegExp(normalize(expanded));
        for (const childName of fileNames) {
          if (childName === parentName || parentOf.has(childName) || !childMatcher.test(normalize(childName))) {
            continue;
          }
          // Cycle truncation: refuse to nest a name that is already an ancestor of the parent.
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
