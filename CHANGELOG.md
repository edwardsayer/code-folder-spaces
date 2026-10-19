# Changelog

All notable changes to Folder Spaces are documented in this file.

## [0.1.0] — 2026-10-19

### Breaking Changes

1. Replaced the former eight-pane/linked-pane model with **exactly two views**: Tree mode (pane1 only) and Dual mode (pane1 above pane2). Pane1 cannot be closed; pane2 can be closed to return to Tree mode.
2. The legacy `codeFolderSpaces.spaces` setting is no longer supported. Replace it with `codeFolderSpaces.spaces.workspace` for project/workspace roots or `codeFolderSpaces.spaces.global` for profile-level roots. Legacy values are **not migrated** and are cleared during activation.
3. Removed the preset UI and its commands: `Preset:`, `Level`, `Content`, `Mode` and `Sort` are no longer available as preset controls. The `VIEW_PRESETS` definitions in `viewPresets.ts` remain as an internal source of view combinations only.
4. Removed four settings: `codeFolderSpaces.defaultPreset`, `codeFolderSpaces.defaultChildPreset`, `codeFolderSpaces.adaptiveCascadeParent` and `codeFolderSpaces.cascadeParentPreset`.
5. Removed the status bar item; Folder Spaces no longer displays `Folder Spaces: 1→2`.
6. Reduced the contributed command count from the v1 peak of **321 to 55**.

### Added

- Added separate workspace-level (`codeFolderSpaces.spaces.workspace`) and profile-level (`codeFolderSpaces.spaces.global`) root lists.
- Added Mark as Global / Unmark Global actions and a 🌐 marker for profile-level roots.
- Added fixed Tree and Dual layouts with intentionally asymmetric, independently specialized pane controls.
- Added command/handler parity validation to `npm run check`.

### Changed

- Pane1 is the control center for layout and root management; pane2 provides a smaller set of basic operations.
- Workspace roots are available automatically and can be hidden from the root list.
- Pane2 may use its own root and view configuration; in Dual mode pane1 folder selection can navigate pane2.
- Updated architecture and user documentation for the v2 model.

### Removed

- Removed `paneLinks.ts`, `linkStatusBar.ts` and `clickBehavior.ts`.
- Removed the old eight-pane view slots, pane-link/status-bar behavior and preset-facing UI/settings.

## [0.0.1] — 2026-10-08

### Added

- Initial project scaffold: extension manifest, build (esbuild), TypeScript config, unit tests (Vitest) and project health gate.
- Configuration model `codeFolderSpaces.spaces` with string or object entries, variable interpolation (`${workspaceFolder}`, `${workspaceFolders[N]}`, `${userHome}`), per-space name, icon, `showFiles`, `include` and `exclude`.
- Dedicated activity-bar container and `codeFolderSpaces.explorer` tree view.
- Folder-scoped tree over `workspace.fs` with directories-first ordering, optional files and glob filtering.
- Commands: add space, remove space, refresh, reveal active file.
- Recursive file system watchers per space with debounced refresh.
- Two-layer localization files (`package.nls.*`, `l10n/bundle.l10n.*`) for English and Traditional Chinese.
- Public API exported from `activate()` (`version`, `getSpaces()`).
