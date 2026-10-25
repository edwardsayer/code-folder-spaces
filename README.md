# Folder Spaces for VS Code

![Icon](assets/icon.png)

**Focused, folder-scoped file navigation for Visual Studio Code.** Folder Spaces provides one or two native tree views for the folders you want to work in, without the noise of the whole workspace.

> **Version 0.1.0.** Folder Spaces has two layouts: **Tree** (one pane) and **Dual** (two vertically arranged panes). The panes are intentionally asymmetric and can be configured independently. See [Breaking changes](#breaking-changes-from-v1x) before upgrading from v1.x.

## Why Folder Spaces

VS Code's built-in Explorer always shows the entire workspace. Folder Spaces provides a focused view for selected folders while retaining native file icons, Git decorations, problem badges, file operations and workspace file-system support.

## Tree and Dual modes

- **Tree** shows pane1 as a single folder tree.
- In Tree mode the pane title shows the workspace or project folder name (with a `+ n` suffix when there are several roots) or **Global** when no folder is open.
- **Dual** shows pane1 above pane2. Pane1 is the control center: its title-bar actions and the **Dual Pane** toggle and the native **Sort:** submenu manage layout, roots, workspace folders, sorting and other navigation. Pane2 has a smaller, basic-operation menu (switching the nested-file listing, filtering, collapse/expand, refresh and close).
- Menu items that represent a current state are marked with a trailing **✓**: **Dual Pane** and the **Sort:** submenu in pane1 and **Toggle Nested Files** in pane2 (VS Code offers no native checkmark API for extension menus, so the marker is part of the label and sits after the text so labels stay aligned).
- Pane2 starts as a flat **first-level file list**; **Toggle Nested Files** in its title bar expands it to files from all levels (still a flat listing).
- The panes are deliberately **specialized and asymmetric**; pane2 is not a duplicate control surface. Pane1 cannot be closed. Closing pane2 returns to Tree mode.
- In Dual mode, selecting a folder in pane1 navigates pane2 into that folder. Pane2 has no root switcher of its own; its root comes from that cascade (the `Activate Child Space` command remains available but is not shown in the title bar).
- Because Dual makes pane1 the navigation source, pane1 hides **Return to Parent** in Dual mode and returns to its configured roots when you switch from Tree to Dual. Pane2 keeps its own drill-down state and **Return to Parent**.

## Where spaces come from

Folder roots can come from three sources:

1. **Workspace roots** are available automatically from the current VS Code workspace. They can be hidden from the space list and restored from pane1's menu.
2. **`codeFolderSpaces.spaces.workspace`** is the project/workspace-level list, suitable for roots shared with a project.
3. **Global roots** are stored in the standard user settings (`codeFolderSpaces.spaces.global`, i.e. your profile's `settings.json`) and shown in every workspace/window of that profile. They are marked with a **🌐** indicator. Note that VS Code profiles keep separate settings, so other profiles need their own global roots (or Settings Sync).

Use **Mark as Global** from a space root's context menu to move that root from the workspace list to the global list. Use **Unmark Global** to move it back. This changes the source of the root; the 🌐 marker identifies roots that belong to the profile-level list.

Each entry may be a path string or an object with `path`, `name`, `icon`, `showFiles`, `include` and `exclude`. Paths support `${workspaceFolder}`, `${workspaceFolders[N]}` and `${userHome}`.

## Features

- One or two native TreeViews in the Folder Spaces activity-bar container.
- Root switching, multiple roots, filtering, drill-down and refresh.
- Workspace folders can be followed automatically or hidden from the available roots.
- File nesting follows VS Code's `explorer.fileNesting.enabled`, `patterns` and `expand` settings.
- Native file icons, Git decorations and problem badges through resource URIs.
- File creation, rename, delete, move, drag and drop, and session-scoped move undo.
- Live file-system updates and support for folders outside the workspace.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `codeFolderSpaces.spaces.workspace` | array | `[]` | Project/workspace-level space roots. Entries are paths or objects. |
| `codeFolderSpaces.spaces.global` | array | `[]` | Global roots (written by **Mark as Global**) — user settings, profile-specific. |
| `codeFolderSpaces.spaces.workspace` | array | `[]` | Project roots: written to the folder's `.vscode/settings.json`, or to the `.code-workspace` file when opened as a workspace (target of **Unmark Global**). |
| `codeFolderSpaces.followActiveFile` | boolean | `true` | Follow the active editor file in the space tree. |
| `codeFolderSpaces.maxDepth` | integer (1–100) | `10` | Maximum folder depth enumerated by flat listings. |
| `codeFolderSpaces.followWorkspaceDirectory` | boolean | `true` | Keep pane1's workspace roots synchronized with workspace folders. Configured roots (including global ones) are preserved and added after the workspace roots. |

Example:

```jsonc
{
  "codeFolderSpaces.spaces.workspace": [
    "${workspaceFolder}/src",
    {
      "path": "${workspaceFolder}/docs",
      "name": "Documentation",
      "icon": "book",
      "showFiles": true,
      "exclude": ["archive/**"]
    }
  ],
  "codeFolderSpaces.spaces.global": ["${userHome}/notes"]
}
```

## Common commands

Pane-specific actions live in each pane's title bar, submenus and context menus, and most of them are intentionally hidden from the Command Palette. Common actions include:

- **Drill Into Folder** / **Activate Child Space** (inline buttons on every folder row in pane1; Activate Child Space opens Dual if needed and uses that folder as pane2's root)
- **Add Folder to Space…** / **Remove Root**
- **Dual Pane** / **Dual Pane ✓** (pane1 menu; only one of the pair is shown depending on state; clicking toggles between Tree and Dual)
- **Collapse All** / **Expand Level** (pane1 title bar; Expand Level reveals one more level of every root when nothing is selected, or one more level under the selected root)
- **Filter by Path…** / **Clear Filter** / **Return to Parent**
- **Refresh**
- **Open Workspace** / **Open Workspace in New Window** (inline buttons on `.code-workspace` rows in any pane)
- **Toggle View Mode** (pane2 title bar: Explorer / File List / Nested File List)
- **Mark as Global** / **Unmark Global** (space-root context menu)

The full manifest currently contributes 86 commands.

## Breaking changes from v1.x

Version 0.1.0 replaces the former multi-pane/preset model with fixed Tree and Dual layouts, removes the old `codeFolderSpaces.spaces` setting without migrating its values, and removes preset controls and several settings. Review the full list in [CHANGELOG.md](CHANGELOG.md) before upgrading.

## Known limitations

- Pane1 cannot be closed; closing pane2 returns to Tree mode.
- In Dual mode, pane2 defaults to an in-place **Explorer** tree, and can cycle to **File List** (flat first-level files) or **Nested File List** (flat recursive files) via **Toggle View Mode**.
- Workspace roots may be hidden, but are sourced from the current VS Code workspace.
- Glob support includes `*`, `**`, `**/`, `?` and escaping; brace patterns and character classes are not supported. `src/**` does not match the `src` directory itself.
- File nesting applies to sibling files in the same directory, with each file assigned to at most one parent. A path filter disables nesting.
- Visible-child probing is concurrency-limited to 16; persistent caching is not implemented.
- Virtual workspaces are unsupported; remote environments have not been fully validated.

## Development

```bash
npm install
npm run check          # typecheck, unit tests, build, project checks and command parity
npm run watch          # esbuild watch
npm run package:vsix   # production bundle + vsce package
```

Run the extension locally with F5 (`Run Extension`) or:

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
```

## License

MIT — see [LICENSE](LICENSE).
