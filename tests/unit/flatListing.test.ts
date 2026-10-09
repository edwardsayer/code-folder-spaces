import { describe, expect, it } from 'vitest';
import { buildFlatListing } from '../../src/spaces/flatListing';

type Entry = { value: string; isDirectory: boolean };

const tree = new Map<string, Entry[]>([
  ['', [
    { value: 'a', isDirectory: true },
    { value: 'root.txt', isDirectory: false },
    { value: 'b', isDirectory: true },
  ]],
  ['a', [
    { value: 'a-child', isDirectory: true },
    { value: 'a.txt', isDirectory: false },
  ]],
  ['a-child', [{ value: 'deep.txt', isDirectory: false }]],
  ['b', [{ value: 'b.txt', isDirectory: false }]],
]);

const readTree = async (parent: string | undefined) => tree.get(parent ?? '') ?? [];

describe('buildFlatListing', () => {
  it('retains DFS order with variable asynchronous read delays and parallel reads', async () => {
    let active = 0;
    let peak = 0;
    const read = async (parent: string | undefined) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, parent === 'a' ? 12 : 1));
      active--;
      return readTree(parent);
    };

    const listing = await buildFlatListing(read, 10, 'all', 2);
    expect(listing.map(entry => entry.value)).toEqual([
      'a', 'a-child', 'deep.txt', 'a.txt', 'root.txt', 'b', 'b.txt',
    ]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('bounds reads globally on a broad tree and preserves the serial result', async () => {
    const broad = new Map<string, Entry[]>([['', Array.from({ length: 40 }, (_, i) => ({ value: `d${i}`, isDirectory: true }))]]);
    for (let i = 0; i < 40; i++) broad.set(`d${i}`, [{ value: `f${i}`, isDirectory: false }]);
    let active = 0;
    let peak = 0;
    const read = async (parent: string | undefined) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return broad.get(parent ?? '') ?? [];
    };

    const serial = await buildFlatListing(read, 10, 'all', 1);
    const parallel = await buildFlatListing(read, 10, 'all', 16);
    expect(parallel).toEqual(serial);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });

  it('handles deep and broad trees without deadlock', async () => {
    const deep = new Map<string, Entry[]>([['', [{ value: 'd0', isDirectory: true }]]]);
    for (let i = 0; i < 9; i++) deep.set(`d${i}`, [{ value: `d${i + 1}`, isDirectory: true }]);
    deep.set('d10', [{ value: 'leaf', isDirectory: false }]);
    const listing = await buildFlatListing(async (parent: string | undefined) => deep.get(parent ?? '') ?? [], 10, 'all', 4);
    expect(listing).toHaveLength(10);
    expect(listing.at(-1)).toEqual({ value: 'd9', isDirectory: true, depth: 10 });

    const wide = new Map<string, Entry[]>([['', Array.from({ length: 200 }, (_, i) => ({ value: `d${i}`, isDirectory: true }))]]);
    const wideListing = await buildFlatListing(async (parent: string | undefined) => wide.get(parent ?? '') ?? [], 10, 'all', 16);
    expect(wideListing).toHaveLength(200);
  });

  it('preserves level, maxDepth, and empty-child semantics', async () => {
    expect((await buildFlatListing(readTree, 10, 1)).map(entry => entry.value)).toEqual(['a', 'root.txt', 'b']);
    expect((await buildFlatListing(readTree, 10, 2)).map(entry => entry.value)).toEqual([
      'a', 'a-child', 'a.txt', 'root.txt', 'b', 'b.txt',
    ]);
    expect((await buildFlatListing(readTree, 2, 'all')).some(entry => entry.depth > 2)).toBe(false);
    expect(await buildFlatListing(async () => [], 10, 'all')).toEqual([]);
  });

  it('propagates read failures and rejects invalid concurrency limits', async () => {
    const failure = new Error('read failed');
    await expect(buildFlatListing(async parent => {
      if (parent === undefined) return [{ value: 'directory', isDirectory: true }];
      throw failure;
    })).rejects.toBe(failure);
    await expect(buildFlatListing(readTree, 10, 'all', 0)).rejects.toThrow(RangeError);
    await expect(buildFlatListing(readTree, 10, 'all', 1.5)).rejects.toThrow(RangeError);
  });
});
