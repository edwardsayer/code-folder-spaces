# Folder Spaces for VS Code

**Folder-scoped file explorer spaces for Visual Studio Code.** Pin any folder as its own focused explorer space and browse it without the noise of the whole workspace.

> **Status: early scaffold (v0.0.1).** The extension currently provides the configuration model, a dedicated activity-bar view, a folder-scoped tree with optional files, include/exclude filtering, refresh and reveal-active-file commands. View modes, drill-down, drag & drop and file operations are planned next.

## Why

VS Code's built-in Explorer always shows the entire workspace. When a repository contains many projects, packages or archive folders, finding the one folder you actually care about becomes slow and noisy. Folder Spaces gives each folder its own focused tree — same workspace, smaller context.

This project is the VS Code counterpart of the Obsidian plugin [Folder Spaces](https://github.com/edwardsayer/obsidian-folder-spaces), adapted to the VS Code Extension API and Marketplace rules.

## Features (current)

- **Folder spaces**: configure any number of folders, each shown as its own root in a dedicated activity-bar view.
- **Variables in paths**: `${workspaceFolder}`, `${workspaceFolders[N]}`, `${userHome}`.
- **Per-space options**: custom name, icon, show/hide files, include/exclude glob patterns.
- **Native tree experience**: file icons, git decorations and problem badges come from `resourceUri`.
- **Live updates**: recursive file system watchers per space.
- **Commands**: add space, remove space, refresh, reveal active file.

## Planned

- Tree / flat view modes with depth limits and content filters (folder-only, file-only).
- Named view presets (Explorer, Navigate, Columns, Context, Contents, Files, List).
- In-place drill-down with a back stack; root switcher and inline root rename.
- Full context actions (new file/folder, rename, delete, reveal in OS, open in terminal, copy path).
- Drag & drop between spaces, with undo for supported operations.
- Linked spaces as stacked panes: the default layout shows two identical panes (parent above, child below) that follow each other, forming a cascading chain — the product's signature interaction. The "files pane" effect comes from view presets (Files / Contents / List flat lists) instead of a webview.
- Full Traditional Chinese / English localization.

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
