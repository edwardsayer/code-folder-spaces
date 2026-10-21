# Changelog

All notable changes to Folder Spaces are documented in this file.

## [0.1.0] — 2026-10-19

### Breaking Changes

1. Replaced the former eight-pane/linked-pane model with **exactly two views**: Tree mode (pane1 only) and Dual mode (pane1 above pane2). Pane1 cannot be closed; pane2 can be closed to return to Tree mode.
2. The legacy `codeFolderSpaces.spaces` setting is no longer supported. Replace it with `codeFolderSpaces.spaces.workspace` for project/workspace roots or `codeFolderSpaces.spaces.global` for profile-level roots. Legacy values are **not migrated** and are cleared during activation.
3. Removed the preset UI and its commands: `Preset:`, `Level`, `Content`, `Mode` and `Sort` are no longer available as preset controls. The `VIEW_PRESETS` definitions in `viewPresets.ts` remain as an internal source of view combinations only.
4. Removed four settings: `codeFolderSpaces.defaultPreset`, `codeFolderSpaces.defaultChildPreset`, `codeFolderSpaces.adaptiveCascadeParent` and `codeFolderSpaces.cascadeParentPreset`.
5. Removed the status bar item; Folder Spaces no longer displays `Folder Spaces: 1→2`.
6. Reduced the contributed command count from the v1 peak of **321 to 72** (nine of them are the paired `<id>.checked` commands used for check marks).

### Added

- Added separate workspace-level (`codeFolderSpaces.spaces.workspace`) and profile-level (`codeFolderSpaces.spaces.global`) root lists.
- Added Mark as Global / Unmark Global actions and a 🌐 marker for profile-level roots.
- Added fixed Tree and Dual layouts with intentionally asymmetric, independently specialized pane controls.
- Added **Activate Child Space** (pane1, Dual mode): uses the folder selected in pane1 as pane2's root (a selected file uses its parent folder; no selection falls back to pane1's current root).
- Added native submenus (**View:**, **Sort:**) whose current choice is marked with a trailing **✓**, implemented as paired commands (`<id>.checked`) because VS Code exposes no native checkmark for extension menus (`toggled` is core-only; item icons do not render in submenus).
- Added a **Toggle Nested Files** title-bar action for pane2 (replacing the former pane2 view submenu): the pane2 listing stays flat and switches between first-level files and files from all levels.
- Added command/handler parity validation to `npm run check`.

### Changed

- Pane1 is the control center for layout and root management; pane2 provides a smaller set of basic operations.
- Workspace roots are available automatically and can be hidden from the root list.
- Pane2 root is driven by pane1: folder selection in Dual mode cascades into pane2, and **Activate Child Space** sets it explicitly. Pane2 keeps its own view and filter state but has no root switcher of its own.
- Pane2 defaults to a flat first-level file listing and keeps its view across Tree/Dual switches.
- In Dual mode pane1 hides **Return to Parent** and returns to its configured roots when switching from Tree to Dual; pane2 keeps its own drill-down state.
- Updated architecture and user documentation for the v2 model.

### Fixed

- Global roots (`Mark as Global`) are stored in the standard user settings (`codeFolderSpaces.spaces.global`) and mirrored to a **user-level file** (`~/.code-folder-spaces/global-roots.json`) so the same OS user sees them in every VS Code profile, workspace and window (a single profile's settings cannot be shared across profiles).
- Removed the **Activate Child Space** text button from pane1's title bar (the command remains registered); pane2's root is driven by the pane1 folder-selection cascade.
- Follow Workspace Directory no longer overwrites pane1 roots with the workspace roots only: configured roots (`codeFolderSpaces.spaces.workspace` / `.global`, including **Mark as Global** roots) are preserved and appear in every workspace, so a global root no longer disappears after switching projects or reloading.

### Removed

- Removed `paneLinks.ts`, `linkStatusBar.ts` and `clickBehavior.ts`.
- Removed the old eight-pane view slots, pane-link/status-bar behavior and preset-facing UI/settings.
- Removed dead manifest entries for the former pane3–pane8 views (`view/title`, `viewsWelcome`) and 67 unreferenced `package.nls` keys.

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
