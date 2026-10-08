import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/util/concurrency';

describe('mapWithConcurrency', () => {
  it('preserves input order when work completes out of order', async () => {
    const results = await mapWithConcurrency([0, 1, 2, 3], 4, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, (3 - value) * 2));
      return value * 2;
    });
    expect(results).toEqual([0, 2, 4, 6]);
  });

  it('does not exceed the configured concurrency limit', async () => {
    let running = 0;
    let maximumRunning = 0;
    const results = await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 3, async (value) => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return value;
    });
    expect(maximumRunning).toBe(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('returns an empty result without calling the mapper for an empty input', async () => {
    let mapperCalls = 0;
    const result = await mapWithConcurrency([], 3, async (value) => {
      mapperCalls += 1;
      return value;
    });
    expect(result).toEqual([]);
    expect(mapperCalls).toBe(0);
  });

  it('rejects NaN and zero concurrency limits', async () => {
    await expect(mapWithConcurrency([], Number.NaN, async (value) => value)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([], 0, async (value) => value)).rejects.toThrow(RangeError);
  });

  it('propagates mapper errors', async () => {
    const error = new Error('mapper failed');
    await expect(mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) {
        throw error;
      }
      return value;
    })).rejects.toBe(error);
  });
});
