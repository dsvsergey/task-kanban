'use strict';
// Інтеграційна перевірка у справжньому VS Code (запуск — test/integration/run.ps1).
// Ловить те, чого не бачать тести core: оголошення налаштувань, запис у settings.json, активацію, команди.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

exports.run = async function () {
  const out = [];
  let failed = false;
  const check = (ok, msg) => {
    out.push(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!ok) failed = true;
  };
  try {
    const ext = vscode.extensions.getExtension('local.task-kanban');
    await ext.activate();
    check(ext.isActive, 'розширення активоване');

    const folder = vscode.workspace.workspaceFolders[0];
    const cfg = () => vscode.workspace.getConfiguration('taskKanban', folder.uri);
    const defaults = cfg().inspect('stages').defaultValue;
    check(defaults.length === 5, `стандартних колонок: ${defaults.length}`);
    check(cfg().get('effortField') === 'Трудомісткість', 'налаштування effortField оголошене');

    const stages = [...defaults, { dir: '6_arkhiv', title: 'Архів', status: 'архів' }];
    await cfg().update('stages', stages, vscode.ConfigurationTarget.Workspace);
    check(cfg().get('stages').length === 6, 'запис колонок у налаштування робочої області');
    await cfg().update('stages', defaults, vscode.ConfigurationTarget.WorkspaceFolder);
    check(cfg().get('stages').length === 5, 'запис колонок у налаштування папки (scope: resource)');

    const file = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
    check(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('taskKanban.stages'), '.vscode/settings.json містить taskKanban.stages');

    await cfg().update('stages', undefined, vscode.ConfigurationTarget.Workspace);
    await cfg().update('stages', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    check(cfg().get('stages').length === 5, 'скидання до стандартних колонок');

    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['taskKanban.open', 'taskKanban.openBoard', 'taskKanban.addProject', 'taskKanban.newTask', 'taskKanban.refresh', 'taskKanban.addColumn', 'taskKanban.resetColumns', 'taskKanban.openTaskSession']) {
      check(cmds.includes(c), `команда ${c}`);
    }

    check(cfg().get('projectField') === 'Проекти', 'налаштування projectField оголошене');
    check(cfg().get('parentField') === 'Батьківська задача', 'налаштування parentField оголошене');
    check(cfg().get('subtasksHeading') === 'Підзадачі', 'налаштування subtasksHeading оголошене');
    check(cfg().get('accumulateCommits') === true, 'налаштування accumulateCommits оголошене (true)');
    await cfg().update('accumulateCommits', false, vscode.ConfigurationTarget.WorkspaceFolder);
    check(cfg().get('accumulateCommits') === false, 'запис accumulateCommits у налаштування папки (scope: resource)');
    await cfg().update('accumulateCommits', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    check(cfg().get('promptOpenIn') === 'auto', 'налаштування promptOpenIn оголошене (auto)');
    await cfg().update('promptOpenIn', 'clipboard', vscode.ConfigurationTarget.WorkspaceFolder);
    check(cfg().get('promptOpenIn') === 'clipboard', 'запис promptOpenIn у налаштування папки (scope: resource)');
    await cfg().update('promptOpenIn', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    const withPrompts = defaults.map((s) => (s.dir === '3_work' ? { ...s, prompts: [{ title: 'Виконати', text: 'Виконайте [task.md]' }] } : s));
    await cfg().update('stages', withPrompts, vscode.ConfigurationTarget.WorkspaceFolder);
    const saved = cfg().get('stages').find((s) => s.dir === '3_work');
    check(saved && saved.prompts && saved.prompts[0].text === 'Виконайте [task.md]', 'промпти колонки зберігаються в stages');
    await cfg().update('stages', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    const promptTr = [{ from: '*', to: '3_work', actions: [{ type: 'prompt', prompts: [{ use: 'Виконати' }, { text: 'x' }], run: 'each' }] }];
    await cfg().update('transitions', promptTr, vscode.ConfigurationTarget.WorkspaceFolder);
    const tr = cfg().get('transitions');
    check(tr.length === 1 && tr[0].actions[0].type === 'prompt' && tr[0].actions[0].run === 'each', 'перехід prompt зберігається в налаштуваннях папки');
    await cfg().update('transitions', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg().update('projects', [{ id: 'p', tasksDir: 'P/Tasks', transitions: promptTr }], vscode.ConfigurationTarget.WorkspaceFolder);
    const pr = cfg().get('projects');
    check(pr[0].transitions[0].actions[0].prompts[0].use === 'Виконати', 'перехід prompt зберігається в transitions проекту');
    await cfg().update('projects', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg().update('subtasksHeading', 'Subtasks', vscode.ConfigurationTarget.WorkspaceFolder);
    check(cfg().get('subtasksHeading') === 'Subtasks', 'запис subtasksHeading у налаштування папки (scope: resource)');
    await cfg().update('subtasksHeading', undefined, vscode.ConfigurationTarget.WorkspaceFolder);

    // [[номер]] у task.md — посилання на task.md підзадачі
    const tasksDir = path.join(folder.uri.fsPath, 'Tasks');
    fs.mkdirSync(path.join(tasksDir, '1_new', '7.1'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, '1_new', '7'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, '1_new', '7.1', 'task.md'), '# Task 7.1\n\n- **Батьківська задача:** [[7]]\n', 'utf8');
    const parentFile = path.join(tasksDir, '1_new', '7', 'task.md');
    fs.writeFileSync(parentFile, '# Task 7\n\n## Підзадачі\n\n- [ ] [[7.1]] Частина\n', 'utf8');
    const doc = await vscode.workspace.openTextDocument(parentFile);
    const links = (await vscode.commands.executeCommand('vscode.executeLinkProvider', doc.uri)) || [];
    check(links.some((l) => l.target && l.target.fsPath.toLowerCase().endsWith(path.join('7.1', 'task.md').toLowerCase())), `[[7.1]] — посилання на task.md підзадачі (${links.length})`);
    // buildPrompt без діалогів (автозапуск промптів переходу): {dir}, кілька збігів — перший, маски без файлів лишаються
    const { buildPrompt } = require(path.join(ext.extensionPath, 'extension.js'));
    const t7 = path.join(tasksDir, '1_new', '7');
    fs.mkdirSync(path.join(t7, 'orig'), { recursive: true });
    fs.writeFileSync(path.join(t7, 'orig', 'task.md'), 'old', 'utf8');
    const bp = await buildPrompt(
      { folder: folder.uri.fsPath },
      { stages: defaults },
      { id: '7', title: 'Сім', stage: '1_new', dir: t7 },
      { text: 'Задача {number} ({stageTitle}) [task.md] [*.zip] → {dir}/{number}.2/' },
      { ask: false },
    );
    check(bp && bp.text === 'Задача 7 (Нове) @Tasks/1_new/7/task.md [*.zip] → Tasks/1_new/7.2/', `buildPrompt ask:false — ${bp && bp.text}`);
    check(bp && bp.missing.join() === '*.zip', 'buildPrompt: маска без файлів у missing');

    // перенесення запускає промпти переходу (00010.3): clipboard, кілька промптів — одним текстом, з нового каталогу
    const ext2 = require(path.join(ext.extensionPath, 'extension.js'));
    await cfg().update('promptOpenIn', 'clipboard', vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg().update(
      'transitions',
      [{ from: '1_new', to: '2_queue', actions: [{ type: 'prompt', run: 'each', prompts: [{ text: 'Перевірте [task.md] ({stageTitle})' }, { text: 'Задача {number}' }, { use: 'Немає' }] }] }],
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
    fs.mkdirSync(path.join(tasksDir, '1_new', '8'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, '1_new', '8', 'task.md'), '# Task 8\n\n- **Статус:** нове\n', 'utf8');
    await vscode.env.clipboard.writeText('');
    const ws8 = ext2.workspace();
    const ctx8 = ext2.model(ws8).boards[0];
    const t8 = ctx8 && ctx8.tasks.find((t) => t.id === '8');
    check(!!t8, 'задача 8 на дошці');
    if (t8) await ext2.move(ws8, ctx8, t8, '2_queue');
    check(fs.existsSync(path.join(tasksDir, '2_queue', '8', 'task.md')), 'задача 8 перенесена в 2_queue');
    const clip = await vscode.env.clipboard.readText();
    check(clip === 'Перевірте @Tasks/2_queue/8/task.md (В черзі)\n\n---\n\nЗадача 8', `промпт переходу в буфері обміну — ${JSON.stringify(clip)}`);
    await cfg().update('transitions', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await cfg().update('promptOpenIn', undefined, vscode.ConfigurationTarget.WorkspaceFolder);

    const projects = [
      { id: 'demo', title: 'Demo', aliases: ['demo-code'], color: 'green' },
      { id: 'own', title: 'Own', tasksDir: '../own/Tasks', stages: [{ dir: 'todo', title: 'To do' }] },
    ];
    await cfg().update('projects', projects, vscode.ConfigurationTarget.Workspace);
    check(cfg().get('projects').length === 2, 'запис проектів у налаштування робочої області');
    check(cfg().get('projects')[1].stages[0].dir === 'todo', 'власні колонки проекту зберігаються');

    await vscode.commands.executeCommand('taskKanban.open');
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    const tab = async (label) => {
      for (let i = 0; i < 20 && !tabs().includes(label); i++) await new Promise((r) => setTimeout(r, 100));
      return tabs().includes(label);
    };
    check(await tab('Проекти'), 'дашборд проектів відкривається');
    await vscode.commands.executeCommand('taskKanban.openBoard', 'demo');
    check(await tab('Канбан · Demo'), 'дошка проекту відкривається');
    await vscode.commands.executeCommand('taskKanban.openBoard', 'own');
    check(await tab('Канбан · Own'), 'дошка проекту з власним каталогом відкривається');
    await vscode.commands.executeCommand('taskKanban.openBoard', '*');
    check(await tab('Канбан · Усі задачі'), 'дошка всіх задач відкривається');
    await cfg().update('projects', undefined, vscode.ConfigurationTarget.Workspace);
  } catch (e) {
    check(false, `виняток: ${e.message}`);
  }
  const result = process.env.TASK_KANBAN_IT_RESULT;
  if (result) fs.writeFileSync(result, out.join('\n') + '\n', 'utf8');
  if (failed) throw new Error(out.join('\n'));
};
