# Changelog

All notable changes to Folder Spaces are documented in this file.

## [0.2.2] — 2026-10-27

### Added

- **Simplified Chinese UI**: added `package.nls.zh-cn.json` and `l10n/bundle.l10n.zh-cn.json`, so manifests and runtime messages are localized when VS Code runs with a `zh-cn` language pack (previously only English and Traditional Chinese were available). Closes residual risk R6.

### Fixed

- **Open in Folder Spaces now reveals the pane**: running the Explorer context-menu action only added the folder to Pane 1, so with the container collapsed or hidden nothing appeared to happen. It now focuses the Folder Spaces view and reveals the added folder row. Closes residual risk R4.

### Changed

- `scripts/check-project.mjs` no longer hardcodes `zh-tw`: every `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json` is discovered automatically and checked for key symmetry, non-empty values and identical placeholder sets, so adding a locale cannot silently skip the catalog gate.
- Unit tests cover the new locale discovery (`l10nCatalog.test.ts`).

## [0.2.1] — 2026-10-26

### Documentation

- Added an **Install** section to all three READMEs (English, 繁體中文, 简体中文): the VS Code Marketplace page, the `code --install-extension edwardsayer.folder-spaces` command, VSIX installation, and a first-run pointer to **Add Folder Space…**.
- Documented that Open VSX is not available yet, so VSCodium and Cursor users should install the VSIX for now.
- Recorded the first Marketplace release: `0.2.0` was published on 2026-10-26.

## [0.2.0] — 2026-10-26

### Breaking Changes

- **Extension identity renamed**: `edwardsayer.code-folder-spaces` → **`edwardsayer.folder-spaces`**; the package name is now `folder-spaces` and the VSIX artefact is `folder-spaces-<version>.vsix`. Existing installations are treated as a different extension and must be installed again (settings keys and the `layout.v1` state are unaffected). The legacy `~/.code-folder-spaces` migration directory is intentionally unchanged.
- Removed the pane1 **View** submenu and the `pane1.mode.tree.checked` command; **Dual Pane** / **Dual Pane ✓** are a state-paired item in the pane1 title menu and the checked item returns to Tree mode.
- Removed **Switch Root…** (`codeFolderSpaces.switchRoot` / `codeFolderSpaces.pane1.switchRoot`). Pane roots change through **Add Folder to Space…**, **Drill Into Folder**, the pane cascade or **Activate Child Space**.
- Removed the redundant node-less `codeFolderSpaces.pane1.activateChild` command. Pane2 roots are set only by the pane cascade or `Activate Child Space` (`codeFolderSpaces.activateChildNode`).
- Removed **Reset Pane Layout** from user-facing views and menus (superseded by Dual Pane and Refresh).
- Removed Pane 2 **Collapse All** / **Expand All** and the Pane 1 right-click **Drill Into Folder** item (the row inline button remains).

### Added

- Added `codeFolderSpaces.pane2.sort.*` commands and a native **Sort** submenu to pane2 with paired checkmark items (matching pane1's sort capabilities). The total contributed command count is now 83.
- Added paired `Dual Pane` and `Dual Pane ✓` on both Spaces and Files panes, synchronizing directly with UI visibility: if either pane is hidden from the container menu, the remaining pane shows an unchecked `Dual Pane` action that immediately unhides and restores the missing pane.
- Added `codeFolderSpaces.pane2.toggleViewMode` on Pane 2's title bar, cycling across three view modes: **Explorer** (default in Dual mode, lazy-loaded tree with in-place drill-down and leaf folder icons), **File List** (flat first-level files), and **Nested File List** (flat recursive files).
- Added `codeFolderSpaces.pane2.mode.dual.checked` on Pane 2's menu as an exit button to easily return to Tree mode if Pane 1 is hidden.
- Added automatic sync on Pane 2 visibility: hiding/closing Pane 2 automatically closes Dual mode and restores Pane 1 to the standard Explorer view.

### Changed

- Changed Pane 2's default preset in Dual mode to **Explorer** (eliminating empty-pane perception when a directory only contains subfolders and avoiding recursive listing lag on large workspaces).
- Removed **Reset Pane Layout** from user-facing views and menus (superseded by Dual Pane and Refresh controls). Total contributed commands is now 85.
- Renamed the two pane views from "Folder Space 1" and "Folder Space 2" to **Spaces** and **Files** in both English and Traditional Chinese localizations.
- Promoted **Toggle Nested Files** (`codeFolderSpaces.pane2.toggleNested`) to a title-bar action button on Pane 2 (`navigation@2`), equipped with paired `$(list-flat)` and `$(list-tree)` icons.
- Removed Pane 2's **Collapse All** and **Expand All** commands (`codeFolderSpaces.pane2.collapseAll` / `.expandAll`), as Pane 2 presents a flat file listing. Total contributed commands is now 81.
- Renamed Pane 2's **Close Space** action to **Close Pane** (`Close Pane` / `關閉窗格`).
- Removed **Drill Into Folder** from the treeview item context menu (`view/item/context`), keeping only the row inline button to avoid redundant context-menu clutter.
- Refined the extension icon (`assets/icon.svg`, `assets/icon.png`): changed the purple badge stroke to a clean white outline (Scheme A) for seamless contrast on both light and dark themes, adjusted the front folder crease line to be brighter, bolder and positioned at ~1/3 below the folder border towards the badge, and added a matching subtle crease line on the back golden folder.
- Removed the pane1 **View** submenu and the `pane1.mode.tree.checked` command. **Dual Pane** / **Dual Pane ✓** are now a state-paired menu item directly in the pane1 title menu; clicking the checked item returns to Tree mode.
- Removed **Switch Root…** (`codeFolderSpaces.switchRoot` / `codeFolderSpaces.pane1.switchRoot`). Pane roots are changed by **Add Folder to Space…**, **Drill Into Folder**, the pane cascade, or **Activate Child Space**.
- **Add Folder to Space…** now offers a single searchable picker: candidate folders (parent folders of the current roots, recently opened folders) plus a **Browse for folder…** entry, and accepts a typed path (with `~` expansion). Workspace/project subfolders are not listed — use **Drill Into Folder** for those.
- Pane titles: no description in either mode. In Dual mode pane1 and pane2 titles are the last path segment (or **Spaces** when pane1 has more than one root and is not drilled); in Tree mode the container title stays **Folder Spaces**. `getPanes()` now also exposes `hint` (full path) and a new `getContainerHint()` returns pane1's hint.
- Pane1 title bar regained **Collapse All** / **Expand Level**; **Expand Level** now expands every root one level when no root is selected, or one more level under the selected root.
- Pane1 can now drill into folders in Dual mode (Return to Parent is no longer limited to Tree mode).
- `.code-workspace` files get **Open Workspace** / **Open Workspace in New Window** inline actions in any pane.
- Added three settings: `codeFolderSpaces.defaultPreset.singlePane`, `.dualPane.pane1` and `.dualPane.pane2`, applied when switching between Tree and Dual mode.
- Root path comparison is now case-insensitive on Windows for drill/filter state, so casing differences no longer drop pane state.
- Removed the redundant node-less `codeFolderSpaces.pane1.activateChild` command (no UI entry point since v2.1). Pane2's root is set only by the pane cascade or the `Activate Child Space` inline button (`codeFolderSpaces.activateChildNode`). The contributed command count is now 71.

### Fixed

- Fixed: **Collapse All** now reliably collapses all roots and nested folders in multi-root setups by focusing the TreeView and collapsing all roots unconditionally regardless of item selection.
- Fixed: folders added with **Add Folder to Space…** in an empty window (no folder/workspace open) were silently dropped on reload. Empty windows now keep the pane roots and only merge in the global roots.
- Added a GitHub Actions pipeline: typecheck/unit/build/project checks, integration tests under xvfb against VS Code **1.85.1** (the declared minimum) and current stable, plus VSIX packaging with hygiene assertions.

### Documentation

- Rewrote the README in English, Traditional Chinese and Simplified Chinese, with 11 fresh screenshots taken at a narrow viewport plus zoomed crops for menus.
- The README screenshots are no longer bundled in the VSIX (they were 92% of its size); `vsce` rewrites the relative paths to GitHub raw URLs, so the repository must stay public.
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

- Global roots (`Mark as Global`) are stored **only** in the standard user settings (`codeFolderSpaces.spaces.global`, `scope: application`). An early preview build's `~/.code-folder-spaces/global-roots.json` is imported once at startup and then retired as `global-roots.migrated.json`; no custom file is written anymore.
- Folder rows in pane1 now always show two inline buttons: **Drill Into Folder** and **Activate Child Space** (`$(arrow-right)`). Activate Child Space switches to Dual first when needed, then sets that folder as pane2's root; the title bar no longer carries the text button.
- Project roots are persisted where VS Code expects them: global roots in user settings, non-global roots in the project's `.vscode/settings.json` or in the `.code-workspace` file. Panel roots are rebuilt from all three sources, so an unmarked root survives switching projects and coming back.
- In Tree mode the panel title shows the workspace/project name (or **Global** when no folder is open), with a `+ n` suffix when several roots are shown.
- **Mark as Global / Unmark Global** are now chosen by the clicked node's context value, so the context menu switches to *Unmark Global* immediately after marking (previously it kept showing *Mark as Global* until the selection changed).
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
