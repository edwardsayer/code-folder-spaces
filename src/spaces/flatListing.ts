export const DEFAULT_FLAT_MAX_DEPTH = 10; // Protect recursive flat views from excessively deep trees.

export interface FlatEntry<T> {
  value: T;
  isDirectory: boolean;
  depth: number;
}

/** Recursively collects entries; depth 1 is directly beneath the root. */
export async function buildFlatListing<T>(
  readChildren: (parent: T | undefined) => Promise<readonly { value: T; isDirectory: boolean }[]>,
  maxDepth = DEFAULT_FLAT_MAX_DEPTH,
  level: 1 | 2 | 'all' = 'all'
): Promise<FlatEntry<T>[]> {
  const result: FlatEntry<T>[] = [];
  const visit = async (parent: T | undefined, depth: number): Promise<void> => {
    if (depth > maxDepth || (level !== 'all' && depth > level)) return;
    for (const entry of await readChildren(parent)) {
      result.push({ ...entry, depth });
      if (entry.isDirectory && depth < maxDepth && (level === 'all' || depth < level)) await visit(entry.value, depth + 1);
    }
  };
  await visit(undefined, 1);
  return result;
}
