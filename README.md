# Task Kanban

**English** | [Українська](README.uk.md)

A VS Code extension that shows a kanban board of tasks for `<Name>Add` companion folders — folders next to a
project's source code that hold its documentation and task materials. Columns are stage folders
`Tasks/<stage>/`, cards are task folders `Tasks/<stage>/<number>/`. Dragging a card moves the task folder,
updates the status line in `task.md` and runs the configured actions: a file check and a commit of the task's files.

Plain JavaScript, no dependencies and no build step — VS Code loads the folder as is.

> The UI is in Ukrainian. Labels below are quoted as they appear, with a translation in parentheses.

## Task layout

```
<Name>Add/
├── .vscode/settings.json   ← board settings (taskKanban.*)
└── Tasks/
    ├── _template/          ← new task template (`<номер>` in its files is replaced with the task number)
    ├── 1_new/  2_queue/  3_work/  4_testing/  5_done/   ← stages
    │   └── <number>/
    │       ├── task.md     ← description; a "- **Статус:** …" line or a "## Статус" section (status)
    │       ├── notes.md
    │       └── …           ← artifacts: path.sql, task_<number>.v<N>.zip, delphi/ …
```

## Installation

**`.vsix` package** — for any machine; the source folder is not needed after installation:

```powershell
powershell -ExecutionPolicy Bypass -File .\pack.ps1      # → dist\task-kanban-<version>.vsix (no Node required)
code --install-extension dist\task-kanban-<version>.vsix  # or Extensions → … → Install from VSIX
```

Files excluded from the package are listed in `.vscodeignore`. Bump `version` in `package.json` before each new
build, otherwise VS Code treats the package as already installed.

**Link to the source folder** — for development: code changes are picked up after `Developer: Reload Window`.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1   # junction in ~/.vscode/extensions
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Do not combine the two: remove the junction (`-Uninstall`) before `--install-extension`, otherwise VS Code
writes the package through the link straight into the source folder.

## Moving to another project or machine

- The extension is installed once per VS Code and works in any workspace that contains `Tasks/_template`.
- New project: create `Tasks/_template/` and the stage folders (`1_new` … `5_done`) plus `.vscode/settings.json`
  with `taskKanban.transitions` (example below). Different stages — override `taskKanban.stages`.
- Write `repo` paths **relative to the workspace root** (`"../ultra-delphi"`), not absolute — the settings then
  work on any drive as long as `<Name>Add` and the code sit side by side.
- Settings Sync does not carry extensions that are not from the Marketplace — install the `.vsix` on each machine.
- Commits from the board need git `user.name` and `user.email` to be set.

## Usage

- Board: the **Задачі** (Tasks) button in the status bar, or the command `Task Kanban: Відкрити дошку` (Open board).
- Drag a card to another column to move the task.
- Click a card to open `task.md`; ✎ opens `notes.md`; 📁 reveals the folder in the Explorer.
- Click a column header to collapse/expand it.
- `+ Задача` (+ Task) / `Task Kanban: Нова задача` (New task) creates a folder from `Tasks/_template` in the first stage.
- A yellow «статус: …» (status) badge means the status in `task.md` does not match the stage.
- Task folders placed directly in `Tasks/` (outside any stage) appear in the «Без етапу» (No stage) column.
- Action log: Output panel → «Task Kanban».

## Settings

In `.vscode/settings.json` of the `<Name>Add` folder.

| Setting | Default | Meaning |
|---|---|---|
| `taskKanban.tasksDir` | `Tasks` | tasks folder |
| `taskKanban.templateDir` | `_template` | new task template inside `tasksDir` |
| `taskKanban.stages` | `1_new` … `5_done` | columns: `dir`, `title`, `status` (value written to `task.md`), `collapsed` |
| `taskKanban.commitMessage` | `{number}` | commit message: `{number}`, `{stage}`, `{status}`, `{title}` |
| `taskKanban.transitions` | `[]` | actions on move |

### Transitions

```jsonc
"taskKanban.transitions": [
  {
    "from": "*",               // stage dir or *
    "to": "4_testing",
    "actions": [
      // before the move: warn if the task folder has no files matching the masks
      { "type": "check", "files": ["task_*.zip"] },
      // after the move: commit the task's changed files in the companion folder's repository
      { "type": "commit", "name": "UltraAdd",
        "paths": ["Tasks/*/{number}/**", "Obsidian/Tasks/{number}.md"] },
      // and the code: files from Tasks/<stage>/<number>/delphi/ are looked up in the repository by name
      { "type": "commit", "name": "ultra-delphi", "repo": "../ultra-delphi", "sourceDir": "delphi" }
    ]
  }
]
```

- `repo` — repository path (relative paths resolve from the workspace root; defaults to the workspace itself).
- `paths` — git glob pathspecs relative to the repository root; `{number}` is the task number.
- `sourceDir` — a task subfolder; each file in it is looked up in the repository by file name
  (case-insensitive), and only changed files are committed.
- Before committing, a checklist of files is shown; Esc skips the commit (the move stays).
- **Only** the selected files are committed (`git commit --only`): other changes, even staged ones, stay out.
- A folder that is not a git repository is skipped with a warning. Nothing is pushed.

## Development

```
extension.js     — activation, panel, commands, moves and commits (vscode API)
src/core.js      — logic without vscode: scanning, status in task.md, moving, git
media/board.*    — the board webview
test/            — tests for src/core.js (node:test)
```

Debugging: open this folder in VS Code and press `F5` («Run Extension») — a new window opens with
`../UltraAdd`; to use another folder, change `args` in `.vscode/launch.json`.

Tests (no separate Node install needed — the one bundled with VS Code is used):

```bash
ELECTRON_RUN_AS_NODE=1 "<VS Code folder>/Code.exe" test/core.test.js
```
