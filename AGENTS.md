# task-kanban — правила для агентів

Розширення VS Code: канбан-дошка задач для супровідних каталогів `<Name>Add` (колонки — каталоги
`Tasks/<етап>/`, картки — каталоги `Tasks/<етап>/<номер>/` з `task.md`). Опис для людей — `README.md`
(англійською) і `README.uk.md`; їх тримати синхронними.

- Відповідати мовою користувача; інтерфейс розширення — українською.
- Розробка, тести, збірка `.vsix`, реліз — скіл `task-kanban-dev` (`.claude/skills/task-kanban-dev/SKILL.md`).
- `workspace/` — універсальний робочий каталог для користувачів (правила агентів, `settings.yaml`, дошка,
  скіли `kanban-*`, шаблони задач і Obsidian-vault), розгортається `new-workspace.ps1`. Він не залежить від
  жодного конкретного проекту — специфіку не додавати. При зміні формату `task.md`, полів, налаштувань чи
  поведінки дошки оновлювати скіли `workspace/.claude/skills/kanban-*`.

## Головне

- Чистий JavaScript (CommonJS), **без залежностей і без збірки**; `engines.vscode` ^1.85. Не додавати
  `node_modules`, бандлери, TypeScript.
- Логіка без `vscode` — у `src/core.js` (покривається `test/core.test.js`); `extension.js` — лише UI і vscode API;
  webview — `media/board.*`, `media/dashboard.*`.
- У webview дані задач вставляти тільки через `textContent` (не `innerHTML`); CSP з nonce.
- Нове налаштування в `package.json` — завжди `"scope": "resource"`, інакше не пишеться в налаштування папки
  («Unable to write to Folder Settings», помилка 0.2.0). Додати його в таблицю налаштувань обох README.
- Зміни `package.json` і `extension.js` перевіряти інтеграційним тестом у справжньому VS Code
  (`test/integration/run.ps1`) — тести core цього не бачать.
- Git з розширення: комітити лише вибрані файли (`git commit --only`), ніколи не `push`.
- Номер версії (`package.json` → `version`) не піднімати без прохання; при релізі — semver.
- Комітити й публікувати реліз — лише коли користувач просить.
- Документацію задач і робочі нотатки в цьому репозиторії не створювати.
