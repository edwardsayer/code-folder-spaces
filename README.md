# Folder Spaces for VS Code

**Folder-scoped file explorer spaces for Visual Studio Code.** Pin any folder as its own focused explorer space and browse it without the noise of the whole workspace.

> **Status: early development (v0.0.1).** Folder Spaces provides a dedicated activity-bar view with up to eight **independent folder spaces** (each folder space has its own root, preset, filter, sort and drill-down stack) that can be chained parent → child, plus view presets, drill-down, file nesting, drag & drop and file operations. See Known limitations below.

## Why

VS Code's built-in Explorer always shows the entire workspace. When a repository contains many projects, packages or archive folders, finding the one folder you actually care about becomes slow and noisy. Folder Spaces gives each folder its own focused tree — same workspace, smaller context.

This project is the VS Code counterpart of the Obsidian plugin [Folder Spaces](https://github.com/edwardsayer/obsidian-folder-spaces), adapted to the VS Code Extension API and Marketplace rules.

## Features (current)

- **Folder spaces**: configure any number of folders, each shown as its own root in a dedicated activity-bar view.
- **Independent folder spaces**: up to eight folder spaces stack in the Folder Spaces view. **Every folder space has its own state** — its own roots (one or more folders, not only the configured spaces), view preset, path filter, sort, drill-down stack, name/icon and include/exclude rules. `Folder Spaces: Open Child Folder Space Here` creates a child folder space rooted at the selected folder and links it to its parent folder space.
- **Multiple folders per folder space**: a folder space can hold **several roots** (like a multi-root workspace). `Add Folder to Space...` appends a folder to the current folder space, and each root row has an inline ✕ to `Remove Folder from Space` (it removes that folder only — it never closes the folder space). Roots are shared by the folder space's preset, filter and sort; drilling down affects one root at a time.
- **Built-in Explorer alignment**: with a **single** root the root row is hidden and the first level of the folder is listed directly — exactly like VS Code's built-in Explorer. With **multiple** roots each root is shown as an expandable row.
- **Follow workspace folder**: the first folder space follows the active workspace/project folders by default (`codeFolderSpaces.followWorkspaceDirectory`). Opening a multi-root workspace makes that folder space show every workspace folder as a root. Turn it off to manage the folder space's roots yourself.
- **Linked folder spaces (cascading chain)**: a child folder space with follow enabled tracks the folder selected in its parent folder space. Turning follow off makes the folder space fully independent; switching a child folder space's root manually is allowed and lasts until the parent selects a different folder again.
- **View presets**: seven named presets (Explorer, Navigate, Columns, Context, Contents, Files, List) covering tree/flat modes, depth levels and folder/file content filters.
  - Flat presets: **Files** / **List** show a single-level list whose item names are the full relative path from the folder space root; **Contents** shows folders on the first level (named by relative path, `.` for files directly under the root) and their files, by file name only, on the second level.
- **Navigation**: in-place drill-down with a back stack, root switching and folder space title actions (collapse all / expand one level toggle, filter, drill up, and a ⋯ menu for presets, sort and folder space management).
- **Variables in paths**: `${workspaceFolder}`, `${workspaceFolders[N]}`, `${userHome}`.
- **Per-space options**: custom name, icon, show/hide files, include/exclude glob patterns (used as the defaults for folder spaces created from them).
- **Native tree experience**: file icons, git decorations and problem badges come from `resourceUri`.
- **File nesting**: groups child files under their parent file inside space trees, mirroring the built-in `explorer.fileNesting.enabled` / `patterns` / `expand` settings (the extension re-reads them; nothing extra to configure).
- **Live updates**: recursive file system watchers per folder space root.
- **Commands**: add folder space, add/remove folder to/from a folder space, open child folder space, set folder space root, refresh, reveal active file, reset view slot layout.
- **File operations**: new file/folder, rename, delete, move-to, context actions delegated to built-in commands, drag & drop between folder spaces, session-only cut/copy/paste, with cut/move undo. File opening defaults to the current editor group and can be configured to open beside.

## Planned

- Quick-open entry from the Explorer context menu (`explorer/context` "Add to Folder Spaces").
- Optional space grouping/tags.
- CI (including Linux xvfb integration tests) and Marketplace release assets (PNG icon, screenshots, repository field).

## Known limitations

- **Glob subset**: supports `*`, `**`, `**/` (including zero directory levels), `?` and character escaping. Brace patterns (`{a,b}`) and character classes (`[abc]`) are unsupported; `src/**` does not match the `src` directory itself.
- **Clipboard and drag undo**: internal drag-and-drop moves (undoable); external items dragged in are copied (not undoable). Cut/move operations share the session undo stack; copied files/folders are not undoable. Ctrl+C/X/V, Ctrl+N, F2, Delete and Ctrl+Z bindings apply only while the Folder Spaces tree has focus.
- **View slots and placement**: at most **eight** view slots, because VS Code requires views to be declared statically (there is no API to create views at runtime). Views stack vertically inside the Folder Spaces view and the order is fixed by the manifest; you can move any view slot to the secondary side bar, the panel or a floating window yourself with the built-in `View: Move View` / drag actions, and `View: Reset View Locations` restores the default.
- **Folder space model**: each folder space keeps its own view state; `codeFolderSpaces.spaces` is only a list of folders to pick from (and the source of defaults for new folder spaces), not the definition of what folder spaces show.
- **Workspace support**: virtual workspaces are unsupported; remote scenarios have not been validated.
- **Large directories**: visible-child probing is concurrency-limited to 16. Caching has not been added yet.
- **External folders**: folders outside the workspace can be used as space roots; reading and watching them have been tested.
- **File nesting**: follows `explorer.fileNesting.enabled` / `patterns` / `expand`, so it stays off unless file nesting is enabled for the built-in Explorer. Only files in the same directory are matched, each file nests under at most one parent (the first matching pattern wins), exact-name parent patterns such as the built-in `package.json` / `tsconfig.json` rules are supported (`${capture}` child patterns are skipped for those), and nesting is disabled while a path filter is active. Case-insensitive matching follows the platform (Windows / macOS) rather than per-folder case sensitivity. Flat presets (Contents / Files / List) are unaffected.

For implementation-level details, see the Known pitfalls section in `AGENTS.md`.

See `CHANGELOG.md` for details as they land.

## Development

```bash
npm install
npm run check          # typecheck + unit tests + build + project health gate
npm run watch          # esbuild watch
npm run package:vsix   # production bundle + vsce package
```

Run the extension locally with the `Run Extension` launch configuration (F5), or through the workspace debug launcher:

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
```

## Configuration

```jsonc
{
  "codeFolderSpaces.spaces": [
    "${workspaceFolder}/src",
    {
      "path": "${workspaceFolder}/docs",
      "name": "Documentation",
      "icon": "book",
      "showFiles": true,
      "exclude": ["archive/**"]
    }
  ],
  "codeFolderSpaces.view.showFiles": true
}
```

## License

MIT — see [LICENSE](LICENSE).
