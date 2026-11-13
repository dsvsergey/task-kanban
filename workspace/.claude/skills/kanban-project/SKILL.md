---
name: kanban-project
description: "Підключення проекту до робочого каталогу task-kanban: запис у settings.yaml (код, ролі, колонки агента), доступ агента до каталогів з кодом (.claude/settings.json), проект на дошці (taskKanban.projects, каталог Tasks/<id> з колонками і шаблоном), розділ у Obsidian-vault і правила проекту. Вмикати, коли користувач хоче додати новий проект або повʼязаний репозиторій, перейменувати чи прибрати проект, або перевірити, що проект налаштований повністю."
---

# Проект у робочому каталозі

Проект налаштований, коли збігаються **чотири місця**: `settings.yaml`, `.claude/settings.json`,
`.vscode/settings.json` (дошка) і `Obsidian/<id>/`. Змінювати їх разом.

## Що спитати (якщо не сказано)

- `id` — коротко, латиницею, без пробілів (`shop`); незмінний: це каталоги `Tasks/<id>`, `Obsidian/<id>`.
- Назва і опис одним реченням.
- Каталоги з кодом (основний і повʼязані) і їхні ролі; тип/мова.
- Чи потрібні колонки агента і облік трудомісткості (за замовчуванням — як у `settings.yaml → agent`).

## Кроки

1. **`settings.yaml → projects`** — запис за прикладом у файлі: `id`, `title`, `description`,
   `tasks: Tasks/<id>`, `vault: Obsidian/<id>`, `repos` (`path`, `role`: main | related | tools, `type`,
   `description`); `agent` — лише якщо відрізняється від загального.
   Шляхи до коду — **відносно робочого каталогу** (`../shop-api`), якщо код лежить поруч: тоді каталог
   переноситься на інший ПК без правок.
2. **`.claude/settings.json → permissions.additionalDirectories`** — кожен `repos[].path` (той самий шлях).
   Набуде чинності в наступній сесії агента — сказати користувачу.
3. **Дошка** — `.vscode/settings.json → taskKanban.projects`:

   ```jsonc
   { "id": "shop", "title": "Shop", "description": "…", "color": "blue",
     "tasksDir": "Tasks/shop" }
   ```

   Без `stages` — загальні колонки `taskKanban.stages`. Коміти при перенесенні (необовʼязково, якщо
   робочий каталог під git):

   ```jsonc
   "transitions": [ { "to": "*", "actions": [
     { "type": "commit", "paths": ["Tasks/shop/*/{number}/**", "Obsidian/shop/Tasks/shop-{number}.md"] } ] } ]
   ```

   Каталоги: `Tasks/<id>/_template/` (копія `Tasks/_template/`) і `Tasks/<id>/<dir>/` на кожну колонку.
   Те саме робить кнопка `+ Проект` на дашборді — можна запропонувати користувачу її.
4. **Vault** — `Obsidian/<id>/<id>.md` (шаблон `Templates/Project.md`), `Obsidian/<id>/Правила (<id>).md`
   (`Templates/Rules.md`; заповнити з README/конфігів репозиторію: мова, збірка, тести, що заборонено),
   порожні `Modules/ Flows/ Data/ Decisions/ Tasks/` не потрібні — зʼявляться з першими нотатками.
   Рядок у `00 Index.md → Проекти`: `- [[<id>]] — опис`.
5. **Скіли проекту** (необовʼязково) — `.claude/skills/<id>-<тема>/SKILL.md` для повторюваних прийомів
   (збірка, БД, деплой); рядок про них у `Правила (<id>)`.

## Повʼязаний репозиторій до наявного проекту

`repos` у `settings.yaml` + `additionalDirectories` + рядок «Код» в огляді `<id>.md`.

## Прибрати проект

Лише за вказівкою: запис із `settings.yaml`, `additionalDirectories`, `taskKanban.projects`. Каталоги
`Tasks/<id>/` і `Obsidian/<id>/` не видаляти без окремого підтвердження (там історія задач і знання).

## Перевірка

- Дашборд «Проекти» показує проект, дошка відкривається, `+ Задача` створює каталог у першій колонці.
- `[[<id>]]` з `00 Index.md` відкривається в Obsidian.
- У новій сесії агент бачить код (`additionalDirectories`).
