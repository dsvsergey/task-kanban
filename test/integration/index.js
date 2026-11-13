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
