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
  assert.ok(!fs.existsSync(path.join(tasks, '5_arkhiv')), 'addStage каталог не створює');
  core.ensureStageDir(tasks, '5_arkhiv');
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

test('трудомісткість: поле task.md → effort картки', () => {
  const t = '# Task 1\n\n- **Статус:** виконані ші\n- **Трудомісткість:** 3:20 <!-- коментар -->\n';
  assert.equal(core.readField(t, 'Трудомісткість'), '3:20');
  assert.equal(core.readField('- **трудомісткість:** 14:30\n', 'Трудомісткість'), '14:30');
  assert.equal(core.readField('- **Трудомісткість:** — <!-- заповнює агент -->\n', 'Трудомісткість'), null);
  assert.equal(core.readField('- **Трудомісткість:**\n', 'Трудомісткість'), null);
  assert.equal(core.readField('# без поля\n', 'Трудомісткість'), null);
  assert.equal(core.readField(t, ''), null);
  assert.equal(core.readField('- **Час (год):** 2:00\n', 'Час (год)'), '2:00');

  const root = tmp();
  const tasks = path.join(root, 'Tasks');
  write(path.join(tasks, '1_new', '5', 'task.md'), t);
  write(path.join(tasks, '1_new', '6', 'task.md'), '# Task 6\n');
  const list = core.scanTasks(tasks, STAGES);
  assert.equal(list.find((x) => x.id === '5').effort, '3:20');
  assert.equal(list.find((x) => x.id === '6').effort, null);
  assert.equal(core.scanTasks(tasks, STAGES, { effortField: '' }).find((x) => x.id === '5').effort, null);
});

test('сесії Claude Code: пошук за номером задачі', async () => {
  assert.equal(
    core.claudeProjectDir('C:/h/.claude', 'D:/nprojects/UltraAdd'),
    path.join('C:/h/.claude', 'projects', path.resolve('D:/nprojects/UltraAdd').replace(/[^A-Za-z0-9]/g, '-')),
  );

  const dir = tmp();
  const L = (o) => JSON.stringify(o);
  const user = (content, extra = {}) => L({ type: 'user', timestamp: extra.ts || '2026-11-10T10:00:00Z', message: { role: 'user', content }, ...extra });
  // A: почалася з задачі 86170, має назву
  write(path.join(dir, 'aaaa.jsonl'), [
    user([{ type: 'text', text: '<ide_opened_file>Tasks/3_work/99999/task.md</ide_opened_file>' }, { type: 'text', text: 'виконайте задачу @Tasks/2_queue/86170/task.md' }], { ts: '2026-11-10T10:00:00Z' }),
    L({ type: 'ai-title', aiTitle: 'Задача 86170 Delphi' }),
    L({ type: 'assistant', timestamp: '2026-11-10T12:00:00Z', message: { content: 'про 55555' } }),
  ].join('\n'));
  // B: задача 86170 згадується пізніше; 12345 — лише в isMeta, tool_result і system-reminder
  write(path.join(dir, 'bbbb.jsonl'), [
    user('поправте звіт 70000', { ts: '2026-11-11T09:00:00Z' }),
    user([{ type: 'text', text: 'Base directory for this skill … задача 12345' }], { isMeta: true }),
    user([{ type: 'tool_result', content: '12345' }]),
    user('і ще 86170 <system-reminder>12345</system-reminder>', { ts: '2026-11-11T11:00:00Z' }),
    L({ type: 'custom-title', customTitle: 'Моя назва' }),
  ].join('\n'));
  write(path.join(dir, 'notes.txt'), '86170');

  const cache = new Map();
  let s = await core.findTaskSessions(dir, '86170', cache);
  assert.deepEqual(s.map((x) => [x.sessionId, x.primary, x.title]), [
    ['aaaa', true, 'Задача 86170 Delphi'],
    ['bbbb', false, 'Моя назва'],
  ]);
  assert.equal(s[0].start, '2026-11-10T10:00:00Z');
  assert.equal(s[0].end, '2026-11-10T12:00:00Z');
  assert.equal(s[0].firstPrompt, 'виконайте задачу @Tasks/2_queue/86170/task.md');

  // відкритий у редакторі файл, isMeta, результат інструмента, нагадування, відповідь асистента — не рахуються
  for (const id of ['99999', '12345', '55555']) assert.equal((await core.findTaskSessions(dir, id, cache)).length, 0, id);
  // складений номер — за будь-якою частиною
  assert.equal((await core.findTaskSessions(dir, '70000_86170', cache)).length, 2);
  // кеш: незмінений файл не перечитується
  const before = cache.get(path.join(dir, 'aaaa.jsonl'));
  await core.findTaskSessions(dir, '86170', cache);
  assert.equal(cache.get(path.join(dir, 'aaaa.jsonl')), before);
  // немає каталогу — порожньо
  assert.deepEqual(await core.findTaskSessions(path.join(dir, 'нема'), '86170'), []);
});

// ---------- проекти ----------

test('поле «Проекти»: примітки в дужках, кома в дужках, `код`, прочерк', () => {
  assert.deepEqual(core.parseProjectList('Ultra'), ['Ultra']);
  assert.deepEqual(core.parseProjectList('Ultra (БД), ultra-replicator (лише аналіз)'), ['Ultra', 'ultra-replicator']);
  assert.deepEqual(core.parseProjectList('Ultra (ultra-delphi, Ultra)'), ['Ultra']);
  assert.deepEqual(core.parseProjectList('ultra-delphi (міграції `sql/3.0.*.sql`)'), ['ultra-delphi']);
  assert.deepEqual(core.parseProjectList('A; B'), ['A', 'B']);
  assert.deepEqual(core.parseProjectList(null), []);
  assert.deepEqual(core.parseProjectList('—'), []);
});

test('проекти: налаштовані за id/title/aliases, решта — з задач', () => {
  const tasks = [
    { id: '1', projects: ['Ultra'] },
    { id: '2', projects: ['ultra-delphi', 'task-kanban'] },
    { id: '3', projects: ['Інше'] },
    { id: '4', projects: [] },
  ];
  const { projects, projectsOf } = core.resolveProjects(
    [
      { id: 'ultra', title: 'Ultra', aliases: ['ultra-delphi'] },
      { id: 'task-kanban', title: 'Task Kanban' },
      { id: 'ultra', title: 'дубль' },
    ],
    tasks,
  );
  assert.deepEqual(projects.map((p) => [p.id, p.configured]), [['ultra', true], ['task-kanban', true], ['Інше', false]]);
  assert.deepEqual(projectsOf(tasks[0]), ['ultra']);
  assert.deepEqual(projectsOf(tasks[1]), ['ultra', 'task-kanban']);
  assert.deepEqual(projectsOf(tasks[2]), ['Інше']);
  assert.deepEqual(core.filterByProject(tasks, projectsOf, 'ultra').map((t) => t.id), ['1', '2']);
  assert.deepEqual(core.filterByProject(tasks, projectsOf, '').map((t) => t.id), ['4']);
  assert.equal(core.filterByProject(tasks, projectsOf, '*').length, 4);
  assert.ok(projects.every((p) => p.color));
});

test('трудомісткість і зведення по проекту', () => {
  assert.equal(core.parseEffort('3:20'), 200);
  assert.equal(core.parseEffort('14:05'), 845);
  assert.equal(core.parseEffort('2'), 120);
  assert.equal(core.parseEffort('—'), null);
  assert.equal(core.formatMinutes(845), '14:05');
  const stages = [...STAGES, { dir: '5_done', collapsed: true }, { dir: '8_last' }];
  assert.deepEqual([...core.doneStages(stages)].sort(), ['5_done', '8_last']);
  assert.deepEqual([...core.doneStages([...STAGES, { dir: 'x', done: true }])], ['x']);
  const st = core.projectStats(
    [
      { stage: '1_new', effort: '1:30', updated: 5 },
      { stage: '5_done', effort: '2:00', updated: 9 },
      { stage: '', effort: null, updated: 1 },
    ],
    stages,
  );
  assert.equal(st.total, 3);
  assert.equal(st.active, 2);
  assert.equal(st.done, 1);
  assert.equal(st.byStage['1_new'], 1);
  assert.equal(st.noStage, 1);
  assert.equal(st.effortMinutes, 210);
  assert.equal(st.withEffort, 2);
  assert.equal(st.updated, 9);
});

test('writeField: заміна, вставка після полів шапки, без полів', () => {
  const a = '# Task 1\r\n\r\n- **Статус:** нове\r\n- **Проекти:** Ultra <!-- x -->\r\n\r\n## Description\r\n';
  assert.equal(core.writeField(a, 'Проекти', 'A, B'), a.replace('Ultra <!-- x -->', 'A, B'));
  const b = '# Task 1\n\n- **Статус:** нове\n\n## Description\n- **Не поле:** x\n';
  assert.equal(core.writeField(b, 'Проекти', 'A'), '# Task 1\n\n- **Статус:** нове\n- **Проекти:** A\n\n## Description\n- **Не поле:** x\n');
  assert.equal(core.writeField('# T\n\ntext\n', 'Проекти', 'A'), '# T\n\n- **Проекти:** A\n\ntext\n');
  assert.equal(core.readField(core.writeField('text\n', 'Проекти', 'A'), 'Проекти'), 'A');
});

test('setTaskProjects: примітки вибраних лишаються, нові дописуються', () => {
  const projects = [
    { id: 'ultra', title: 'Ultra', aliases: ['ultra-delphi'] },
    { id: 'tk', title: 'Task Kanban' },
    { id: 'ultra-replicator', title: 'ultra-replicator' },
  ];
  const raw = 'Ultra (лише БД), ultra-replicator (аналіз)';
  assert.equal(core.setTaskProjects(raw, ['ultra', 'tk'], projects), 'Ultra (лише БД), Task Kanban');
  assert.equal(core.setTaskProjects('ultra-delphi (міграції)', ['ultra'], projects), 'ultra-delphi (міграції)');
  assert.equal(core.setTaskProjects(raw, [], projects), '');
  assert.equal(core.setTaskProjects('', ['Нове'], projects), 'Нове');
});

test('scanTasks: проекти і час зміни задачі', () => {
  const root = tmp();
  write(path.join(root, '1_new', '10', 'task.md'), '# Task 10\n\n- **Статус:** нове\n- **Проекти:** Ultra (БД), task-kanban\n');
  write(path.join(root, '1_new', '11', 'task.md'), '# Task 11\n\n- **Статус:** нове\n- **Теги:** x\n');
  const tasks = core.scanTasks(root, STAGES, { projectField: 'Теги' });
  assert.deepEqual(tasks.map((t) => t.projects), [[], ['x']]);
  const [t10] = core.scanTasks(root, STAGES);
  assert.deepEqual(t10.projects, ['Ultra', 'task-kanban']);
  assert.ok(t10.updated > 0);
});

// ---------- власні каталоги проектів ----------

test('buildBoards: власний каталог і колонки, спільний каталог за рядком «Проекти», вкладений корінь', () => {
  const ws = tmp();
  const shared = path.join(ws, 'Tasks');
  write(path.join(shared, '_template', 'task.md'), '# Task <номер>\n\n- **Статус:** нове\n- **Проекти:** —\n');
  write(path.join(shared, '1_new', '1', 'task.md'), '# Task 1\n\n- **Статус:** нове\n- **Проекти:** Ultra\n');
  write(path.join(shared, '3_work', '2', 'task.md'), '# Task 2\n\n- **Статус:** в роботі\n');
  // корінь проекту B усередині спільного — не має потрапити в «без етапу»
  write(path.join(shared, 'b', 'todo', '7', 'task.md'), '# Task 7\n\n- **Статус:** todo\n');
  // проект C поза робочою областю
  const cRoot = path.join(ws, '..', path.basename(ws) + '-c', 'Tasks');
  write(path.join(cRoot, 'todo', '9', 'task.md'), '# Task 9\n\n- **Статус:** todo\n');

  const own = [{ dir: 'todo', title: 'To do', status: 'todo' }, { dir: 'done', title: 'Done', status: 'done' }];
  const m = core.buildBoards({
    folder: ws,
    tasksRoot: shared,
    stages: STAGES,
    transitions: [{ to: '*', actions: [] }],
    projects: [
      { id: 'ultra', title: 'Ultra' },
      { id: 'b', title: 'B', tasksDir: 'Tasks/b', stages: own },
      { id: 'c', title: 'C', tasksDir: path.relative(ws, cRoot) },
    ],
  });
  assert.deepEqual(m.boards.map((b) => [b.id, b.kind]), [['ultra', 'project'], ['b', 'project'], ['c', 'project'], ['*', 'all'], ['', 'none']]);
  assert.deepEqual(m.get('ultra').tasks.map((t) => t.id), ['1']);
  assert.deepEqual(m.get('*').tasks.map((t) => t.id), ['1', '2']);
  assert.deepEqual(m.get('').tasks.map((t) => t.id), ['2']);
  const b = m.get('b');
  assert.equal(b.ownRoot, true);
  assert.equal(b.ownStages, true);
  assert.deepEqual(b.stages, own);
  assert.deepEqual(b.tasks.map((t) => [t.id, t.stage]), [['7', 'todo']]);
  assert.deepEqual(b.transitions, []);
  assert.equal(b.template, path.resolve(shared, '_template')); // свого шаблону немає — загальний
  const c = m.get('c');
  assert.equal(c.ownStages, false);
  assert.deepEqual(c.stages, STAGES);
  assert.deepEqual(c.tasks.map((t) => [t.id, t.stage]), [['9', '']]); // етапу todo в загальних колонках немає
  assert.equal(m.get('ultra').transitions.length, 1);
  fs.rmSync(path.dirname(cRoot), { recursive: true, force: true });
});

test('buildBoards: спільний каталог належить проекту — без «усіх» і «без проекту»', () => {
  const ws = tmp();
  write(path.join(ws, 'Tasks', '1_new', '1', 'task.md'), '# Task 1\n\n- **Статус:** нове\n- **Проекти:** будь-що\n');
  const m = core.buildBoards({
    folder: ws,
    tasksRoot: path.join(ws, 'Tasks'),
    stages: STAGES,
    transitions: [{ to: '*', actions: [] }],
    projects: [{ id: 'ultra', title: 'Ultra', tasksDir: 'Tasks' }, { id: 'dup', title: 'Dup', tasksDir: './Tasks' }],
  });
  assert.deepEqual(m.boards.map((b) => b.id), ['ultra']);
  assert.equal(m.sharedOwned, true);
  assert.deepEqual(m.get('ultra').tasks.map((t) => t.id), ['1']);
  assert.equal(m.get('ultra').transitions.length, 1); // спільний каталог — загальні переходи
});

test('initProjectRoot і moveTaskToRoot: каталоги колонок, шаблон, перенесення між проектами', async () => {
  const ws = tmp();
  const sharedTpl = path.join(ws, 'Tasks', '_template');
  write(path.join(sharedTpl, 'task.md'), '# Task <номер>\n\n- **Статус:** нове\n');
  const root = path.join(ws, 'proj', 'Tasks');
  const own = [{ dir: 'a', status: 'аа' }, { dir: 'b' }];
  core.initProjectRoot(root, own, sharedTpl);
  assert.ok(fs.existsSync(path.join(root, 'a')) && fs.existsSync(path.join(root, 'b')));
  assert.ok(fs.existsSync(path.join(root, '_template', 'task.md')));

  write(path.join(ws, 'Tasks', '1_new', '5', 'task.md'), '# Task 5\n\n- **Статус:** нове\n');
  const [t] = core.scanTasks(path.join(ws, 'Tasks'), STAGES);
  const res = await core.moveTaskToRoot(t, root, own[0]);
  assert.equal(res.task.dir, path.join(root, 'a', '5'));
  assert.equal(res.statusUpdated, true);
  assert.equal(core.readStatus(fs.readFileSync(res.task.taskFile, 'utf8')), 'аа');
  assert.ok(!fs.existsSync(t.dir));
  await assert.rejects(() => core.moveTaskToRoot(t, root, own[0]));
});

// ---------- підзадачі ----------

test('wiki-посилання і поле батьківської задачі', () => {
  assert.equal(core.wikiTarget('Tasks/00003.md#Опис|задача'), '00003');
  assert.deepEqual(core.parseWikiLinks('див. [[00003]] і [[00004|ще]], [[00003]]'), ['00003', '00004']);
  assert.equal(core.readParent('# T\n\n- **Батьківська задача:** [[00003]] <!-- c -->\n'), '00003');
  assert.equal(core.readParent('# T\n\n- **Батьківська задача:** 86170 (звіт)\n'), '86170');
  assert.equal(core.readParent('# T\n\n- **Батьківська задача:** —\n'), null);
  assert.equal(core.readParent('# T\n\n- **Parent:** [[7]]\n', 'Parent'), '7');
});

test('розділ «Підзадачі»: пункти, план, галочки', () => {
  const t =
    '# Task 3\n\n## Description\n\nОпис\n\n## Підзадачі\n\n- [x] [[3.1]] Модель\n- [ ] [[3.2]] — UI\n' +
    '- [ ] Документація\n* просто пункт\n- <заглушка>\n\n## Результат\n\n- [ ] не підзадача\n';
  const items = core.readSubtasks(t);
  assert.deepEqual(
    items.map((x) => [x.id, x.checked, x.text]),
    [['3.1', true, 'Модель'], ['3.2', false, 'UI'], [null, false, 'Документація'], [null, null, 'просто пункт']],
  );
  const t2 = core.setSubtaskChecked(t, '3.2', true);
  assert.ok(t2.includes('- [x] [[3.2]] — UI'));
  assert.equal(core.setSubtaskChecked(t2, '3.2', true), t2);
  assert.equal(core.setSubtaskChecked(t, '3.9', true), t);
  const t3 = core.linkSubtaskItem(t, items[2].line, '3.3');
  assert.ok(t3.includes('- [ ] [[3.3]] Документація'));
  assert.ok(core.linkSubtaskItem(t, items[3].line, '3.4').includes('* [ ] [[3.4]] просто пункт'));
  assert.equal(core.nextSubtaskId('3', ['3', '3.1', '3.2']), '3.3');
});

test('додавання пункту підзадачі: в наявний розділ, новий розділ після Description, CRLF', () => {
  const a = '# T\n\n## Description\n\nОпис\n\n## Підзадачі\n\n- [ ] [[1.1]] A\n\n## Результат\n';
  assert.equal(core.addSubtaskLink(a, '1.2', 'B'), '# T\n\n## Description\n\nОпис\n\n## Підзадачі\n\n- [ ] [[1.1]] A\n- [ ] [[1.2]] B\n\n## Результат\n');
  assert.equal(core.addSubtaskLink(a, '1.1', 'A'), a, 'повтор не додається');
  const b = '# T\r\n\r\n## Description\r\n\r\nОпис\r\n\r\n## Результат\r\n\r\n<...>\r\n';
  assert.equal(
    core.addSubtaskLink(b, '1.1', 'A'),
    '# T\r\n\r\n## Description\r\n\r\nОпис\r\n\r\n## Підзадачі\r\n\r\n- [ ] [[1.1]] A\r\n\r\n## Результат\r\n\r\n<...>\r\n',
  );
  const c = '# T\n\n## Підзадачі\n\n<пункти>\n\n## Результат\n';
  assert.equal(core.addSubtaskLink(c, '1.1', 'A'), '# T\n\n## Підзадачі\n\n- [ ] [[1.1]] A\n\n## Результат\n');
  assert.equal(core.addSubtaskLink('# T\n', '1.1', ''), '# T\n\n## Підзадачі\n\n- [ ] [[1.1]]\n');
});

test('опис нової задачі: заглушка замінюється', () => {
  assert.equal(core.writeDescription('# T\n\n## Description\n\n<опис>\n\n## Результат\n', 'Нове'), '# T\n\n## Description\n\nНове\n\n## Результат\n');
  assert.equal(core.writeDescription('# T\n\n## Description\n\nБуло\n', 'Нове'), '# T\n\n## Description\n\nНове\n\nБуло\n');
  assert.equal(core.writeDescription('# T\n', 'Нове'), '# T\n\n## Description\n\nНове\n');
});

test('звʼязки підзадач: поле і розділ, порядок, відсутні', () => {
  const tasks = [
    { id: '3', subtasks: [{ id: '3.2' }, { id: '3.1' }, { id: '9.9' }] },
    { id: '3.1', parent: '3', subtasks: [] },
    { id: '3.2', subtasks: [] }, // лише в розділі батьківської
    { id: '3.3', parent: '3', subtasks: [] }, // лише полем
    { id: '4', parent: '4', subtasks: [{ id: '3.1' }] }, // сам собі не батько; 3.1 уже має поле
  ];
  const info = core.linkSubtasks(tasks);
  assert.deepEqual(info.get('3').children, ['3.2', '3.1', '3.3']);
  assert.deepEqual(info.get('3').missing, ['9.9']);
  assert.equal(info.get('3.2').parent, '3');
  assert.equal(info.get('4').parent, null);
  assert.deepEqual(info.get('4').children, []);
});

test('створення підзадачі з шаблону і з пункту плану', () => {
  const root = tmp();
  write(path.join(root, '_template', 'task.md'), '# Task <номер>\n\n- **Статус:** <!-- s -->\n- **Проекти:** x\n\n## Description\n\n<опис>\n\n## Результат\n');
  write(
    path.join(root, '3_work', '7', 'task.md'),
    '# Task 7\n\n- **Статус:** в роботі\n- **Проекти:** Ultra (БД), task-kanban\n\n## Description\n\nВелика\n\n## Підзадачі\n\n- [ ] Частина А\n\n## Результат\n',
  );
  const [parent] = core.scanTasks(root, STAGES);
  assert.equal(parent.subtasks[0].text, 'Частина А');
  const a = core.createSubtask(root, '_template', '1_new', parent, '7.1', 'Частина А', { status: 'нове', planLine: parent.subtasks[0].line });
  const b = core.createSubtask(root, '_template', '1_new', parent, '7.2', 'Частина Б', { status: 'нове' });
  assert.equal(a.parent, '7');
  assert.equal(b.title, 'Частина Б');
  const ct = fs.readFileSync(a.taskFile, 'utf8');
  assert.ok(ct.includes('- **Статус:** нове\n- **Проекти:** Ultra (БД), task-kanban\n- **Батьківська задача:** [[7]]\n'), ct);
  assert.ok(ct.includes('## Description\n\nЧастина А\n'));
  const pt = fs.readFileSync(parent.taskFile, 'utf8');
  assert.ok(pt.includes('## Підзадачі\n\n- [ ] [[7.1]] Частина А\n- [ ] [[7.2]] Частина Б\n\n## Результат'), pt);
  const all = core.scanTasks(root, STAGES);
  assert.deepEqual(core.linkSubtasks(all).get('7').children, ['7.1', '7.2']);
  assert.throws(() => core.createSubtask(root, '_template', '1_new', parent, '7.1', 'x'), /уже існує/);
});
