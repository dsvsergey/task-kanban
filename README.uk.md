# Task Kanban

[English](README.md) | **Українська**

Розширення VS Code: канбан-дошка задач для супровідних каталогів `<Name>Add` — каталогів поруч із кодом проекту,
де ведуться документація і задачі. Колонки — каталоги етапів `Tasks/<етап>/`, картки — каталоги задач
`Tasks/<етап>/<номер>/`. Перетягування картки переносить каталог задачі, оновлює рядок «Статус» у `task.md`
і запускає налаштовані дії: перевірку файлів і коміт файлів задачі.

Чистий JavaScript без залежностей і без збірки — VS Code завантажує каталог як є.

## Структура задач

```
<Name>Add/
├── .vscode/settings.json   ← налаштування дошки (taskKanban.*)
└── Tasks/
    ├── _template/          ← шаблон нової задачі (`<номер>` у файлах замінюється на номер)
    ├── 1_new/  2_queue/  3_work/  4_testing/  5_done/   ← етапи
    │   └── <номер>/
    │       ├── task.md     ← опис; рядок «- **Статус:** …» або розділ «## Статус»
    │       ├── notes.md
    │       └── …           ← артефакти: path.sql, task_<номер>.v<N>.zip, delphi/ …
```

## Встановлення на іншому комп'ютері

Розширення немає в маркетплейсі — його ставлять з файла `.vsix`. Node.js **не** потрібен.

**Потрібно:** Windows, VS Code 1.85+, Git (для комітів з дошки), PowerShell 5.1+ (є у Windows).

### 1. Отримати `.vsix`

- **З релізу** (якщо опубліковано): відкрити
  [Releases](https://github.com/dsvsergey/task-kanban/releases), завантажити `task-kanban-<версія>.vsix`
  і перейти до кроку 2.
- **Зібрати з коду:**

  ```powershell
  git clone https://github.com/dsvsergey/task-kanban.git
  cd task-kanban
  powershell -ExecutionPolicy Bypass -File .\pack.ps1   # → dist\task-kanban-<версія>.vsix
  ```

  Без Git: на GitHub **Code → Download ZIP**, розпакувати і запустити `pack.ps1` у розпакованому каталозі.

### 2. Встановити

```powershell
code --install-extension dist\task-kanban-<версія>.vsix
```

Або у VS Code: панель **Extensions** → меню `…` → **Install from VSIX…** → вибрати файл.
Потім `Developer: Reload Window`.

### 3. Налаштувати проект

1. Відкрити у VS Code каталог `<Name>Add` (у ньому має бути `Tasks/_template/`).
2. Створити каталоги етапів `Tasks/1_new` … `Tasks/5_done` (або задати свої в `taskKanban.stages`).
3. Додати `.vscode/settings.json` з `taskKanban.transitions` — див. [Переходи](#переходи); шляхи `repo`
   писати відносні (`"../my-code"`).
4. Перевірити, що git знає автора: `git config --global user.name "…"` і `git config --global user.email "…"`.
5. Натиснути **Задачі** в рядку стану.

### Оновлення і видалення

- **Оновити:** `git pull` (або завантажити новий реліз), якщо код змінювали самі — підняти `version`
  у `package.json`, перезібрати `pack.ps1` і встановити новий `.vsix` — VS Code замінить стару версію.
- **Видалити:** `code --uninstall-extension local.task-kanban` або **Uninstall** на панелі Extensions.

Що не пакується — `.vscodeignore`.

## Встановлення для розробки

**Посилання на каталог** — зміни в коді підхоплюються після `Developer: Reload Window`.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1   # junction у ~/.vscode/extensions
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Обидва способи разом не використовувати: перед `--install-extension` прибрати junction (`-Uninstall`),
інакше VS Code писатиме пакет крізь посилання прямо в каталог з кодом.

## Перенесення на інший проект або комп'ютер

- Розширення одне на VS Code; працює в будь-якій робочій області, де є `Tasks/_template`.
- Новий проект: каталоги `Tasks/_template/` і етапів (`1_new` … `5_done`) + `.vscode/settings.json` з
  `taskKanban.transitions` (приклад — нижче). Інші етапи — перевизначити `taskKanban.stages`.
- `repo` у налаштуваннях писати **відносно кореня робочої області** (`"../ultra-delphi"`), а не абсолютно —
  тоді налаштування працюють на будь-якому диску, поки `<Name>Add` і код лежать поруч.
- Settings Sync не переносить розширення не з маркетплейсу — `.vsix` ставити на кожному комп'ютері.
- Для комітів з дошки в git мають бути задані `user.name` і `user.email`.

## Використання

- Дошка: кнопка **Задачі** в рядку стану або команда `Task Kanban: Відкрити дошку`.
- Перетягнути картку в іншу колонку — перенести задачу.
- Клік по картці — `task.md`; ✎ — `notes.md`; 📁 — показати в провіднику.
- Клік по заголовку колонки — згорнути/розгорнути.
- **Колонки** (навести на заголовок колонки): ◀ ▶ — переставити, ✎ — змінити назву і статус для `task.md`,
  ＋ — додати колонку праворуч, ✕ — видалити (лише порожню; каталог видаляється, якщо в ньому лишився тільки
  `.gitkeep`). `+ Колонка` на панелі вгорі додає колонку у вибране місце: назва → каталог (пропонується з
  назви, напр. «Архів» → `6_arkhiv`) → статус. Зміни зберігаються в `taskKanban.stages` у `.vscode/settings.json`
  проекту; доти діють стандартні п'ять колонок. `Task Kanban: Повернути стандартні колонки` прибирає
  перевизначення.
- `+ Задача` / `Task Kanban: Нова задача` — каталог із `Tasks/_template` у першому етапі.
- Жовтий бейдж «статус: …» — статус у `task.md` не збігається з етапом.
- Каталоги задач просто в `Tasks/` (поза етапами) або в каталозі етапу, якого вже немає в списку колонок,
  показуються в колонці «Без етапу»; звідти їх перетягують у потрібну колонку.
- Журнал дій — панель Output → «Task Kanban».

## Налаштування

У `.vscode/settings.json` каталогу `<Name>Add`.

| Параметр | За замовчуванням | Що |
|---|---|---|
| `taskKanban.tasksDir` | `Tasks` | каталог задач |
| `taskKanban.templateDir` | `_template` | шаблон нової задачі всередині `tasksDir` |
| `taskKanban.stages` | `1_new` … `5_done` | колонки: `dir`, `title`, `status` (значення для `task.md`), `collapsed` |
| `taskKanban.commitMessage` | `{number}` | повідомлення коміту: `{number}`, `{stage}`, `{status}`, `{title}` |
| `taskKanban.transitions` | `[]` | дії при перенесенні |

### Переходи

```jsonc
"taskKanban.transitions": [
  {
    "from": "*",               // dir етапу або *
    "to": "4_testing",
    "actions": [
      // до перенесення: попередити, якщо в каталозі задачі немає файлів за масками
      { "type": "check", "files": ["task_*.zip"] },
      // після перенесення: закомітити змінені файли задачі в репозиторій супровідного каталогу
      { "type": "commit", "name": "UltraAdd",
        "paths": ["Tasks/*/{number}/**", "Obsidian/Tasks/{number}.md"] },
      // і код: файли з Tasks/<етап>/<номер>/delphi/ шукаються в репозиторії за іменем
      { "type": "commit", "name": "ultra-delphi", "repo": "../ultra-delphi", "sourceDir": "delphi" }
    ]
  }
]
```

- `repo` — шлях до репозиторію (відносний — від кореня робочої області; за замовчуванням сама робоча область).
- `paths` — git-маски (glob) відносно кореня репозиторію; `{number}` — номер задачі.
- `sourceDir` — підкаталог задачі; кожен файл звідти шукається в репозиторії за іменем файла (без урахування
  регістру), комітяться лише змінені.
- Перед комітом показується список файлів з галочками; Esc — не комітити (перенесення лишається).
- Комітяться **лише** вибрані файли (`git commit --only`): чужі зміни, навіть проіндексовані, у коміт не потрапляють.
- Репозиторій без git — попередження і пропуск. `push` не робиться.

## Розробка

```
extension.js     — активація, панель, команди, перенесення і коміти (vscode API)
src/core.js      — логіка без vscode: сканування, статус у task.md, перенесення, git
media/board.*    — дошка у webview
test/            — тести src/core.js (node:test)
```

Налагодження: відкрити цей каталог у VS Code, `F5` (конфігурація «Run Extension») — відкриється нове вікно
з `../UltraAdd`; інший каталог — змінити `args` у `.vscode/launch.json`.

Тести (Node окремо не потрібен — використовується вбудований у VS Code):

```bash
ELECTRON_RUN_AS_NODE=1 "<каталог VS Code>/Code.exe" test/core.test.js
```

## Ліцензія

[MIT](LICENSE) © 2026 Sergey Dobrovolskj
