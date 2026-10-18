import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ TreeItem: class {} }));

import { buildFlatListing, DEFAULT_FLAT_MAX_DEPTH } from '../../src/spaces/flatListing';

/**
 * S4.1R17：`codeFolderSpaces.maxDepth` 設定化。
 * 這裡驗證 `buildFlatListing` 的 maxDepth 契約（provider 只負責把設定值注入），
 * 確保設定值確實限制遞迴深度，且預設值維持 10。
 */
describe('flat listing maxDepth contract (S4.1R17)', () => {
  /** 建立 depth 層的鏈狀樹：root -> a -> b -> c -> ... */
  const chain = (length: number) => {
    const nodes = Array.from({ length }, (_, i) => `n${i}`);
    const read = async (parent?: string) => {
      const index = parent === undefined ? 0 : Number(parent.slice(1)) + 1;
      if (index >= length) return [];
      return [{ value: nodes[index], isDirectory: true }];
    };
    return read;
  };

  it('exposes 10 as the documented default', () => {
    expect(DEFAULT_FLAT_MAX_DEPTH).toBe(10);
  });

  it('stops descending at the configured maxDepth', async () => {
    const read = chain(20);
    const shallow = await buildFlatListing(read, 3, 'all');
    const deep = await buildFlatListing(read, 8, 'all');
    expect(Math.max(...shallow.map(entry => entry.depth))).toBe(3);
    expect(Math.max(...deep.map(entry => entry.depth))).toBe(8);
    // 深度越大列舉越多（單調）
    expect(deep.length).toBeGreaterThan(shallow.length);
  });

  it('keeps level as an independent upper bound', async () => {
    const read = chain(20);
    // level: 2 時，即使 maxDepth 很大也不得超過 2 層
    const listing = await buildFlatListing(read, 10, 2);
    expect(Math.max(...listing.map(entry => entry.depth))).toBe(2);
  });

  it('treats maxDepth = 1 as a single level', async () => {
    const read = chain(20);
    const listing = await buildFlatListing(read, 1, 'all');
    expect(listing).toHaveLength(1);
    expect(listing[0].depth).toBe(1);
  });
});
