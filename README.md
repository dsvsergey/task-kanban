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

## Installing on another computer

The extension is not on the Marketplace; it is installed from a `.vsix` file. Node.js is **not** required.

**Requirements:** Windows, VS Code 1.85+, Git (for commits from the board), PowerShell 5.1+ (built into Windows).

### 1. Get the `.vsix`

- **From a release** (if one is published): open
  [Releases](https://github.com/dsvsergey/task-kanban/releases), download `task-kanban-<version>.vsix`
  and go to step 2.
- **Build it from source:**

  ```powershell
  git clone https://github.com/dsvsergey/task-kanban.git
  cd task-kanban
  powershell -ExecutionPolicy Bypass -File .\pack.ps1   # → dist\task-kanban-<version>.vsix
  ```

  Without Git: on GitHub click **Code → Download ZIP**, extract it, and run `pack.ps1` in the extracted folder.

### 2. Install it

```powershell
code --install-extension dist\task-kanban-<version>.vsix
```

Or in VS Code: **Extensions** view → `…` menu → **Install from VSIX…** → pick the file.
Then run `Developer: Reload Window`.

### 3. Set up the project

1. Open the `<Name>Add` folder in VS Code (it must contain `Tasks/_template/`).
2. Create the stage folders `Tasks/1_new` … `Tasks/5_done` (or define your own in `taskKanban.stages`).
3. Add `.vscode/settings.json` with `taskKanban.transitions` — see [Transitions](#transitions); keep `repo`
   paths relative (`"../my-code"`).
4. Make sure Git knows who you are: `git config --global user.name "…"` and `git config --global user.email "…"`.
5. Click **Проекти** (Projects) in the status bar.

### Update and removal

- **Update:** `git pull` (or download a new release), bump `version` in `package.json` if you changed the code
  yourself, rebuild with `pack.ps1` and install the new `.vsix` — VS Code replaces the old version.
- **Remove:** `code --uninstall-extension local.task-kanban` or **Uninstall** in the Extensions view.

Files excluded from the package are listed in `.vscodeignore`.

## Development install

**Link to the source folder** — code changes are picked up after `Developer: Reload Window`.

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

## Projects and the dashboard

Every project has its own kanban board and its own folder structure; the **dashboard** lists all projects and
is the entry point.

- Projects are described in `taskKanban.projects`: `id` (permanent), `title`, `description`, `aliases` (other
  names of the same project used in tasks), `color` (`blue`, `green`, `purple`, `orange`, `red`, `yellow` — theme
  chart colors — or `#rrggbb`), and:
  - `tasksDir` — the project's **own tasks folder**, relative to the workspace, may be outside it
    (`../projAdd/Tasks`): `<tasksDir>/<stage>/<number>/`. Every task in it belongs to the project;
  - `stages` — the project's **own columns** (like `taskKanban.stages`); without them — the shared columns;
  - `templateDir` — new-task template inside the project folder (default `_template`; if missing — the shared
    `Tasks/_template`);
  - `transitions` — the project's own move actions (without them: a project in the shared folder uses the shared
    ones, a project with its own folder has none; `repo` is relative to the workspace, `{tasksRoot}` is the
    project's tasks folder).
- A project **without** `tasksDir` shares the `taskKanban.tasksDir` folder and the shared columns with other such
  projects; their tasks are split by the `- **Проекти:** …` (Projects) line of `task.md` (match by `id`, `title`
  or alias, case-insensitive; notes in parentheses and `code` are ignored; a comma inside parentheses does not
  split the list). Names found in tasks but not in the settings are shown too (dashed card; ＋ adds them). While
  the shared folder belongs to no project, the dashboard also has «Усі задачі» (All tasks) and «Без проекту»
  (No project) cards.
- Another project's folder inside the shared one (`Tasks/<project>/`) is neither a stage nor a task.
- `+ Проект` (+ Project) suggests `../<id>Add/Tasks` (when the workspace is a `<Name>Add` folder) or `Tasks/<id>`
  and creates it: stage folders (a copy of the shared columns) and `_template` (a copy of the shared one).

```jsonc
"taskKanban.projects": [
  // the shared Tasks/ folder belongs to Ultra, columns are the shared taskKanban.stages
  { "id": "ultra", "title": "Ultra", "tasksDir": "Tasks", "aliases": ["ultra-delphi"], "color": "blue" },
  // its own folder next door, its own columns and commits to its own repository
  { "id": "task-kanban", "title": "task-kanban", "color": "purple",
    "tasksDir": "../task-kanbanAdd/Tasks",
    "stages": [ { "dir": "1_new", "title": "New", "status": "new" }, { "dir": "5_done", "title": "Done", "status": "done" } ],
    "transitions": [ { "to": "*", "actions": [ { "type": "commit", "repo": "../task-kanbanAdd",
      "paths": ["Tasks/*/{number}/**"] } ] } ] }
]
```

**Dashboard** (`Проекти` button in the status bar, `Task Kanban: Дашборд проектів`):

- totals: projects, active tasks, done tasks, total effort (sum of the `Трудомісткість` field);
- a card per project: active / total / done tasks, effort, distribution of tasks across columns (hover a segment
  for the number), the latest active tasks (click — `task.md`), last update time;
- «Усі задачі» (All tasks) and «Без проекту» (No project — tasks without a Projects line) cards;
- click a card or «Дошка →» (Board) — open the project's board in its own tab; `+ Задача` — new task in the project;
- `+ Проект` (+ Project) — title → tasks folder → aliases → description → color → id; ✎ edit (changing the folder
  does not move tasks), ✕ remove from the settings (tasks and folders stay); search by title, id, alias, description.

"Done" tasks are those in columns marked `"done": true` in `taskKanban.stages`; if none is marked — collapsed
columns and the last column.

## Subtasks

A large task can be split into subtasks. A subtask is an ordinary task: its own `<stage>/<number>/` folder,
its own `task.md` and column, dragged on its own. The link is kept by wiki links `[[number]]` in both
`task.md` files — visible and editable as plain text; in Obsidian `[[00003]]` leads to the task's note:

```markdown
# Task 00003                                # Task 00003.1
- **Статус:** в роботі                      - **Статус:** нове
                                            - **Батьківська задача:** [[00003]]
## Підзадачі
- [x] [[00003.1]] Data model                ## Description
- [ ] [[00003.2]] Card on the board         Data model
- [ ] Documentation         ← plan item
```

- ⊕ on a card — a new subtask (description → number, `<number>.1`, `.2`… suggested; a tracker number is fine
  too), or, when the «Підзадачі» (Subtasks) section has items without links, **split by plan**: subtasks are
  created from the checked items and `[[number]]` is written into them. A subtask is created from the template
  in the first column of the same tasks folder; the Projects line is copied from the parent.
- The parent card shows `☑ 1/3` (subtasks in done columns); a click expands the list of subtasks with their
  columns, a click on a subtask shows its card. `☐ план 2` — plan items without tasks yet.
- A subtask card shows `↑ 00003` (click — show the parent) and a stripe on the left.
- When a subtask moves into a done column, its item in the parent gets `[x]`; moving back clears it.
  Moving a parent with unfinished subtasks into a done column asks for confirmation.
- `[[number]]` in markdown files of the tasks folder is a clickable link (Ctrl+click) to that task's `task.md`.
- The link may also be written by hand: the `- **Батьківська задача:** [[00003]]` (parent task) field (or just
  `00003`) in the subtask, or a `- [ ] [[00003.1]]` item in the parent's section — either one is enough. If they
  disagree, the subtask's field wins. Field and section names: `taskKanban.parentField`,
  `taskKanban.subtasksHeading` (a `Subtasks` section is always recognized).

## Usage

- Dashboard: the **Проекти** (Projects) button in the status bar, or `Task Kanban: Дашборд проектів`.
  Project board: from the dashboard or `Task Kanban: Відкрити дошку проекту` (Open project board).
  «← Проекти» on a board returns to the dashboard.
- ⇄ on a card — move the task to another project: the task folder moves into that project's tasks folder (same
  column if it exists there, otherwise you pick one); the status and the Projects line are updated.
- 🏷 on a card (shared folder only) — choose the task's projects in the Projects line (several allowed; notes in
  parentheses are preserved). Chips of the task's *other* projects open their boards.
- Column controls (◀ ▶ ✎ ＋ ✕, `+ Колонка`) on a board of a project with its own folder change that project's
  `stages` and folders; on other boards — the shared `taskKanban.stages`.
- `+ Задача` (+ Task) creates the folder in the project's first column from its template and writes the project
  into the Projects line; on the «All tasks» board the project is asked for.
- Drag a card to another column to move the task.
- Click a card to open `task.md`; ✎ opens `notes.md`; 📁 reveals the folder in the Explorer.
- 🗑 on a card deletes the task: after confirmation the task folder goes to the Recycle Bin (restore it from there);
  if the Recycle Bin is unavailable, permanent deletion is offered. The `[[number]]` item is removed from the parent
  task's «Підзадачі» (Subtasks) section. If the task has subtasks you choose: keep them as standalone tasks (their
  «Батьківська задача» field is removed) or delete them too. A folder held by a terminal or another program is left
  untouched; task files with unsaved changes must be saved or closed first. Deletion is not committed.
- 💬 lists the Claude Code sessions in which the task was worked on (found by the task number in your prompts;
  ★ — the session started with this task) and opens the chosen one in the Claude Code extension, or in a
  terminal with `claude --resume <id>` if the extension is not installed (`taskKanban.sessionOpenIn`). Also:
  `Task Kanban: Сесії Claude Code задачі` (Claude Code sessions of a task).
- Click a column header to collapse/expand it.
- **Columns** (hover a column header): ◀ ▶ move it, ✎ rename it and change its `task.md` status, ＋ add a
  column to the right, ✕ delete it (only an empty one; its folder is removed if nothing but `.gitkeep` is left).
  `+ Колонка` (+ Column) in the toolbar adds a column at a chosen position: title → folder (suggested from the
  title, e.g. «Архів» → `6_arkhiv`) → status. Changes are saved to `taskKanban.stages` in the project's
  `.vscode/settings.json`; until then the default five columns are used. `Task Kanban: Повернути стандартні
  колонки` (Reset columns) removes the override.
- `+ Задача` (+ Task) / `Task Kanban: Нова задача` (New task) creates a folder from `Tasks/_template` in the first stage.
  The ↑ button in the number box fills in the next number: the largest numeric task number of the folder + 1, keeping
  leading zeros (`00006` → `00007`; subtasks like `00003.1` and non-numeric numbers are ignored). A number that
  already exists is rejected.
- A yellow «статус: …» (status) badge means the status in `task.md` does not match the stage.
- A «⏱ 3:20» chip shows the effort from the `- **Трудомісткість:** 3:20` line of `task.md` — the total time to
  report to the customer (field name: `taskKanban.effortField`).
- Task folders placed directly in `Tasks/` (outside any stage), or in a stage folder that is no longer in the
  column list, appear in the «Без етапу» (No stage) column; drag them to a column to file them.
- Action log: Output panel → «Task Kanban».

## Settings

In `.vscode/settings.json` of the `<Name>Add` folder.

| Setting | Default | Meaning |
|---|---|---|
| `taskKanban.tasksDir` | `Tasks` | tasks folder |
| `taskKanban.templateDir` | `_template` | new task template inside `tasksDir` |
| `taskKanban.effortField` | `Трудомісткість` | `task.md` field shown on the card as a ⏱ chip; empty — hide |
| `taskKanban.sessionOpenIn` | `auto` | where 💬 opens a session: `auto` (extension, else terminal), `extension`, `terminal` |
| `taskKanban.stages` | `1_new` … `5_done` | columns: `dir`, `title`, `status` (value written to `task.md`), `collapsed`, `done` |
| `taskKanban.projects` | `[]` | projects: `id`, `title`, `description`, `aliases`, `color`, `tasksDir`, `stages`, `templateDir`, `transitions` — see [Projects](#projects-and-the-dashboard) |
| `taskKanban.projectField` | `Проекти` | `task.md` field with the task's projects |
| `taskKanban.parentField` | `Батьківська задача` | subtask's `task.md` field with the `[[number]]` link to its parent |
| `taskKanban.subtasksHeading` | `Підзадачі` | `task.md` section with the list of subtasks and the split plan |
| `taskKanban.commitMessage` | `{number}` | commit message: `{number}`, `{stage}`, `{status}`, `{title}` |
| `taskKanban.accumulateCommits` | `true` | accumulate a task's commits: a move amends the task's last unpushed commit |
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
- A task's commits accumulate (`taskKanban.accumulateCommits`): if the repository's last commit has the same
  message (same task), is not pushed to a remote, is not a merge and HEAD is on a branch, the move amends it
  (`git commit --amend --only`) instead of adding a new one. The file list title shows "new" or "amend <hash>".
  Another task's commit or a `push` in between means a new commit.
- A folder that is not a git repository is skipped with a warning. Nothing is pushed.

## Development

```
extension.js     — activation, panel, commands, moves and commits (vscode API)
src/core.js      — logic without vscode: scanning, status in task.md, projects, moving, git
media/board.*    — the board webview
media/dashboard.* — the projects dashboard webview
test/            — tests for src/core.js (node:test)
```

Debugging: open this folder in VS Code and press `F5` («Run Extension») — a new window opens with
`../UltraAdd`; to use another folder, change `args` in `.vscode/launch.json`.

Tests (no separate Node install needed — the one bundled with VS Code is used):

```bash
ELECTRON_RUN_AS_NODE=1 "<VS Code folder>/Code.exe" test/core.test.js
```

Integration test in a real VS Code (separate profile and a temporary workspace; a window opens for a few
seconds): checks activation, setting declarations, writing `taskKanban.stages` to `settings.json` and commands.

```powershell
powershell -ExecutionPolicy Bypass -File .\test\integration\run.ps1
```

## License

[MIT](LICENSE) © 2026 Sergey Dobrovolskj
