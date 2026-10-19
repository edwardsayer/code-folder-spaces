import * as path from 'node:path';
import type { SpaceDefinition } from '../types';
import { LAYOUT_KEY, LEGACY_PANE_STATE_KEY, LEGACY_PANE_STATE_V1_KEY, LayoutStore, type LayoutInitContext, type LayoutPaneState, type MementoLike as LayoutMementoLike } from './layout';
import type { ViewAxisChange, ViewPresetName, ViewSettings } from './viewPresets';
import { VIEW_PRESETS, applyViewAxis, isViewSettings } from './viewPresets';
import { fixedPaneLinks } from './paneRules';

export type { SortKey, SortDirection, SortState } from './layout';
export type MementoLike = LayoutMementoLike;
export type PaneState = LayoutPaneState;
export const PANE_STATE_KEY = LAYOUT_KEY;
export { LEGACY_PANE_STATE_KEY, LEGACY_PANE_STATE_V1_KEY as LEGACY_V1_PANE_STATE_KEY };

export function normalizeSpaceKey(basePath: string): string {
  const normalized = path.normalize(basePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean { return normalizeSpaceKey(a) === normalizeSpaceKey(b); }

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function effectiveView(pane: Pick<PaneState, 'view'>): ViewSettings {
  return pane.view && isViewSettings(pane.view) ? pane.view : VIEW_PRESETS.Explorer;
}

export function activeRoot(pane: PaneState): string | null { return pane.drillRoot ?? pane.roots[0] ?? null; }

/** 以最長前綴選出包含目標 URI 的根目錄。 */
export function rootForUri(roots: readonly string[], target: string): string | null {
  return roots.filter(root => isPathWithin(path.normalize(target), path.normalize(root)))
    .sort((a, b) => path.relative(path.normalize(a), path.normalize(target)).length - path.relative(path.normalize(b), path.normalize(target)).length)[0] ?? null;
}

/** Resolve each pane root into a pane-scoped definition. */
export function resolvePaneDefinitions(pane: PaneState, spaces: SpaceDefinition[]): SpaceDefinition[] {
  return pane.roots.map(root => {
    const hit = spaces.find(space => samePath(space.basePath, root));
    return { basePath: root, name: hit?.name ?? path.basename(root), icon: pane.icon ?? hit?.icon,
      showFiles: true, include: pane.include, exclude: pane.exclude, sourceIndex: hit?.sourceIndex ?? -1 };
  });
}

export function resolvePaneDefinition(pane: PaneState, spaces: SpaceDefinition[]): SpaceDefinition | null {
  return resolvePaneDefinitions(pane, spaces)[0] ?? null;
}

export type RenameImpact = { kind: 'space-root' } | { kind: 'inside-space'; basePath: string } | { kind: 'unrelated' };

export function classifySpaceRename(basePaths: string[], oldPath: string): RenameImpact {
  const exact = basePaths.find(basePath => samePath(basePath, oldPath));
  if (exact) return { kind: 'space-root' };
  const containing = basePaths.find(basePath => isPathWithin(path.normalize(oldPath), normalizeSpaceKey(basePath)));
  return containing ? { kind: 'inside-space', basePath: containing } : { kind: 'unrelated' };
}

export class PaneStateStore extends LayoutStore {
  getPaneLinks(): Record<string, { root: string | null; parentPaneId: string | null; follow: boolean }> {
    return fixedPaneLinks(id => activeRoot(this.get(id)), this.getMode());
  }

  getEnabledPaneIds(): string[] { return this.getMode() === 'dual' ? ['pane1', 'pane2'] : ['pane1']; }

  async setPreset(paneId: string, name: ViewPresetName): Promise<void> {
    await this.setView(paneId, VIEW_PRESETS[name]);
  }

  async setViewAxis(paneId: string, change: ViewAxisChange): Promise<void> {
    const current = effectiveView(this.get(paneId));
    const view = change.axis === 'mode' ? applyViewAxis(current, 'mode', change.value)
      : change.axis === 'level' ? applyViewAxis(current, 'level', change.value)
      : applyViewAxis(current, 'content', change.value);
    await this.setView(paneId, view);
  }

  async drillDown(paneId: string, root: string, childView?: ViewSettings): Promise<void> {
    await super.drillDown(paneId, root, childView);
  }

  async resetToDefaults(ctx: LayoutInitContext): Promise<void> {
    await this.initialize(ctx);
    await this.reset();
  }
}
