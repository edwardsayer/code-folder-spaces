# Folder Spaces for VS Code

**Folder-scoped file explorer spaces for Visual Studio Code.** Pin any folder as its own focused explorer space and browse it without the noise of the whole workspace.

> **Status: early scaffold (v0.0.1).** The extension currently provides the configuration model, a dedicated activity-bar view, a folder-scoped tree with optional files, include/exclude filtering, refresh and reveal-active-file commands. View modes, drill-down, drag & drop and file operations are planned next.

## Why

VS Code's built-in Explorer always shows the entire workspace. When a repository contains many projects, packages or archive folders, finding the one folder you actually care about becomes slow and noisy. Folder Spaces gives each folder its own focused tree — same workspace, smaller context.

This project is the VS Code counterpart of the Obsidian plugin [Folder Spaces](https://github.com/edwardsayer/obsidian-folder-spaces), adapted to the VS Code Extension API and Marketplace rules.

## Features (current)

- **Folder spaces**: configure any number of folders, each shown as its own root in a dedicated activity-bar view.
- **Independent panes**: up to eight panes stack in the Folder Spaces view. **Every pane is a full folder space of its own** — its own root (any folder, not only the configured spaces), view preset, path filter, sort, drill-down stack, name/icon and include/exclude rules. `Folder Spaces: Open Child Pane Here` creates a child pane rooted at the selected folder and links it to its parent.
- **Linked panes (cascading chain)**: a child pane with follow enabled tracks the folder selected in its parent pane. Turning follow off makes the pane fully independent; switching a child pane's root manually is allowed and lasts until the parent selects a different folder again.
- **View presets**: seven named presets (Explorer, Navigate, Columns, Context, Contents, Files, List) covering tree/flat modes, depth levels and folder/file content filters.
- **Navigation**: in-place drill-down with a back stack, root switching and pane title actions (show current file, collapse all, expand one level, switch mode).
- **Variables in paths**: `${workspaceFolder}`, `${workspaceFolders[N]}`, `${userHome}`.
- **Per-space options**: custom name, icon, show/hide files, include/exclude glob patterns (used as the defaults for panes created from them).
- **Native tree experience**: file icons, git decorations and problem badges come from `resourceUri`.
- **File nesting**: groups child files under their parent file inside space trees, mirroring the built-in `explorer.fileNesting.enabled` / `patterns` / `expand` settings (the extension re-reads them; nothing extra to configure).
- **Live updates**: recursive file system watchers per pane root.
- **Commands**: add/remove space, add/remove pane, open child pane, set pane root, refresh, reveal active file, reset pane layout.
- **File operations**: new file/folder, rename, delete, move-to, context actions delegated to built-in commands, drag & drop between panes, session-only cut/copy/paste, with cut/move undo. File opening defaults to the current editor group and can be configured to open beside.

## Planned

- Folder Spaces in a multi-root / remote setting, and a quick-open entry (`explorer/context` "Add to Folder Spaces").
- Optional space grouping/tags.
- CI (including Linux xvfb integration tests) and Marketplace release assets (PNG icon, screenshots, repository field).

## Known limitations

- **Glob subset**: supports `*`, `**`, `**/` (including zero directory levels), `?` and character escaping. Brace patterns (`{a,b}`) and character classes (`[abc]`) are unsupported; `src/**` does not match the `src` directory itself.
- **Clipboard and drag undo**: internal drag-and-drop moves (undoable); external items dragged in are copied (not undoable). Cut/move operations share the session undo stack; copied files/folders are not undoable. Ctrl+C/X/V, Ctrl+N, F2, Delete and Ctrl+Z bindings apply only while the Folder Spaces tree has focus.
- **Pane count and placement**: at most **eight** panes, because VS Code requires views to be declared statically (there is no API to create views at runtime). Panes stack vertically inside the Folder Spaces view and the order is fixed by the manifest; you can move any pane to the secondary side bar, the panel or a floating window yourself with the built-in `View: Move View` / drag actions, and `View: Reset View Locations` restores the default.
- **Pane model**: each pane keeps its own view state; `codeFolderSpaces.spaces` is only a list of folders to pick from (and the source of defaults for new panes), not the definition of what panes show.
- **Workspace support**: virtual workspaces are unsupported; remote scenarios have not been validated.
- **Large directories**: visible-child probing is concurrency-limited to 16. Caching has not been added yet.
- **External folders**: folders outside the workspace can be used as space or pane roots; reading and watching them have been tested.
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
