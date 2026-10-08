import { describe, expect, it } from 'vitest';
import { matchesPathFilter, sortEntries, StatCache } from '../../src/spaces/sortEntries';

describe('path filtering and sorting', () => {
  it('matches case-insensitive path substrings and preserves empty filters', () => {
    expect(matchesPathFilter('src/Alpha.ts', 'ALPHA')).toBe(true);
    expect(matchesPathFilter('src/Alpha.ts', 'lib')).toBe(false);
    expect(matchesPathFilter('src/Alpha.ts', '')).toBe(true);
  });

  it('sorts by mtime and uses name as a stable tie-break in either direction', async () => {
    const entries = [{ name: 'b', uri: 'b' }, { name: 'A', uri: 'A' }, { name: 'c', uri: 'c' }];
    const stat = async (entry: { uri: string }) => ({ mtime: entry.uri === 'c' ? 2 : 1, ctime: 0 });
    expect((await sortEntries(entries, 'mtime', 'asc', stat)).map(item => item.name)).toEqual(['A', 'b', 'c']);
    expect((await sortEntries(entries, 'mtime', 'desc', stat)).map(item => item.name)).toEqual(['c', 'A', 'b']);
  });

  it('bounds concurrent stat calls at sixteen', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({ name: String(index), uri: String(index) }));
    let active = 0;
    let maximum = 0;
    await sortEntries(entries, 'mtime', 'asc', async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { mtime: 1, ctime: 0 };
    });
    expect(maximum).toBeLessThanOrEqual(16);
    expect(maximum).toBeGreaterThan(1);
  });

  it('falls back from unavailable ctime to mtime and caches stat promises by URI', async () => {
    const entries = [{ name: 'b', uri: 'same' }, { name: 'a', uri: 'same' }];
    let calls = 0;
    const cache = new StatCache();
    const load = () => cache.get('same', async () => { calls++; return { mtime: 7, ctime: 0 }; });
    await Promise.all([load(), load()]);
    const sorted = await sortEntries(entries, 'ctime', 'asc', async () => load());
    expect(sorted.map(item => item.name)).toEqual(['a', 'b']);
    const fallback = await sortEntries([{ name: 'newer', uri: 'new' }, { name: 'older', uri: 'old' }], 'ctime', 'asc', async entry => ({ mtime: entry.uri === 'new' ? 9 : 2, ctime: entry.uri === 'new' ? 0 : 1 }));
    expect(fallback.map(item => item.name)).toEqual(['older', 'newer']);
    expect(calls).toBe(1);
  });
});
