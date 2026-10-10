import { describe, expect, it } from 'vitest';
import { assignNestedChildren, parseNestingPatterns } from '../../src/spaces/fileNesting';

const rulesOf = (patterns: Record<string, string>) => parseNestingPatterns(patterns);

describe('parseNestingPatterns', () => {
  it('FN-U6/FN-U9: keeps exact-name parents, skips multi-star/blank keys and trims keys', () => {
    const rules = rulesOf({
      'README.md': '${basename}.txt',          // no star → kept (D57)
      '*.ts': '${capture}.js',                 // valid
      '*a*b*': 'x',                            // multiple stars → skipped
      '': 'y',                                 // empty parent → skipped
      '  package.json  ': 'package-lock.json', // trimmed (F-03)
    });
    expect(rules).toEqual([
      { parentPattern: 'README.md', childPatterns: ['${basename}.txt'] },
      { parentPattern: '*.ts', childPatterns: ['${capture}.js'] },
      { parentPattern: 'package.json', childPatterns: ['package-lock.json'] },
    ]);
  });

  it('FN-U8: splits values on commas, trims, drops empty items and dedupes', () => {
    const rules = rulesOf({ '*.ts': ' a.js, , b.js ,,a.js ' });
    expect(rules[0].childPatterns).toEqual(['a.js', 'b.js']);
  });

  it('returns an empty list for missing or invalid input', () => {
    expect(parseNestingPatterns(undefined)).toEqual([]);
    expect(parseNestingPatterns({})).toEqual([]);
  });
});

describe('assignNestedChildren', () => {
  it('FN-U1: nests ${capture} children under the existing parent', () => {
    const rules = rulesOf({ '*.ts': '${capture}.js, ${capture}.d.ts' });
    const result = assignNestedChildren(['a.ts', 'a.js', 'a.d.ts', 'b.md'], 'src', rules, false);
    expect(result.childrenOf.get('a.ts')).toEqual(['a.js', 'a.d.ts']);
    expect([...result.nestedNames].sort()).toEqual(['a.d.ts', 'a.js']);
    expect(result.nestedNames.has('b.md')).toBe(false);
  });

  it('FN-U2: expands $(x) and ${x} with capture/basename/extname/dirname', () => {
    const rules = rulesOf({ '*.ts': '$(capture).js, ${basename}.legacy.js, $(extname)-${dirname}.log' });
    // Parent a.d.ts → capture 'a.d', basename 'a.d', extname 'ts' (no leading dot, F-02), dirname 'docs'
    const result = assignNestedChildren(
      ['a.d.ts', 'a.d.js', 'a.d.legacy.js', 'ts-docs.log', 'other.ts'],
      'docs',
      rules,
      false
    );
    expect(result.childrenOf.get('a.d.ts')).toEqual(['a.d.js', 'a.d.legacy.js', 'ts-docs.log']);
    expect(result.childrenOf.has('other.ts')).toBe(false);
  });

  it('FN-U9: exact-name parents nest literal children and drop ${capture} patterns (D57)', () => {
    const rules = rulesOf({ 'package.json': 'package-lock.json, ${capture}.lock', 'tsconfig.json': 'tsconfig.base.json' });
    const result = assignNestedChildren(
      ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'other.json'],
      'root',
      rules,
      false
    );
    // ${capture}.lock 無捕獲 → 該子模式略過（不得展開成 `.lock`）。
    expect(result.childrenOf.get('package.json')).toEqual(['package-lock.json']);
    expect(result.childrenOf.get('tsconfig.json')).toEqual(['tsconfig.base.json']);
    expect([...result.nestedNames].sort()).toEqual(['package-lock.json', 'tsconfig.base.json']);
  });

  it('FN-U9: ${basename}/${extname} stay usable under exact-name parents', () => {
    const rules = rulesOf({ 'index.html': '${basename}.js, ${extname}.txt' });
    const result = assignNestedChildren(['index.html', 'index.js', 'html.txt'], 'src', rules, false);
    expect(result.childrenOf.get('index.html')).toEqual(['index.js', 'html.txt']);
  });

  it('FN-U3: keeps children at top level when the parent does not exist', () => {
    const rules = rulesOf({ '*.ts': '${capture}.js' });
    const result = assignNestedChildren(['a.js', 'notes.md'], 'src', rules, false);
    expect(result.childrenOf.size).toBe(0);
    expect(result.nestedNames.size).toBe(0);
  });

  it('FN-U4: first matching parent in declaration order wins (D54)', () => {
    // Both rules claim 'x.js'; the earlier-declared '*.md' rule's parent must win.
    const rules = rulesOf({ '*.md': 'x.js', '*.ts': 'x.js' });
    const result = assignNestedChildren(['x.ts', 'x.md', 'x.js'], 'src', rules, false);
    expect(result.childrenOf.get('x.md')).toEqual(['x.js']);
    expect(result.childrenOf.has('x.ts')).toBe(false);
    expect([...result.nestedNames]).toEqual(['x.js']);
    // Swapping declaration order swaps the winner.
    const flipped = rulesOf({ '*.ts': 'x.js', '*.md': 'x.js' });
    const second = assignNestedChildren(['x.ts', 'x.md', 'x.js'], 'src', flipped, false);
    expect(second.childrenOf.get('x.ts')).toEqual(['x.js']);
    expect(second.childrenOf.has('x.md')).toBe(false);
  });

  it('FN-U5: recursion nests through already-nested parents', () => {
    const rules = rulesOf({ '*.ts': '${capture}.js', '*.js': '${capture}.js.map' });
    const result = assignNestedChildren(['a.ts', 'a.js', 'a.js.map'], 'src', rules, false);
    expect(result.childrenOf.get('a.ts')).toEqual(['a.js']);
    expect(result.childrenOf.get('a.js')).toEqual(['a.js.map']);
    expect([...result.nestedNames].sort()).toEqual(['a.js', 'a.js.map']);
  });

  it('FN-U5: cycles terminate with a deterministic result', () => {
    // Rule 1 lets a.js claim b.js; rule 2 would nest a.js back under b.js — refused as a cycle.
    const rules = rulesOf({ 'a*.js': 'b.js', 'b*.js': 'a.js' });
    const forward = assignNestedChildren(['a.js', 'b.js'], 'src', rules, false);
    expect([...forward.childrenOf.keys()]).toEqual(['a.js']);
    expect(forward.childrenOf.get('a.js')).toEqual(['b.js']);
    expect([...forward.nestedNames]).toEqual(['b.js']);
    // Declaration order — not file order — decides which edge survives.
    const reversedRules = rulesOf({ 'b*.js': 'a.js', 'a*.js': 'b.js' });
    const reversed = assignNestedChildren(['b.js', 'a.js'], 'src', reversedRules, false);
    expect([...reversed.childrenOf.keys()]).toEqual(['b.js']);
    expect(reversed.childrenOf.get('b.js')).toEqual(['a.js']);
    expect([...reversed.nestedNames]).toEqual(['a.js']);
  });

  it('FN-U6: ${capture} without a capture makes the child pattern invalid', () => {
    // Parent with a star always captures; empty expansion is what gets skipped.
    const rules = rulesOf({ '*.ts': '${capture}' });
    // 'x.ts' captures 'x'; pattern 'x' would claim file 'x'.
    const result = assignNestedChildren(['.ts', 'other.md'], 'src', rules, false);
    // '.ts' captures '' → expansion is the empty string → child pattern skipped entirely.
    expect(result.nestedNames.size).toBe(0);
  });

  it('a parent never becomes its own child (covered by the cycle check)', () => {
    const rules = rulesOf({ '*.ts': '*.ts' });
    const result = assignNestedChildren(['a.ts', 'b.ts'], 'src', rules, false);
    // a.ts claims b.ts only if it matched; same-name self-reference must be excluded.
    expect(result.childrenOf.get('a.ts')).toEqual(['b.ts']);
    expect(result.childrenOf.has('b.ts')).toBe(false);
  });

  it('FN-U7: caseInsensitive folds both pattern and candidate names', () => {
    const rules = rulesOf({ '*.ts': '${capture}.js' });
    const insensitive = assignNestedChildren(['APP.TS', 'app.js'], 'src', rules, true);
    expect(insensitive.childrenOf.get('APP.TS')).toEqual(['app.js']);
    const sensitive = assignNestedChildren(['APP.TS', 'app.js'], 'src', rules, false);
    expect(sensitive.nestedNames.size).toBe(0);
    // Reverse case split also matches when insensitive.
    const swapped = assignNestedChildren(['app.ts', 'APP.JS'], 'src', rules, true);
    expect(swapped.childrenOf.get('app.ts')).toEqual(['APP.JS']);
  });

  it('missing children in fileNames are never assigned', () => {
    const rules = rulesOf({ '*.ts': '${capture}.js' });
    const result = assignNestedChildren(['a.ts'], 'src', rules, false);
    expect(result.childrenOf.size).toBe(0);
  });
});
