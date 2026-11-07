'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./src/core');

let panel = null;
let busy = false;
let output = null;

function log(msg) {
  if (!output) output = vscode.window.createOutputChannel('Task Kanban');
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ---------- конфігурація і робоча область ----------

function workspace() {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const cfg = vscode.workspace.getConfiguration('taskKanban', folder.uri);
    const tasksRoot = path.join(folder.uri.fsPath, cfg.get('tasksDir', 'Tasks'));
    if (fs.existsSync(tasksRoot)) {
      return {
        folder: folder.uri.fsPath,
        tasksRoot,
        templateDir: cfg.get('templateDir', '_template'),
        stages: cfg.get('stages', []),
        transitions: cfg.get('transitions', []),
        commitMessage: cfg.get('commitMessage', '{number}'),
      };
    }
  }
  return null;
}

function requireWorkspace() {
  const ws = workspace();
  if (!ws) vscode.window.showWarningMessage('Task Kanban: у робочій області немає каталогу задач (taskKanban.tasksDir).');
  return ws;
}

// ---------- панель ----------

function openBoard(context) {
  const ws = requireWorkspace();
  if (!ws) return;
  if (panel) {
    panel.reveal();
    postState();
    return;
  }
  panel = vscode.window.createWebviewPanel('taskKanban', 'Канбан задач', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.iconPath = new vscode.ThemeIcon('project');
  panel.webview.html = html(panel.webview, context.extensionUri);
  panel.onDidDispose(() => (panel = null), null, context.subscriptions);
  panel.webview.onDidReceiveMessage((m) => onMessage(m, context), null, context.subscriptions);
}

function html(webview, extUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'board.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'board.js'));
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>Канбан задач</title>
</head>
<body>
<header class="toolbar">
  <input id="filter" type="search" placeholder="Фільтр: номер або текст" aria-label="Фільтр">
  <button id="new" title="Нова задача">+ Задача</button>
  <button id="refresh" title="Оновити">⟳</button>
  <span id="busy" class="busy" hidden>виконується…</span>
</header>
<main id="board" class="board"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function postState() {
  if (!panel) return;
  const ws = workspace();
  if (!ws) return;
  const tasks = core.scanTasks(ws.tasksRoot, ws.stages).map((t) => ({
    id: t.id,
    stage: t.stage,
    title: t.title,
    status: t.status,
    hasSql: t.hasSql,
    hasNotes: !!t.notesFile,
    zipVersion: t.zipVersion,
  }));
  panel.webview.postMessage({ type: 'state', stages: ws.stages, tasks, busy });
}

function setBusy(v) {
  busy = v;
  postState();
}

async function onMessage(m, context) {
  const ws = workspace();
  if (!ws) return;
  try {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        postState();
        break;
      case 'open': {
        const t = core.findTask(ws.tasksRoot, ws.stages, m.id);
        const file = t && (m.file === 'notes' ? t.notesFile : t.taskFile);
        if (file) await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        else if (t) vscode.window.showInformationMessage(`У задачі ${m.id} немає ${m.file === 'notes' ? 'notes.md' : 'task.md'}`);
        break;
      }
      case 'reveal': {
        const t = core.findTask(ws.tasksRoot, ws.stages, m.id);
        if (t) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(t.dir));
        break;
      }
      case 'move':
        await move(ws, m.id, m.to);
        break;
      case 'newTask':
        await newTask(context);
        break;
    }
  } catch (e) {
    log(`Помилка: ${e.message}`);
    vscode.window.showErrorMessage(`Task Kanban: ${e.message}`);
    postState();
  }
}

// ---------- перенесення ----------

async function move(ws, id, toDir) {
  if (busy) return;
  const task = core.findTask(ws.tasksRoot, ws.stages, id);
  if (!task || task.stage === toDir) return;
  const stage = ws.stages.find((s) => s.dir === toDir);
  const actions = core.matchTransitions(ws.transitions, task.stage, toDir);

  // перевірки — до перенесення
  for (const a of actions.filter((x) => x.type === 'check')) {
    const missing = core.missingFiles(task.dir, a.files);
    if (missing.length) {
      const go = await vscode.window.showWarningMessage(
        `У задачі ${id} немає: ${missing.join(', ')}. Перенести в «${stage.title || toDir}» все одно?`,
        { modal: true },
        'Перенести',
      );
      if (go !== 'Перенести') return postState();
    }
  }

  setBusy(true);
  try {
    let res;
    try {
      res = await core.moveTask(ws.tasksRoot, ws.stages, id, toDir);
    } catch (e) {
      if (e.code === 'LOCKED') {
        const terms = terminalsIn(task.dir);
        const hint = terms.length ? ` Термінал у цьому каталозі: ${terms.join(', ')}.` : '';
        throw new Error(`${id} не перенесено: ${e.message}${hint}`);
      }
      throw e;
    }
    log(`${id}: ${res.from || '(без етапу)'} → ${toDir}${res.statusUpdated ? ', статус оновлено' : ''}`);
    if (stage.status && !res.statusUpdated && res.task.taskFile) {
      const text = fs.readFileSync(res.task.taskFile, 'utf8');
      if (core.readStatus(text) !== stage.status) {
        vscode.window.showWarningMessage(`${id}: у task.md немає рядка «Статус» — оновіть вручну.`);
      }
    }
    postState();

    const commits = actions.filter((x) => x.type === 'commit');
    if (commits.length) await runCommits(ws, res.task, stage, commits);
  } finally {
    setBusy(false);
  }
}

/** Термінали VS Code, поточний каталог яких — усередині dir (потрібна інтеграція оболонки). */
function terminalsIn(dir) {
  const norm = (p) => path.resolve(p).toLowerCase() + path.sep;
  const base = norm(dir);
  const out = [];
  for (const t of vscode.window.terminals) {
    const cwd = t.shellIntegration && t.shellIntegration.cwd;
    if (cwd && norm(cwd.fsPath).startsWith(base)) out.push(`«${t.name}»`);
  }
  return out;
}

async function runCommits(ws, task, stage, commitActions) {
  const vars = {
    number: task.id,
    stage: stage.dir,
    status: stage.status || '',
    title: task.title || '',
    workspaceFolder: ws.folder,
  };
  const groups = [];
  for (const a of commitActions) {
    const g = await core.collectCommit(a, { workspaceFolder: ws.folder, task, vars });
    if (g.warning) {
      log(g.warning);
      vscode.window.showWarningMessage(g.warning);
    }
    const prev = groups.find((x) => x.repo === g.repo);
    if (prev) {
      for (const f of g.files) if (!prev.files.some((p) => p.path === f.path)) prev.files.push(f);
    } else if (g.files.length) groups.push(g);
  }
  if (!groups.length) {
    vscode.window.showInformationMessage(`${task.id}: змін для коміту немає.`);
    return;
  }

  const items = [];
  for (const g of groups) {
    items.push({ label: g.name, kind: vscode.QuickPickItemKind.Separator });
    for (const f of g.files) {
      items.push({ label: f.path, description: f.code.trim(), picked: true, group: g, file: f.path });
    }
  }
  const message = core.fill(ws.commitMessage, vars);
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Коміт «${message}» — задача ${task.id} → ${stage.title || stage.dir}`,
    placeHolder: 'Зніміть галочки з файлів, які не треба комітити; Esc — не комітити',
    ignoreFocusOut: true,
  });
  if (!picked || !picked.length) {
    log(`${task.id}: коміт скасовано`);
    return;
  }
  const done = [];
  for (const g of groups) {
    const files = picked.filter((p) => p.group === g).map((p) => p.file);
    if (!files.length) continue;
    const hash = await core.commitFiles(g.repo, files, message);
    log(`${g.name}: коміт ${hash} (${files.length} файл.)`);
    done.push(`${g.name} ${hash}`);
  }
  if (done.length) vscode.window.showInformationMessage(`${task.id}: закомічено — ${done.join(', ')}`);
}

// ---------- нова задача ----------

async function newTask() {
  const ws = requireWorkspace();
  if (!ws || !ws.stages.length) return;
  const id = await vscode.window.showInputBox({
    title: 'Нова задача',
    prompt: 'Номер задачі з трекера',
    validateInput: (v) => (/^[\w.-]+$/.test(v.trim()) ? null : 'Лише цифри, літери, _ . -'),
  });
  if (!id) return;
  const stage = ws.stages[0];
  const t = core.createTask(ws.tasksRoot, ws.templateDir, stage.dir, id.trim());
  if (stage.status && t.taskFile) {
    const text = fs.readFileSync(t.taskFile, 'utf8');
    const next = core.writeStatus(text, stage.status);
    if (next !== null) fs.writeFileSync(t.taskFile, next, 'utf8');
  }
  postState();
  if (t.taskFile) await vscode.window.showTextDocument(vscode.Uri.file(t.taskFile), { preview: false });
}

// ---------- активація ----------

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('taskKanban.open', () => openBoard(context)),
    vscode.commands.registerCommand('taskKanban.newTask', () => newTask()),
    vscode.commands.registerCommand('taskKanban.refresh', () => postState()),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(project) Задачі';
  status.tooltip = 'Відкрити канбан-дошку задач';
  status.command = 'taskKanban.open';
  context.subscriptions.push(status);

  let timer = null;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(postState, 300);
  };
  const setup = () => {
    const ws = workspace();
    if (ws) status.show();
    else status.hide();
  };
  setup();

  for (const folder of vscode.workspace.workspaceFolders || []) {
    const cfg = vscode.workspace.getConfiguration('taskKanban', folder.uri);
    const pattern = new vscode.RelativePattern(folder, `${cfg.get('tasksDir', 'Tasks')}/**`);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(refreshSoon);
    watcher.onDidDelete(refreshSoon);
    watcher.onDidChange(refreshSoon);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('taskKanban')) {
        setup();
        postState();
      }
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
