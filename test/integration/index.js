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
    for (const c of ['taskKanban.open', 'taskKanban.newTask', 'taskKanban.refresh', 'taskKanban.addColumn', 'taskKanban.resetColumns']) {
      check(cmds.includes(c), `команда ${c}`);
    }
    await vscode.commands.executeCommand('taskKanban.open');
    check(true, 'дошка відкривається');
  } catch (e) {
    check(false, `виняток: ${e.message}`);
  }
  const result = process.env.TASK_KANBAN_IT_RESULT;
  if (result) fs.writeFileSync(result, out.join('\n') + '\n', 'utf8');
  if (failed) throw new Error(out.join('\n'));
};
