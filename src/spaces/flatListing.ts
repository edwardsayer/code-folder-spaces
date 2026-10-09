import { mapWithConcurrency } from '../util/concurrency';

export const DEFAULT_FLAT_MAX_DEPTH = 10; // Protect recursive flat views from excessively deep trees.
export const DEFAULT_FLAT_LISTING_CONCURRENCY = 16;

export interface FlatEntry<T> {
  value: T;
  isDirectory: boolean;
  depth: number;
}

/** Recursively collects entries; depth 1 is directly beneath the root. */
export async function buildFlatListing<T>(
  readChildren: (parent: T | undefined) => Promise<readonly { value: T; isDirectory: boolean }[]>,
  maxDepth = DEFAULT_FLAT_MAX_DEPTH,
  level: 1 | 2 | 'all' = 'all',
  concurrency = DEFAULT_FLAT_LISTING_CONCURRENCY
): Promise<FlatEntry<T>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency limit must be a positive integer');
  }

  const result: FlatEntry<T>[] = [];
  const canDescend = (depth: number) => depth < maxDepth && (level === 'all' || depth < level);
  const visit = async (parent: T | undefined, depth: number, children?: readonly { value: T; isDirectory: boolean }[]): Promise<void> => {
    if (depth > maxDepth || (level !== 'all' && depth > level)) return;
    const entries = children ?? await readChildren(parent);
    const directories = canDescend(depth) ? entries.filter(entry => entry.isDirectory) : [];
    let childIndex = 0;
    let batch: readonly (readonly { value: T; isDirectory: boolean }[])[] = [];
    for (const entry of entries) {
      result.push({ ...entry, depth });
      if (entry.isDirectory && canDescend(depth)) {
        if (childIndex % concurrency === 0) {
          const nextDirectories = directories.slice(childIndex, childIndex + concurrency);
          batch = await mapWithConcurrency(nextDirectories, concurrency, child => readChildren(child.value));
        }
        await visit(entry.value, depth + 1, batch[childIndex % concurrency]);
        childIndex++;
      }
    }
  };
  await visit(undefined, 1);
  return result;
}
