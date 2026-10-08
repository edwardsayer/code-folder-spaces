import { mapWithConcurrency } from '../util/concurrency';
import type { SortDirection, SortKey } from './viewState';

export interface SortableEntry { name: string; uri: string; }
export interface EntryTimes { mtime: number; ctime: number; }
export type StatTimes = (entry: SortableEntry) => Promise<EntryTimes | undefined>;

export function matchesPathFilter(relativePath: string, filter: string): boolean {
  return !filter || relativePath.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
}

export function compareEntryNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

/** Sort with bounded, per-operation stat reads. Missing ctime falls back to mtime. */
export async function sortEntries<T extends SortableEntry>(
  entries: T[], key: SortKey, direction: SortDirection, getTimes: StatTimes
): Promise<T[]> {
  if (key === 'name') {
    return [...entries].sort((a, b) => compareEntryNames(a.name, b.name) * (direction === 'asc' ? 1 : -1));
  }
  const times = new Map<string, EntryTimes | undefined>();
  await mapWithConcurrency(entries, 16, async entry => {
    if (!times.has(entry.uri)) times.set(entry.uri, await getTimes(entry));
  });
  return [...entries].sort((a, b) => {
    const av = times.get(a.uri);
    const bv = times.get(b.uri);
    const aTime = key === 'ctime' ? (av?.ctime || av?.mtime || 0) : (av?.mtime || 0);
    const bTime = key === 'ctime' ? (bv?.ctime || bv?.mtime || 0) : (bv?.mtime || 0);
    return (aTime - bTime) * (direction === 'asc' ? 1 : -1) || compareEntryNames(a.name, b.name);
  });
}

/** Cache stats for the lifetime of a provider refresh cycle. */
export class StatCache {
  private readonly values = new Map<string, Promise<EntryTimes | undefined>>();
  get(uri: string, load: () => Promise<EntryTimes | undefined>): Promise<EntryTimes | undefined> {
    let result = this.values.get(uri);
    if (!result) { result = load(); this.values.set(uri, result); }
    return result;
  }
  clear(): void { this.values.clear(); }
}
