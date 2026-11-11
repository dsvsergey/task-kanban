'use strict';
// Запуск без Node у системі — через Node, вбудований у VS Code:
//   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../src/core');

const STAGES = [
  { dir: '1_new', title: 'Нове', status: 'нове' },
  { dir: '3_work', title: 'В роботі', status: 'в роботі' },
  { dir: '4_testing', title: 'На тестуванні', status: 'на тестуванні' },
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-kanban-test-'));
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function initRepo(dir) {
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'core.autocrlf', 'false');
}

test('статус: маркований рядок, коментар, заголовок, відсутній', () => {
  const a = '# Task 1\r\n\r\n- **Статус:** review <!-- new | done -->\r\n- **Проекти:** Ultra\r\n';
  assert.equal(core.readStatus(a), 'review');
  const a2 = core.writeStatus(a, 'на тестуванні');
  assert.equal(a2, '# Task 1\r\n\r\n- **Статус:** на тестуванні\r\n- **Проекти:** Ultra\r\n');

  const b = '# Task 2\n\n## Статус\n\nreview — код готовий\n\n## Результат\n';
  assert.equal(core.readStatus(b), 'review — код готовий');
  assert.equal(core.writeStatus(b, 'готово'), '# Task 2\n\n## Статус\n\nготово\n\n## Результат\n');

  assert.equal(core.writeStatus('# Task 3\n\n## Description\n\nтекст\n', 'нове'), null);
});

test('заголовок картки береться з Description', () => {
  assert.equal(core.readTitle('# Task 1\n\n- **Статус:** x\n\n## Description\n\nПомилка в базі\nдругий рядок\nтретій\n'), 'Помилка в базі · другий рядок');
  assert.equal(core.readTitle('# Task 2\n\n# Description\n\n## Інше\n'), '');
  assert.equal(core.readTitle('# Task 3\n\n- **Статус:** x\n\nПросто текст\n'), 'Просто текст');
});

test('сканування, перенесення і статус', async () => {
  const root = tmp();
  const tasks = path.join(root, 'Tasks');
  write(path.join(tasks, '_template', 'task.md'), '# Task <номер>\n\n- **Статус:** нове\n');
  write(path.join(tasks, '1_new', '100', 'task.md'), '# Task 100\n\n- **Статус:** нове\n\n## Description\n\nОпис 100\n');
  write(path.join(tasks, '3_work', '20', '20_task.md'), '# Task 20\n\n## Description\n\nОпис 20\n');
  write(path.join(tasks, '3_work', '20', 'path.sql'), 'select 1 from rdb$database;');
  write(path.join(tasks, '3_work', '20', 'task_20.v1.zip'), '');
  write(path.join(tasks, '3_work', '20', 'task_20.v3.zip'), '');
  write(path.join(tasks, '555', 'task.md'), '# Task 555\n');

  const list = core.scanTasks(tasks, STAGES);
  assert.deepEqual(list.map((t) => `${t.stage}/${t.id}`), ['3_work/20', '1_new/100', '/555']);
  const t20 = list[0];
  assert.equal(t20.hasSql, true);
  assert.equal(t20.zipVersion, 3);
  assert.equal(t20.title, 'Опис 20');

  const res = await core.moveTask(tasks, STAGES, '100', '3_work');
  assert.equal(res.from, '1_new');
  assert.equal(res.statusUpdated, true);
  assert.ok(fs.existsSync(path.join(tasks, '3_work', '100', 'task.md')));
  assert.ok(!fs.existsSync(path.join(tasks, '1_new', '100')));
  assert.equal(core.readStatus(fs.readFileSync(path.join(tasks, '3_work', '100', 'task.md'), 'utf8')), 'в роботі');

  // без рядка статусу — переноситься, але статус не чіпається
  const r2 = await core.moveTask(tasks, STAGES, '20', '4_testing');
  assert.equal(r2.statusUpdated, false);

  await assert.rejects(() => core.moveTask(tasks, STAGES, '999', '3_work'), /не знайдено/);

  const created = core.createTask(tasks, '_template', '1_new', '777');
  assert.equal(fs.readFileSync(created.taskFile, 'utf8'), '# Task 777\n\n- **Статус:** нове\n');
  assert.throws(() => core.createTask(tasks, '_template', '1_new', '777'), /уже існує/);
  assert.throws(() => core.createTask(tasks, '_template', '1_new', '../x'), /Недопустимий/);
});

test('переходи і перевірка файлів', () => {
  const tr = [
    { from: '*', to: '4_testing', actions: [{ type: 'check', files: ['path.sql'] }] },
    { from: '3_work', to: '4_testing', actions: [{ type: 'commit' }] },
    { to: '*', actions: [{ type: 'commit', name: 'all' }] },
  ];
  assert.equal(core.matchTransitions(tr, '3_work', '4_testing').length, 3);
  assert.equal(core.matchTransitions(tr, '1_new', '4_testing').length, 2);
  assert.equal(core.matchTransitions(tr, '1_new', '3_work').length, 1);

  const dir = tmp();
  write(path.join(dir, 'task_1.v2.zip'), '');
  assert.deepEqual(core.missingFiles(dir, ['path.sql', 'task_*.zip']), ['path.sql']);
  assert.equal(core.fill('${workspaceFolder}/{number} {x}', { workspaceFolder: 'W', number: 7 }), 'W/7 {x}');
});

test('коміт: лише файли задачі, з переносом і кодом з іншого репозиторію', async () => {
  const add = tmp();
  initRepo(add);
  const tasks = path.join(add, 'Tasks');
  write(path.join(tasks, '3_work', '42', 'task.md'), '# Task 42\n\n- **Статус:** в роботі\n');
  write(path.join(tasks, '3_work', '42', 'delphi', 'uFORM.pas'), 'unit uFORM;');
  write(path.join(tasks, '3_work', '42', 'delphi', 'uFORM.dfm'), 'object');
  write(path.join(add, 'Obsidian', 'Tasks', '42.md'), 'нотатка');
  write(path.join(add, 'Obsidian', 'Modules', 'Other.md'), 'інше');
  g(add, 'add', '-A');
  g(add, 'commit', '-qm', 'init');

  const code = tmp();
  initRepo(code);
  write(path.join(code, 'src', 'uFORM.pas'), 'old');
  write(path.join(code, 'src', 'uFORM.dfm'), 'old');
  write(path.join(code, 'src', 'uOTHER.pas'), 'old');
  g(code, 'add', '-A');
  g(code, 'commit', '-qm', 'init');

  // зміни: задача, її нотатка, чужа нотатка (не має потрапити), код задачі і чужий код
  write(path.join(tasks, '3_work', '42', 'path.sql'), 'select 1;');
  write(path.join(add, 'Obsidian', 'Tasks', '42.md'), 'нотатка 2');
  write(path.join(add, 'Obsidian', 'Modules', 'Other.md'), 'інше 2');
  write(path.join(code, 'src', 'uFORM.pas'), 'new');
  write(path.join(code, 'src', 'uOTHER.pas'), 'new');
  g(code, 'add', 'src/uOTHER.pas'); // чуже проіндексоване — не має піти в коміт задачі

  const moved = await core.moveTask(tasks, STAGES, '42', '4_testing');
  const vars = { number: '42', stage: '4_testing', workspaceFolder: add };
  const ctx = { workspaceFolder: add, task: moved.task, vars };

  const a = await core.collectCommit({ paths: ['Tasks/*/{number}/**', 'Obsidian/Tasks/{number}.md'] }, ctx);
  const aPaths = a.files.map((f) => f.path).sort();
  assert.deepEqual(aPaths, [
    'Obsidian/Tasks/42.md',
    'Tasks/3_work/42/delphi/uFORM.dfm',
    'Tasks/3_work/42/delphi/uFORM.pas',
    'Tasks/3_work/42/task.md',
    'Tasks/4_testing/42/delphi/uFORM.dfm',
    'Tasks/4_testing/42/delphi/uFORM.pas',
    'Tasks/4_testing/42/path.sql',
    'Tasks/4_testing/42/task.md',
  ]);

  const c = await core.collectCommit({ repo: code, sourceDir: 'delphi', name: 'code' }, ctx);
  assert.deepEqual(c.files.map((f) => f.path), ['src/uFORM.pas']);

  const h1 = await core.commitFiles(a.repo, aPaths, '42');
  const h2 = await core.commitFiles(c.repo, ['src/uFORM.pas'], '42');
  assert.ok(h1 && h2);

  // у UltraAdd лишилась тільки чужа нотатка, у коді — тільки чужий проіндексований файл
  assert.equal(g(add, 'status', '--porcelain').trim(), 'M Obsidian/Modules/Other.md');
  assert.equal(g(code, 'status', '--porcelain').trim(), 'M  src/uOTHER.pas');
  assert.equal(g(add, 'log', '-1', '--format=%s').trim(), '42');
  const renamed = g(add, 'show', '--name-status', '-M', '--format=', 'HEAD');
  assert.match(renamed, /R100\tTasks\/3_work\/42\/delphi\/uFORM\.pas\tTasks\/4_testing\/42\/delphi\/uFORM\.pas/);

  // не git
  const plain = tmp();
  const p = await core.collectCommit({ repo: plain, name: 'Ultra' }, ctx);
  assert.match(p.warning, /не git-репозиторій/);
});

test('зайнятий каталог: повтори, потім зрозуміла помилка (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const root = tmp();
  const tasks = path.join(root, 'Tasks');
  write(path.join(tasks, '1_new', '7', 'task.md'), '# Task 7\n\n- **Статус:** нове\n');
  const prev = process.cwd();
  // поточний каталог процесу в задачі — як відкритий там термінал
  process.chdir(path.join(tasks, '1_new', '7'));
  try {
    await assert.rejects(
      () => core.moveTask(tasks, STAGES, '7', '3_work', { attempts: 3, delayMs: 20 }),
      (e) => e.code === 'LOCKED' && /зайнятий іншим процесом/.test(e.message),
    );
    assert.ok(fs.existsSync(path.join(tasks, '1_new', '7', 'task.md')), 'задача лишилась на місці');

    // блокування зникає під час повторів — перенесення вдається
    setTimeout(() => process.chdir(prev), 100);
    const res = await core.moveTask(tasks, STAGES, '7', '3_work', { attempts: 20, delayMs: 50 });
    assert.equal(res.moved, true);
    assert.ok(fs.existsSync(path.join(tasks, '3_work', '7', 'task.md')));
  } finally {
    process.chdir(prev);
  }
});

test('колонки: додати, змінити, переставити, видалити', async () => {
  const root = tmp();
  const tasks = path.join(root, 'Tasks');
  write(path.join(tasks, '1_new', '.gitkeep'), '');
  write(path.join(tasks, '3_work', '10', 'task.md'), '# Task 10\n\n- **Статус:** в роботі\n');
  write(path.join(tasks, '4_testing', '.gitkeep'), '');
  let stages = STAGES.map((s) => ({ ...s }));

  // підказка каталогу і перевірки
  assert.equal(core.suggestStageDir(stages, 'Архів'), '5_arkhiv');
  assert.equal(core.suggestStageDir(stages, '!!!'), '5_stage');
  assert.match(core.validateStageDir(tasks, stages, '3_WORK'), /уже є/);
  assert.match(core.validateStageDir(tasks, stages, '_x'), /не може починатися/);
  assert.match(core.validateStageDir(tasks, stages, 'Архів'), /латиниця/);
  write(path.join(tasks, '777', 'task.md'), '# Task 777\n');
  assert.match(core.validateStageDir(tasks, stages, '777'), /каталог задачі/);
  assert.equal(core.validateStageDir(tasks, stages, '5_arkhiv'), null);

  // додати після 3_work (індекс 1) — створюється каталог
  stages = core.addStage(tasks, stages, { dir: '5_arkhiv', title: ' Архів ', status: 'архів' }, 1);
  assert.deepEqual(stages.map((s) => s.dir), ['1_new', '3_work', '5_arkhiv', '4_testing']);
  assert.deepEqual(stages[2], { dir: '5_arkhiv', title: 'Архів', status: 'архів' });
  assert.ok(fs.existsSync(path.join(tasks, '5_arkhiv')));
  // без статусу; на початок
  stages = core.addStage(tasks, stages, { dir: '0_ideas', title: 'Ідеї', status: '  ' }, -1);
  assert.deepEqual(stages[0], { dir: '0_ideas', title: 'Ідеї' });
  assert.throws(() => core.addStage(tasks, stages, { dir: '0_ideas', title: 'x' }), /уже є/);

  // змінити назву, прибрати статус
  stages = core.updateStage(stages, '5_arkhiv', { title: 'Архів задач', status: '' });
  assert.deepEqual(stages.find((s) => s.dir === '5_arkhiv'), { dir: '5_arkhiv', title: 'Архів задач' });

  // переставити; на краях — без змін
  stages = core.moveStage(stages, '5_arkhiv', 1);
  assert.deepEqual(stages.map((s) => s.dir), ['0_ideas', '1_new', '3_work', '4_testing', '5_arkhiv']);
  assert.equal(core.moveStage(stages, '5_arkhiv', 1), stages);
  assert.equal(core.moveStage(stages, '0_ideas', -1), stages);

  // видалити: непорожню — ні; порожню з .gitkeep — так, разом з каталогом
  assert.throws(() => core.removeStage(tasks, stages, '3_work'), /задач: 1/);
  let r = core.removeStage(tasks, stages, '4_testing');
  assert.equal(r.folderRemoved, true);
  assert.ok(!fs.existsSync(path.join(tasks, '4_testing')));
  stages = r.stages;
  // каталог зі сторонніми файлами лишається, колонка прибирається
  write(path.join(tasks, '0_ideas', 'readme.txt'), 'x');
  r = core.removeStage(tasks, stages, '0_ideas');
  assert.equal(r.folderRemoved, false);
  assert.ok(fs.existsSync(path.join(tasks, '0_ideas', 'readme.txt')));
  stages = r.stages;
  assert.deepEqual(stages.map((s) => s.dir), ['1_new', '3_work', '5_arkhiv']);

  // етап прибрано зі списку, а задачі в ньому є — вони «без етапу», а не сам каталог як задача
  const shown = core.scanTasks(tasks, stages.filter((s) => s.dir !== '3_work'));
  assert.ok(shown.some((t) => t.id === '10' && t.stage === ''));
  assert.ok(!shown.some((t) => t.id === '3_work'));
  // і з «без етапу» задачу можна перенести назад у колонку
  const back = await core.moveTask(tasks, stages, '10', '5_arkhiv');
  assert.equal(back.moved, true);

  assert.equal(core.transitionsUsing([{ from: '*', to: '5_arkhiv' }, { to: '1_new' }], '5_arkhiv').length, 1);
});
