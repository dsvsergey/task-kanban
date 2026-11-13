---
name: task-kanban-dev
description: "Розробка розширення VS Code task-kanban: де що лежить (extension.js, src/core.js, media/*), тести core через Node з VS Code, інтеграційний тест у справжньому VS Code, збірка .vsix без Node (pack.ps1), встановлення для розробки (install.ps1), реліз на GitHub і типові пастки (scope resource, ELECTRON_RUN_AS_NODE, webview CSP). Вмикати, коли треба змінити код розширення, додати налаштування чи команду, запустити тести, зібрати або випустити нову версію."
---

# Розробка task-kanban

## Структура

```
extension.js        — активація, webview-панелі, команди, перенесення задач, коміти (vscode API)
src/core.js         — логіка без vscode: сканування Tasks/, task.md (статус, поля, підзадачі), проекти
                      (buildBoards), перенесення, git, пошук сесій Claude Code
media/board.*       — дошка проекту (webview)
media/dashboard.*   — дашборд проектів (webview)
test/core.test.js   — тести core (node:test)
test/integration/   — run.ps1 + index.js: перевірка в справжньому VS Code
pack.ps1            — збірка dist/<name>-<version>.vsix (.NET zip, без Node/vsce)
install.ps1         — junction у ~/.vscode/extensions для розробки
workspace/          — універсальний робочий каталог користувача: AGENTS.md, settings.yaml, дошка,
                      скіли kanban-*, Tasks/_template, Obsidian-vault (див. нижче)
new-workspace.ps1   — розгортає workspace/ у каталог користувача (наявні файли не перезаписує)
```

Активація — `workspaceContains:Tasks/_template`. Видавець — `local`, id — `local.task-kanban`.

## Де робити зміну

- Розбір/запис `task.md`, правила сканування, git — `src/core.js` + тест у `test/core.test.js`.
- Нова команда — `package.json` (`contributes.commands`) + реєстрація в `extension.js` + перевірка в
  `test/integration/index.js` (список команд).
- Нове налаштування — `package.json` (`contributes.configuration`, **`"scope": "resource"`**), читання через
  `getConfiguration('taskKanban', folder.uri)`; запис — у `WorkspaceFolder`; перевірка запису — в інтеграційному
  тесті; рядок у таблиці «Налаштування» обох README.
- Поле `task.md` (як `Трудомісткість`, `Проекти`, `Батьківська задача`) — назва з налаштування з дефолтом,
  не літерал у кількох місцях.
- Webview: дані — лише `textContent`; скрипти з nonce; повідомлення з webview валідувати в `extension.js`
  (шляхи — тільки всередині каталогу задач).

## Набір workspace/

Робочий каталог для користувачів — універсальний: жодних назв проектів, мов програмування, шляхів.
Специфіку проекту користувача агент веде в його vault (`Правила (<id>)`), не в наборі.

- Зміна формату `task.md`, полів, колонок, `transitions`, поведінки дошки → оновити `kanban-tasks` (і
  `kanban-workflow`, якщо зачіпає процес); нове поле — в `Tasks/_template/task.md`.
- `.vscode/settings.json` набору — JSONC; колонки агента (`2_ai`, `3_ai_done`) мають збігатися з
  `settings.yaml → agent`.
- Перевірка: `new-workspace.ps1 -Path <tmp>` двічі (вдруге — усе `kept`), потім `core.buildBoards` /
  `core.createTask` на розгорнутому каталозі або відкрити його у VS Code.
- `workspace/**` і `new-workspace.ps1` не пакуються (`.vscodeignore`).

## Тести

Node окремо не потрібен — використовується вбудований у VS Code. Шлях до `Code.exe`:
`(Get-Command code).Source` → два рівні вгору.

```bash
ELECTRON_RUN_AS_NODE=1 "<каталог VS Code>/Code.exe" test/core.test.js
```

```powershell
powershell -ExecutionPolicy Bypass -File .\test\integration\run.ps1
```

Інтеграційний тест відкриває VS Code з окремим профілем і тимчасовою папкою на кілька секунд; результат — рядки
`ok` / `FAIL`. Запускати після будь-якої зміни `package.json` чи `extension.js`.

**Пастка:** у терміналі VS Code (і в сесії Claude Code, запущеній з нього) задано `ELECTRON_RUN_AS_NODE=1` —
`Code.exe` тоді працює як Node і падає з «bad option: --user-data-dir». Для запуску VS Code змінну прибирати
(`run.ps1` це робить сам).

## Збірка і встановлення

```powershell
powershell -ExecutionPolicy Bypass -File .\pack.ps1          # → dist\task-kanban-<версія>.vsix
code --install-extension dist\task-kanban-<версія>.vsix
```

- Що не пакується — `.vscodeignore` (+ вбудовано: `.git/**`, `dist/**`, `*.vsix`, `pack.ps1`). Новий
  службовий файл чи каталог у корені — додати в `.vscodeignore`.
- Для розробки — `install.ps1` (junction, зміни підхоплюються після `Developer: Reload Window`); `-Uninstall`
  прибирає. Разом із `--install-extension` не використовувати: VS Code писатиме пакет крізь junction у код.
- Налагодження — `F5` («Run Extension», `.vscode/launch.json`; в `args` — робоча папка з `Tasks/_template`).

### Перевірка пакета «як на чужому ПК»

1. `git clone <репозиторій> <порожній каталог>` → `pack.ps1` там.
2. `code --user-data-dir <tmp>\ud --extensions-dir <tmp>\ext --install-extension <vsix>` →
   `--list-extensions --show-versions` показує `local.task-kanban@<версія>`.
3. Інтеграційний тест на встановленому пакеті: копія `run.ps1`, де `$root` = `<tmp>\ext\local.task-kanban-<версія>`,
   а `--extensionTestsPath` — `index.js` з репозиторію. Усі `ok` — пакет повний.

## Реліз

Лише за вказівкою користувача.

1. Підняти `version` у `package.json` (semver), прогнати тести core та інтеграційний.
2. Коміт, тег `v<версія>`, `git push origin main v<версія>`.
3. Зібрати `.vsix` **з коміту тегу** (чистий клон) і перевірити, як вище.
4. GitHub Release на тег з файлом `task-kanban-<версія>.vsix`: `gh release create v<версія> <vsix>` або REST API
   (`POST /repos/<owner>/task-kanban/releases`, файл — `uploads.github.com/.../releases/<id>/assets?name=…`).
   Токен не друкувати і не зберігати у файлах.
5. Перевірити: `/releases/latest` → новий тег, `releases/latest/download/<vsix>` завантажується.
   Тег без Release у `latest` не потрапляє — користувачі отримають стару версію.

## Коміти

- `git commit --only <файли>` — лише свої файли; чужі зміни в робочому дереві не чіпати.
- Не `push` без прохання, не `--amend` чужих комітів, не пропускати хуки.
