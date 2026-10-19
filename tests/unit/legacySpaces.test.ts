import { describe, expect, it, vi } from 'vitest';
import { clearLegacySpacesSetting, type LegacySpacesConfiguration } from '../../src/spaces/legacySpaces';

const WORKSPACE = 'ws-target';
const GLOBAL = 'global-target';
const targets = { workspace: WORKSPACE, global: GLOBAL };

type Inspected = { workspaceValue?: unknown; globalValue?: unknown } | undefined;

function fakeConfiguration(inspected: Inspected) {
  const update = vi.fn(async (_section: string, _value: unknown, _target: unknown) => undefined);
  const configuration: LegacySpacesConfiguration = { inspect: () => inspected as never, update };
  return { configuration, update };
}

describe('clearLegacySpacesSetting', () => {
  it('does nothing when the legacy key is absent from both layers', async () => {
    const { configuration, update } = fakeConfiguration({});
    expect(await clearLegacySpacesSetting(configuration, targets)).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('removes the legacy key from the global layer only', async () => {
    const { configuration, update } = fakeConfiguration({ globalValue: [] });
    expect(await clearLegacySpacesSetting(configuration, targets)).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('spaces', undefined, GLOBAL);
  });

  it('removes the legacy key from both layers when both carry a value', async () => {
    const { configuration, update } = fakeConfiguration({ workspaceValue: [{ path: '/a' }], globalValue: [] });
    expect(await clearLegacySpacesSetting(configuration, targets)).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, 'spaces', undefined, WORKSPACE);
    expect(update).toHaveBeenNthCalledWith(2, 'spaces', undefined, GLOBAL);
  });

  it('keeps going and logs when one layer fails (e.g. policy-locked settings)', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValueOnce(undefined) as unknown as LegacySpacesConfiguration['update'];
    const configuration: LegacySpacesConfiguration = {
      inspect: () => ({ workspaceValue: [], globalValue: [] }) as never,
      update,
    };
    const warn = vi.fn();
    expect(await clearLegacySpacesSetting(configuration, targets, { warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('returns false and logs when every layer fails', async () => {
    const update = vi.fn(async () => { throw new Error('locked'); }) as unknown as LegacySpacesConfiguration['update'];
    const configuration: LegacySpacesConfiguration = { inspect: () => ({ globalValue: [] }) as never, update };
    const warn = vi.fn();
    expect(await clearLegacySpacesSetting(configuration, targets, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
