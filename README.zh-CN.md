# Folder Spaces for VS Code

**专注于文件夹范围的 VS Code 文件导航。**

Folder Spaces 在专属的 Activity Bar 容器中加入一个或两个原生树视图，让你只在自己关心的文件夹内工作，不受整个工作区的噪声干扰。它使用标准 `TreeView`：原生文件图标、Git 装饰、问题徽章、文件操作与 `workspace.fs` 支持全部保留。

[English](README.md) · [繁體中文](README.zh-TW.md) · [更新记录](CHANGELOG.md)

![Tree 模式：单窗格显示两个文件夹 root](assets/screenshots/tree-mode.png)

> **版本 0.2.1。** 支持两种布局：**Tree**（单窗格）与 **Dual**（上下两个窗格）。从 v1.x 升级前请先阅读[与 v1.x 的重大变更](#与-v1x-的重大变更)。

## 安装

**从 VS Code Marketplace 安装（推荐）**

1. 打开扩展视图（`Ctrl+Shift+X`），搜索 **Folder Spaces**，或直接打开[市场页面](https://marketplace.visualstudio.com/items?itemName=edwardsayer.folder-spaces)。
2. 选择 **Install**；如果 VS Code 提示需要重新加载窗口，照做即可。

命令行等价做法：`code --install-extension edwardsayer.folder-spaces`

**以 VSIX 文件安装**：从命令面板执行 **Extensions: Install from VSIX…**，选择 `folder-spaces-<version>.vsix`。

> VSCodium／Cursor 用户：目前尚未上架 Open VSX，请先以 VSIX 安装。

安装后点击 Activity Bar 的 **Folder Spaces** 图标，运行 **Add Folder Space…**（`codeFolderSpaces.addSpace`）选择第一个要工作的文件夹。

## 为什么使用 Folder Spaces

VS Code 内置的 Explorer 总是呈现整个工作区。Folder Spaces 让你专注于选定的文件夹——必要时还可同时专注于**第二个**文件夹——而且一切保持原生行为。

## Tree 模式

Tree 模式只有一个窗格。每个配置的 root 都是一行顶层项目，可以同时显示多个 root。

- 面板标题为容器标题 **Folder Spaces**，不设置 description。
- 每个文件夹行右侧固定有两个 inline 按钮：**就地下钻**与**启用子空间**。
- 标题栏提供**全部折叠／展开层级**、**按路径过滤／清除过滤**，以及 `…` 菜单（**双窗格**、**排序**、**添加文件夹到空间…**、**刷新**、**工作区文件夹…**）。

## Dual 模式

![Dual 模式：上方 Spaces、下方 Files](assets/screenshots/dual-mode.png)

Dual 模式上下堆叠两个窗格：

| | **Spaces**（pane1） | **Files**（pane2） |
|---|---|---|
| 角色 | 控制中心 | 次要列表 |
| 标题栏 | 全部折叠／展开层级、过滤、`…` 菜单 | 视图模式、过滤、`…` 菜单 |
| Root | 所有已配置的 root | 只显示由 pane1 联动而来的文件夹 |
| 可否关闭 | 不可 | 可；关闭后回到 Tree 模式 |

- 标题随内容变化：pane1 有多个 root 且未下钻时显示 **Spaces**，否则显示路径最后一段；pane2 显示当前文件夹。
- 在 pane1 选中**文件夹**会让 pane2 进入该文件夹（选中文件不会）。
- 文件夹行的**启用子空间**会把该文件夹设为 pane2 的 root，必要时自动开启 Dual 模式。
- pane1 与 pane2 各自记住自己的视图与排序设置。

### Files 窗格的三种视图模式

Files 窗格的**视图模式**按钮会依次循环：

| 模式 | 按钮 | 显示内容 |
|---|---|---|
| Explorer（默认） | `$(list-tree)` | 局部原生树，支持下钻与文件夹端点图标 |
| File List | `$(list-flat)` | 只列第一层文件 |
| Nested File List | `$(layers)` | 所有层级的文件，扁平呈现 |

![Explorer 模式](assets/screenshots/pane2-explorer.png)
![File List 模式](assets/screenshots/pane2-filelist.png)
![Nested File List 模式](assets/screenshots/pane2-nested-list.png)

### 双窗格具备可见性感知

`Dual Pane`／`Dual Pane ✓` 在**两个**窗格都有，且反映画面上实际可见的状态：

- 两窗格皆可见且模式为 Dual → 菜单显示 **Dual Pane ✓**；点击会关闭 Files 并回到 Tree。
- 任一个窗格在容器菜单中被隐藏 → 剩下的窗格显示未勾选的 **Dual Pane**；点击会解除隐藏并召回缺少的窗格。
- 点击标题栏折叠窗格**不等于**关闭：窗格仍然存在，再点一次就会展开。

## 菜单与勾号

![窗格标题菜单](assets/screenshots/pane-menu.png)

有状态的项目以成对命令＋**后缀 ✓** 呈现（例如 `Dual Pane ✓`），因为 VS Code 不为扩展菜单渲染原生勾号。

![排序子菜单](assets/screenshots/sort-submenu.png)

**排序**子菜单提供名称／修改时间／创建时间的升序与降序，两个窗格各自记住选择。容器的 `…` 菜单列出视图（**Spaces**、**Files**），可分别隐藏。

![容器菜单列出两个视图](assets/screenshots/title-menu.png)

## 过滤

![应用过滤后的树与匹配数](assets/screenshots/filter-mode.png)

**按路径过滤…** 对窗格应用路径子串过滤，并显示 `n / m matches` 计数与 inline 的**清除过滤**按钮。`include`／`exclude` 支持的 glob 子集包含 `*`、`**`、`**/`、`?` 与字符转义；不支持 brace `{a,b}` 与 character class `[abc]`。

## 空间 root 的来源

root 刻意分成三个来源：

1. **工作区根** — 自动来自当前 VS Code 工作区，可用**工作区文件夹…**隐藏或还原。
2. **`codeFolderSpaces.spaces.workspace`** — 项目层列表，写入 `.vscode/settings.json` 或 `.code-workspace` 文件。
3. **`codeFolderSpaces.spaces.global`** — profile 层列表，存于用户 `settings.json`，在该 profile 的每个窗口都显示，并标记 **🌐**。

在 root 上使用**标记为全局**／**取消全局**即可在项目列表与全局列表之间移动。设置是 per-profile 的，其他 profile 需要各自设置（或使用 Settings Sync）。

## 文件操作

![Root 右键菜单：标记为全局与文件操作](assets/screenshots/context-menu.png)

- 新建、重命名、删除、移动、拖放，以及本次会话内的移动／重命名 undo。
- 修改磁盘的命令受 Workspace Trust 管制：工作区尚未受信任时一律停用。
- 启用 `files.enableTrash` 时，`file:` URI 的删除会走回收站；其他 scheme 一律拒绝而非永久删除。
- 文件监视器会即时更新窗格，包含工作区外的文件夹。

## 设置

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `codeFolderSpaces.spaces.workspace` | array | `[]` | 项目／工作区层 root；项目可为路径字符串或对象。 |
| `codeFolderSpaces.spaces.global` | array | `[]` | Profile 层 root（**标记为全局**的目标）；只写用户设置。 |
| `codeFolderSpaces.followActiveFile` | boolean | `true` | 跟随当前编辑器中的文件。 |
| `codeFolderSpaces.maxDepth` | integer (1–100) | `10` | 扁平列表枚举的最大文件夹深度。 |
| `codeFolderSpaces.followWorkspaceDirectory` | boolean | `true` | 让 pane1 的工作区 root 与工作区文件夹同步；已配置与全局 root 会保留并附加在后。 |
| `codeFolderSpaces.defaultPreset.singlePane` | string | `Explorer` | 切换到 Tree 模式时使用的视图。 |
| `codeFolderSpaces.defaultPreset.dualPane.pane1` | string | `Navigate` | 进入 Dual 模式时 Spaces 使用的视图。 |
| `codeFolderSpaces.defaultPreset.dualPane.pane2` | string | `Explorer` | 进入 Dual 模式时 Files 使用的视图。 |

root 项目可为路径字符串，或含 `path`、`name`、`icon`、`showFiles`、`include`、`exclude` 的对象。路径支持 `${workspaceFolder}`、`${workspaceFolders[N]}`、`${userHome}`。

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

## 常用命令

多数窗格操作位于标题栏、`…` 菜单、**排序**子菜单或右键菜单，并刻意从命令面板隐藏。

- **就地下钻**、**启用子空间** — pane1 每个文件夹行的 inline 按钮。
- **添加文件夹到空间…** — 单一可搜索菜单，含最近文件夹与**浏览文件夹…**；也可直接输入路径。
- **移除 Root**、**工作区文件夹…**、**刷新**。
- **双窗格**／**双窗格 ✓**、**关闭窗格**。
- **全部折叠**、**展开层级**、**按路径过滤…**、**清除过滤**、**返回上层**。
- **视图模式** — Files 窗格：Explorer／File List／Nested File List。
- **标记为全局**、**取消全局**。
- **打开工作区**、**在新窗口打开工作区** — `.code-workspace` 行的 inline 按钮。

目前 manifest 贡献 **86** 个命令，全部由命令 parity 检查覆盖。

## 文件嵌套

文件嵌套依 VS Code 自身的 `explorer.fileNesting.enabled`、`patterns`、`expand` 设置运作。仅应用于同目录的兄弟文件，每个文件最多一个父项，且路径过滤启用时停用嵌套。请注意 Global 与 Workspace 范围的 `explorer.fileNesting.patterns` 会与内置默认值**合并**。

## 已知限制

- pane1 不可关闭；关闭 pane2 会回到 Tree 模式。
- glob 为子集（`*`、`**`、`**/`、`?`、转义）；`src/**` 不匹配 `src` 文件夹本身。
- 移动防护采词法路径比较，不解析 symlink。
- 不支持虚拟工作区；远程环境尚未完整验证。
- 窗格标题受 VS Code 原生 `text-transform: capitalize` 影响，扩展无法覆盖。

## 与 v1.x 的重大变更

0.1.0 版以固定的 **Tree** 与 **Dual** 布局取代旧的多窗格／preset 模型，移除旧 `codeFolderSpaces.spaces` 设置且**不迁移**其值，同时移除 preset 控件与多项设置。完整列表见 [CHANGELOG.md](CHANGELOG.md)。

## 开发

```bash
npm install
npm run check          # typecheck、单元测试、build、项目检查与命令 parity
npm run watch          # esbuild watch
npm run package:vsix   # production bundle + vsce package
```

按 F5（**Run Extension**）或加载到隔离窗口：

```bash
npm run vscode:debug -- --extension ./code-folder-spaces
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
