'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./src/core');

let dashboard = null; // дашборд проектів
const boards = new Map(); // id дошки → панель (id проекту; '*' — загальний каталог, '' — без проекту)
let lastBoard = null; // id дошки, що була активною останньою (для команд з палітри)
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
        effortField: cfg.get('effortField', 'Трудомісткість'),
        projectField: cfg.get('projectField', 'Проекти') || 'Проекти',
        parentField: cfg.get('parentField', core.DEFAULT_PARENT_FIELD) || core.DEFAULT_PARENT_FIELD,
        subtasksHeading: cfg.get('subtasksHeading', core.DEFAULT_SUBTASKS_HEADING) || core.DEFAULT_SUBTASKS_HEADING,
        projects: core.normalizeProjects(cfg.get('projects', [])),
        sessionOpenIn: cfg.get('sessionOpenIn', 'auto'),
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

/** Дошки всіх проектів: корінь задач, колонки, шаблон, переходи і задачі кожної. */
function model(ws) {
  return core.buildBoards({
    folder: ws.folder,
    tasksRoot: ws.tasksRoot,
    stages: ws.stages,
    transitions: ws.transitions,
    templateDir: ws.templateDir,
    projects: ws.projects,
    scan: scanOpts(ws),
  });
}

function scanOpts(ws) {
  return { effortField: ws.effortField, projectField: ws.projectField, parentField: ws.parentField, subtasksHeading: ws.subtasksHeading };
}

/** Шлях для показу: відносно робочої області, з «/». */
function relPath(ws, p) {
  const r = path.relative(ws.folder, p) || '.';
  return r.split(path.sep).join('/');
}

// ---------- панель ----------

const ALL = '*';
const NONE = '';

function createPanel(context, viewType, title, kind, onMsg) {
  const p = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  p.webview.html = html(p.webview, context.extensionUri, kind);
  p.webview.onDidReceiveMessage(onMsg, null, context.subscriptions);
  return p;
}

/** Дашборд проектів — точка входу: звідси відкриваються дошки проектів. */
function openDashboard(context) {
  const ws = requireWorkspace();
  if (!ws) return;
  if (dashboard) {
    dashboard.reveal();
    postState();
    return;
  }
  dashboard = createPanel(context, 'taskKanban.dashboard', 'Проекти', 'dashboard', (m) => onMessage(m, context, null));
  dashboard.iconPath = new vscode.ThemeIcon('dashboard');
  dashboard.onDidDispose(() => (dashboard = null), null, context.subscriptions);
}

/** Канбан-дошка проекту: його каталог задач і його колонки. Для кожного проекту — своя вкладка. */
function openBoard(context, boardId = ALL) {
  const ws = requireWorkspace();
  if (!ws) return;
  const m = model(ws);
  let id = boardId === undefined || boardId === null ? ALL : String(boardId);
  if (!m.get(id) && id === ALL && m.boards.length) id = m.boards[0].id; // загальний каталог належить проекту
  const existing = boards.get(id);
  if (existing) {
    existing.reveal();
    postState();
    return;
  }
  const p = createPanel(context, 'taskKanban', boardTitle(m.get(id), id), 'board', (msg) => onMessage(msg, context, id));
  p.iconPath = new vscode.ThemeIcon('project');
  boards.set(id, p);
  lastBoard = id;
  p.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) lastBoard = id;
  });
  p.onDidDispose(() => {
    boards.delete(id);
    if (lastBoard === id) lastBoard = null;
  }, null, context.subscriptions);
}

function ctxTitle(ctx, id) {
  if (!ctx) return id === ALL ? 'Усі задачі' : id === NONE ? 'Без проекту' : id;
  if (ctx.kind === 'all') return 'Усі задачі';
  if (ctx.kind === 'none') return 'Без проекту';
  return ctx.project.title;
}

function boardTitle(ctx, id) {
  return `Канбан · ${ctxTitle(ctx, id)}`;
}

function html(webview, extUri, kind) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', `${kind}.css`));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', `${kind}.js`));
  const body =
    kind === 'dashboard'
      ? `<header class="top">
  <div class="top-title">
    <h1>Проекти</h1>
    <span id="subtitle" class="muted"></span>
  </div>
  <div class="top-tools">
    <input id="filter" type="search" placeholder="Пошук проекту" aria-label="Пошук проекту">
    <button id="addProject" title="Новий проект">+ Проект</button>
    <button id="refresh" class="ghost" title="Оновити">⟳</button>
  </div>
</header>
<span id="busy" class="busy" hidden>виконується…</span>
<main id="root" class="root"></main>
<div id="tip" class="tip" role="tooltip" hidden></div>`
      : `<header class="toolbar">
  <button id="back" class="secondary" title="До дашборду проектів">← Проекти</button>
  <span id="project" class="project"></span>
  <input id="filter" type="search" placeholder="Фільтр: номер або текст" aria-label="Фільтр">
  <button id="new" title="Нова задача">+ Задача</button>
  <button id="addColumn" class="secondary" title="Додати колонку">+ Колонка</button>
  <button id="refresh" title="Оновити">⟳</button>
  <span id="busy" class="busy" hidden>виконується…</span>
</header>
<main id="board" class="board"></main>`;
  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>${kind === 'dashboard' ? 'Проекти' : 'Канбан задач'}</title>
</head>
<body>
${body}
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function projectView(ws, ctx) {
  if (ctx.kind !== 'project') return { id: ctx.id, title: ctxTitle(ctx), virtual: true, tasksDir: relPath(ws, ctx.root) };
  const p = ctx.project;
  const v = { id: p.id, title: p.title, color: p.color, configured: !!p.configured, ownRoot: ctx.ownRoot, ownStages: ctx.ownStages };
  v.tasksDir = relPath(ws, ctx.root);
  if (p.description) v.description = p.description;
  if (p.aliases) v.aliases = p.aliases;
  return v;
}

function boardState(ws, m, id) {
  const ctx = m.get(id);
  if (!ctx) return { type: 'state', stages: [], tasks: [], project: { id, title: id, missing: true }, busy, moveTargets: 0 };
  const color = (pid) => {
    const b = m.get(pid);
    return b && b.project ? b.project.color : '';
  };
  // підзадачі — по всіх задачах каталогу: батьківська може бути на дошці іншого проекту
  const all = ctx.rootTasks || ctx.tasks;
  const links = core.linkSubtasks(all);
  const byId = new Map(all.map((t) => [t.id, t]));
  const onBoard = new Set(ctx.tasks.map((t) => t.id));
  const done = core.doneStages(ctx.stages);
  const brief = (id) => {
    const t = byId.get(id);
    return t ? { id, title: t.title, stage: t.stage, done: done.has(t.stage), onBoard: onBoard.has(id) } : { id, missing: true };
  };
  const tasks = ctx.tasks.map((t) => ({
    id: t.id,
    parent: links.get(t.id).parent ? brief(links.get(t.id).parent) : null,
    children: links.get(t.id).children.map(brief),
    missingChildren: links.get(t.id).missing,
    plan: t.subtasks.filter((x) => !x.id).length,
    stage: t.stage,
    title: t.title,
    status: t.status,
    effort: t.effort,
    hasSql: t.hasSql,
    hasNotes: !!t.notesFile,
    zipVersion: t.zipVersion,
    projects: ctx.projectsOf(t).map((pid) => {
      const b = m.get(pid);
      return { id: pid, title: b ? ctxTitle(b) : pid, color: color(pid) };
    }),
  }));
  // куди можна перенести задачу каталогом: інші корені
  const moveTargets = m.boards.filter((b) => b.kind === 'project' && !core.samePath(b.root, ctx.root)).length;
  return { type: 'state', stages: ctx.stages, tasks, project: projectView(ws, ctx), busy, moveTargets };
}

const RECENT = 4;

function summary(ctx) {
  const done = core.doneStages(ctx.stages);
  const recent = ctx.tasks
    .filter((t) => !done.has(t.stage))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, RECENT)
    .map((t) => ({ id: t.id, title: t.title, stage: t.stage, effort: t.effort }));
  return {
    stats: core.projectStats(ctx.tasks, ctx.stages),
    recent,
    stages: ctx.stages.map((s) => ({ dir: s.dir, title: s.title || s.dir, done: done.has(s.dir) })),
  };
}

function dashboardState(ws, m) {
  const projects = m.boards.filter((b) => b.kind === 'project').map((b) => ({ ...projectView(ws, b), ...summary(b) }));
  // підсумок — по унікальних задачах: каталог задачі рахується один раз
  const seen = new Set();
  const total = { total: 0, active: 0, done: 0, effortMinutes: 0, withEffort: 0, updated: 0 };
  const add = (ctx) => {
    const fresh = ctx.tasks.filter((t) => !seen.has(t.dir.toLowerCase()) && seen.add(t.dir.toLowerCase()));
    const s = core.projectStats(fresh, ctx.stages);
    for (const k of Object.keys(total)) total[k] = k === 'updated' ? Math.max(total[k], s[k]) : total[k] + s[k];
  };
  for (const b of m.boards) if (b.kind === 'project') add(b);
  const all = m.get(ALL);
  if (all) add(all);
  const none = m.get(NONE);
  return {
    type: 'state',
    folder: path.basename(ws.folder),
    projects,
    total,
    // загальний каталог, коли він не належить проекту; «без проекту» — якщо там є і задачі проектів, і без
    all: all && (all.tasks.length || !projects.length) ? { ...projectView(ws, all), ...summary(all) } : null,
    none: none && none.tasks.length && none.tasks.length !== all.tasks.length ? { ...projectView(ws, none), ...summary(none) } : null,
    busy,
  };
}

function postState() {
  if (!dashboard && !boards.size) return;
  const ws = workspace();
  if (!ws) return;
  const m = model(ws);
  if (dashboard) dashboard.webview.postMessage(dashboardState(ws, m));
  for (const [id, p] of boards) {
    p.title = boardTitle(m.get(id), id);
    p.webview.postMessage(boardState(ws, m, id));
  }
}

function setBusy(v) {
  busy = v;
  postState();
}

/** Контекст дошки: явний id, інакше дошка, з якої прийшла дія, інакше остання активна. */
function boardCtx(ws, id) {
  const m = model(ws);
  return m.get(id !== undefined && id !== null ? id : lastBoard !== null ? lastBoard : ALL) || m.boards[0] || null;
}

/** scope — id дошки, з якої прийшло повідомлення; null — дашборд (тоді проект — у m.project). */
async function onMessage(m, context, scope) {
  const ws = workspace();
  if (!ws) return;
  const where = scope !== null && scope !== undefined ? scope : m.project;
  const findTask = () => {
    const ctx = boardCtx(ws, where);
    if (!ctx) return { ctx: null, task: null };
    // підзадача з дошки іншого проекту того самого каталогу — теж відкривається зі списку підзадач
    const task = ctx.tasks.find((t) => t.id === m.id) || (ctx.rootTasks || []).find((t) => t.id === m.id) || null;
    return { ctx, task };
  };
  try {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        postState();
        break;
      case 'dashboard':
        openDashboard(context);
        break;
      case 'openBoard':
        openBoard(context, m.project);
        break;
      case 'addProject':
        await addProject();
        break;
      case 'editProject':
        await editProject(m.project);
        break;
      case 'deleteProject':
        await deleteProject(m.project);
        break;
      case 'setProjects':
        await setProjects(where, m.id);
        break;
      case 'addSubtask':
        await addSubtask(where, m.id);
        break;
      case 'moveToProject':
        await moveToProject(where, m.id);
        break;
      case 'deleteTask':
        await deleteTask(where, m.id);
        break;
      case 'open': {
        const { task: t } = findTask();
        const file = t && (m.file === 'notes' ? t.notesFile : t.taskFile);
        if (file) await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        else if (t) vscode.window.showInformationMessage(`У задачі ${m.id} немає ${m.file === 'notes' ? 'notes.md' : 'task.md'}`);
        break;
      }
      case 'reveal': {
        const { task: t } = findTask();
        if (t) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(t.dir));
        break;
      }
      case 'sessions':
        await pickTaskSession(m.id);
        break;
      case 'move': {
        const { ctx, task } = findTask();
        if (ctx && task) await move(ws, ctx, task, m.to);
        break;
      }
      case 'newTask':
        await newTask(m.project !== undefined ? m.project : scope);
        break;
      case 'addColumn':
        await addColumn(where, m.after);
        break;
      case 'editColumn':
        await editColumn(where, m.dir);
        break;
      case 'moveColumn': {
        const ctx = boardCtx(ws, where);
        if (ctx) await saveStages(ctx, core.moveStage(ctx.stages, m.dir, m.delta));
        break;
      }
      case 'deleteColumn':
        await deleteColumn(where, m.dir);
        break;
    }
  } catch (e) {
    log(`Помилка: ${e.message}`);
    vscode.window.showErrorMessage(`Task Kanban: ${e.message}`);
    postState();
  }
}

// ---------- перенесення ----------

function lockedError(task, e, verb = 'перенесено') {
  if (e.code !== 'LOCKED') return e;
  const terms = terminalsIn(task.dir);
  const hint = terms.length ? ` Термінал у цьому каталозі: ${terms.join(', ')}.` : '';
  return new Error(`${task.id} не ${verb}: ${e.message}${hint}`);
}

async function move(ws, ctx, task, toDir) {
  if (busy || task.stage === toDir) return;
  const stage = ctx.stages.find((s) => s.dir === toDir);
  if (!stage) return;
  const actions = core.matchTransitions(ctx.transitions, task.stage, toDir);
  const done = core.doneStages(ctx.stages);
  const rootTasks = ctx.rootTasks || ctx.tasks;
  const links = core.linkSubtasks(rootTasks);

  // у завершену колонку — попередити про незавершені підзадачі
  if (done.has(toDir) && !done.has(task.stage)) {
    const open = links
      .get(task.id)
      .children.map((id) => rootTasks.find((t) => t.id === id))
      .filter((t) => t && !done.has(t.stage));
    if (open.length) {
      const go = await vscode.window.showWarningMessage(
        `У задачі ${task.id} незавершені підзадачі: ${open.map((t) => t.id).join(', ')}. Перенести в «${stage.title || toDir}» все одно?`,
        { modal: true },
        'Перенести',
      );
      if (go !== 'Перенести') return postState();
    }
  }

  // перевірки — до перенесення
  for (const a of actions.filter((x) => x.type === 'check')) {
    const missing = core.missingFiles(task.dir, a.files);
    if (missing.length) {
      const go = await vscode.window.showWarningMessage(
        `У задачі ${task.id} немає: ${missing.join(', ')}. Перенести в «${stage.title || toDir}» все одно?`,
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
      res = await core.moveTaskToRoot(task, ctx.root, stage);
    } catch (e) {
      throw lockedError(task, e);
    }
    log(`${task.id}: ${task.stage || '(без етапу)'} → ${toDir}${res.statusUpdated ? ', статус оновлено' : ''}`);
    warnStatus(task.id, stage, res);
    checkInParent(ws, rootTasks, links.get(task.id).parent, task.id, done.has(toDir));
    postState();

    const commits = actions.filter((x) => x.type === 'commit');
    if (commits.length) await runCommits(ws, ctx, res.task, stage, commits);
  } finally {
    setBusy(false);
  }
}

function warnStatus(id, stage, res) {
  if (stage.status && !res.statusUpdated && res.task.taskFile) {
    const text = fs.readFileSync(res.task.taskFile, 'utf8');
    if (core.readStatus(text) !== stage.status) {
      vscode.window.showWarningMessage(`${id}: у task.md немає рядка «Статус» — оновіть вручну.`);
    }
  }
}

/** Галочка підзадачі в розділі «Підзадачі» батьківської задачі: стоїть, коли підзадача в завершеній колонці. */
function checkInParent(ws, rootTasks, parentId, id, isDone) {
  const parent = parentId && rootTasks.find((t) => t.id === parentId);
  if (!parent || !parent.taskFile) return;
  try {
    const text = fs.readFileSync(parent.taskFile, 'utf8');
    const next = core.setSubtaskChecked(text, id, isDone, ws.subtasksHeading);
    if (next !== text) {
      fs.writeFileSync(parent.taskFile, next, 'utf8');
      log(`${parentId}: підзадача ${id} — ${isDone ? '[x]' : '[ ]'}`);
    }
  } catch (e) {
    log(`${parentId}: не вдалося оновити галочку ${id}: ${e.message}`);
  }
}

/** Перенесення каталогу задачі в інший проект (інший корінь задач). */
async function moveToProject(where, taskId) {
  const ws = requireWorkspace();
  if (!ws || busy) return;
  const m = model(ws);
  const ctx = m.get(where);
  const task = ctx && ctx.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const targets = m.boards.filter((b) => b.kind === 'project' && !core.samePath(b.root, ctx.root));
  if (!targets.length) {
    vscode.window.showInformationMessage('Інших проектів з окремим каталогом задач немає.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    targets.map((b) => ({ label: b.project.title, description: relPath(ws, b.root), ctx: b })),
    { title: `Перенести задачу ${taskId} в проект`, placeHolder: 'Каталог задачі переїде в каталог задач вибраного проекту' },
  );
  if (!pick) return;
  const dst = pick.ctx;
  if (!dst.stages.length) throw new Error(`У проекту ${dst.project.title} немає колонок`);
  // та сама колонка, якщо вона є в проекті, інакше — вибрати
  let stage = dst.stages.find((s) => s.dir === task.stage);
  if (!stage) {
    const sp = await vscode.window.showQuickPick(
      dst.stages.map((s) => ({ label: s.title || s.dir, description: s.dir, stage: s })),
      { title: `Колонка в проекті ${dst.project.title}` },
    );
    if (!sp) return;
    stage = sp.stage;
  }
  setBusy(true);
  try {
    let res;
    try {
      res = await core.moveTaskToRoot(task, dst.root, stage);
    } catch (e) {
      throw lockedError(task, e);
    }
    if (res.task.taskFile) {
      const text = fs.readFileSync(res.task.taskFile, 'utf8');
      const next = core.writeField(text, ws.projectField, dst.project.title);
      if (next !== text) fs.writeFileSync(res.task.taskFile, next, 'utf8');
    }
    log(`${taskId}: ${relPath(ws, task.dir)} → ${relPath(ws, res.task.dir)}`);
    warnStatus(taskId, stage, res);
  } finally {
    setBusy(false);
  }
}

// ---------- видалення ----------

/** Вкладки редактора з файлами каталогу dir: { clean, dirty }. */
function tabsIn(dir) {
  const base = path.resolve(dir).toLowerCase() + path.sep;
  const clean = [];
  const dirty = [];
  for (const g of vscode.window.tabGroups.all) {
    for (const tab of g.tabs) {
      const uri = tab.input && tab.input.uri;
      if (!uri || uri.scheme !== 'file' || !path.resolve(uri.fsPath).toLowerCase().startsWith(base)) continue;
      (tab.isDirty ? dirty : clean).push(tab);
    }
  }
  return { clean, dirty };
}

/** Підзадачі задачі з усіма їхніми підзадачами — знизу вгору (спершу найглибші). */
function descendants(links, find, id, seen = new Set([id])) {
  const out = [];
  for (const c of (links.get(id) || { children: [] }).children) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(...descendants(links, find, c, seen));
    const t = find(c);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Каталог задачі — у Кошик; не вийшло — після підтвердження назавжди. Зайнятий каталог не чіпається:
 * спершу пробне перейменування туди й назад (Кошик на зайнятому каталозі може видалити лише частину файлів).
 * Повертає 'trash' | 'permanent' | null (видалення назавжди скасовано).
 */
async function removeTaskDir(task) {
  const probe = path.join(path.dirname(task.dir), `_checking-${task.id}-${Date.now()}`);
  try {
    await core.renameWithRetry(task.dir, probe);
  } catch (e) {
    throw lockedError(task, e, 'видалено');
  }
  try {
    await core.renameWithRetry(probe, task.dir);
  } catch (e) {
    throw new Error(`${task.id}: не вдалося повернути каталог після перевірки — він лишився як ${probe} (${e.message})`);
  }
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(task.dir), { recursive: true, useTrash: true });
    return 'trash';
  } catch (e) {
    if (!fs.existsSync(task.dir)) return 'trash';
    log(`${task.id}: Кошик — ${e.message}`);
    const ok = await vscode.window.showWarningMessage(
      `${task.id}: не вдалося перенести каталог у Кошик (${e.message}). Видалити назавжди?`,
      { modal: true },
      'Видалити назавжди',
    );
    if (ok !== 'Видалити назавжди') return null;
    try {
      await core.deleteTaskDir(task.dir);
    } catch (e2) {
      throw lockedError(task, e2, 'видалено');
    }
    return 'permanent';
  }
}

/** Прибирає звʼязки з видаленими задачами: пункти [[номер]] у розділах підзадач і поле батьківської задачі. */
function unlinkDeleted(ws, rootTasks, deletedIds) {
  const gone = new Set(deletedIds.map((x) => x.toLowerCase()));
  for (const t of rootTasks) {
    if (gone.has(t.id.toLowerCase()) || !t.taskFile) continue;
    const linked = (t.subtasks || []).filter((x) => x.id && gone.has(x.id.toLowerCase())).map((x) => x.id);
    const orphan = t.parent && gone.has(t.parent.toLowerCase());
    if (!linked.length && !orphan) continue;
    try {
      const text = fs.readFileSync(t.taskFile, 'utf8');
      let next = text;
      for (const id of linked) next = core.removeSubtaskLink(next, id, ws.subtasksHeading);
      if (orphan) next = core.removeField(next, ws.parentField);
      if (next !== text) {
        fs.writeFileSync(t.taskFile, next, 'utf8');
        log(`${t.id}: прибрано звʼязок з ${[...linked, ...(orphan ? [t.parent] : [])].join(', ')}`);
      }
    } catch (e) {
      log(`${t.id}: не вдалося прибрати звʼязок з видаленими задачами: ${e.message}`);
    }
  }
}

/** Видалення задачі з дошки: підтвердження, каталог — у Кошик, звʼязки з підзадачами/батьківською прибираються. */
async function deleteTask(where, taskId) {
  const ws = requireWorkspace();
  if (!ws || busy) return;
  const ctx = model(ws).get(where);
  const task = ctx && ctx.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const rootTasks = ctx.rootTasks || ctx.tasks;
  const links = core.linkSubtasks(rootTasks);
  const find = (id) => rootTasks.find((t) => t.id === id);
  const parent = links.get(task.id).parent ? find(links.get(task.id).parent) : null;
  const kids = descendants(links, find, task.id);

  const DEL = 'Видалити';
  const DEL_ALL = `Видалити з підзадачами (${kids.length})`;
  const detail = [`Каталог ${relPath(ws, task.dir)} (файлів: ${core.walk(task.dir).length}) буде перенесено в Кошик.`];
  if (parent) detail.push(`З розділу «${ws.subtasksHeading}» задачі ${parent.id} буде прибрано пункт [[${task.id}]].`);
  if (kids.length) {
    detail.push(
      `Підзадачі: ${kids.map((t) => t.id).join(', ')}. «${DEL}» — вони лишаться окремими задачами (поле «${ws.parentField}» ` +
        `буде прибрано); «${DEL_ALL}» — будуть видалені теж.`,
    );
  }
  const pick = await vscode.window.showWarningMessage(
    `Видалити задачу ${task.id}${task.title ? ' — ' + task.title : ''}?`,
    { modal: true, detail: detail.join('\n\n') },
    DEL,
    ...(kids.length ? [DEL_ALL] : []),
  );
  if (pick !== DEL && pick !== DEL_ALL) return;
  const victims = pick === DEL_ALL ? [...kids, task] : [task];

  const dirty = victims.flatMap((t) => tabsIn(t.dir).dirty);
  if (dirty.length) {
    vscode.window.showWarningMessage(`Незбережені зміни: ${dirty.map((t) => t.label).join(', ')}. Збережіть або закрийте ці файли і повторіть.`);
    return;
  }

  setBusy(true);
  const deleted = [];
  let permanent = false;
  try {
    for (const t of victims) {
      const tabs = tabsIn(t.dir).clean;
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      const how = await removeTaskDir(t);
      if (!how) break;
      if (how === 'permanent') permanent = true;
      deleted.push(t.id);
      log(`${t.id}: видалено ${how === 'trash' ? 'в Кошик' : 'назавжди'} — ${relPath(ws, t.dir)}`);
    }
  } finally {
    unlinkDeleted(ws, rootTasks, deleted);
    setBusy(false);
  }
  if (deleted.length) {
    vscode.window.showInformationMessage(
      `Видалено: ${deleted.join(', ')}${permanent ? '' : ' — каталоги в Кошику, їх можна відновити'}.`,
    );
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

async function runCommits(ws, ctx, task, stage, commitActions) {
  const vars = {
    number: task.id,
    stage: stage.dir,
    status: stage.status || '',
    title: task.title || '',
    workspaceFolder: ws.folder,
    tasksRoot: ctx.root, // корінь задач проекту — для repo/paths переходів проекту з власним каталогом
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

// ---------- сесії Claude Code ----------

const sessionCache = new Map();

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Список сесій Claude Code, у яких виконувалась задача, і відкриття вибраної. */
async function pickTaskSession(id) {
  const ws = requireWorkspace();
  if (!ws) return;
  if (!id) {
    id = await vscode.window.showInputBox({ title: 'Сесії Claude Code задачі', prompt: 'Номер задачі' });
    if (!id) return;
    id = id.trim();
  }
  const dir = core.claudeProjectDir(claudeDir(), ws.folder);
  const sessions = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Пошук сесій задачі ${id}` },
    () => core.findTaskSessions(dir, id, sessionCache),
  );
  if (!sessions.length) {
    vscode.window.showInformationMessage(`Сесій Claude Code із задачею ${id} не знайдено (${dir}).`);
    return;
  }
  const items = sessions.map((s) => ({
    label: `${s.primary ? '$(star-full)' : '$(comment-discussion)'} ${s.title}`,
    description: fmtDate(s.end),
    detail: [s.primary ? 'почалася з цієї задачі' : 'задача згадується', s.firstPrompt && s.firstPrompt !== s.title ? s.firstPrompt : '']
      .filter(Boolean)
      .join(' · '),
    session: s,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `Сесії Claude Code — задача ${id}`,
    placeHolder: 'Вибрати сесію, щоб відкрити її',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick) await openSession(ws, id, pick.session);
}

async function openSession(ws, id, s) {
  if (ws.sessionOpenIn !== 'terminal') {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes('claude-vscode.primaryEditor.open')) {
      log(`${id}: відкриваю сесію ${s.sessionId} у Claude Code`);
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', s.sessionId);
      return;
    }
    if (ws.sessionOpenIn === 'extension') {
      vscode.window.showWarningMessage('Розширення Claude Code не знайдено — відкриваю сесію в терміналі.');
    }
  }
  log(`${id}: claude --resume ${s.sessionId} у терміналі`);
  const term = vscode.window.createTerminal({ name: `Claude · ${id}`, cwd: ws.folder });
  term.show();
  term.sendText(`claude --resume ${s.sessionId}`);
}

// ---------- налаштування ----------

function workspaceFolderUri(ws) {
  const f = (vscode.workspace.workspaceFolders || []).find((x) => x.uri.fsPath === ws.folder);
  return f ? f.uri : undefined;
}

/** Записує taskKanban.<key> у налаштування проекту (.vscode/settings.json). undefined — прибрати перевизначення. */
async function saveSetting(key, value) {
  const ws = workspace();
  if (!ws) return;
  const cfg = vscode.workspace.getConfiguration('taskKanban', workspaceFolderUri(ws));
  // одна папка — налаштування робочої області (той самий .vscode/settings.json);
  // робочий простір з кількох папок (.code-workspace) — налаштування саме цієї папки
  const target = vscode.workspace.workspaceFile
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  await cfg.update(key, value, target);
}

/**
 * Записує колонки дошки: проекту з власним каталогом — у його stages (taskKanban.projects),
 * інакше — загальні taskKanban.stages. undefined — повернути стандартні / загальні.
 */
async function saveStages(ctx, stages) {
  const ws = workspace();
  if (!ws) return;
  // проект, якому належить спільний каталог (taskKanban.tasksDir), користується загальними колонками
  if (ctx && ctx.ownRoot && ctx.project && ctx.project.configured && (ctx.ownStages || !core.samePath(ctx.root, ws.tasksRoot))) {
    const id = ctx.project.id;
    await saveProjects(
      ws.projects.map((p) => {
        if (p.id !== id) return p;
        const n = { ...p };
        if (stages) n.stages = stages;
        else delete n.stages;
        return n;
      }),
      false,
    );
    log(`${id}: колонки ${stages ? stages.map((s) => s.dir).join(', ') : '— загальні'}`);
  } else {
    await saveSetting('stages', stages);
    log(stages ? `Колонки: ${stages.map((s) => s.dir).join(', ')}` : 'Колонки: стандартний список');
  }
  postState();
}

// ---------- проекти ----------

const COLOR_NAMES = { blue: 'Синій', green: 'Зелений', purple: 'Фіолетовий', orange: 'Помаранчевий', red: 'Червоний', yellow: 'Жовтий' };

async function saveProjects(projects, logIt = true) {
  await saveSetting('projects', projects.length ? projects : undefined);
  if (logIt) log(`Проекти: ${projects.map((p) => p.id).join(', ') || '—'}`);
  postState();
}

function splitList(v) {
  return String(v || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Пропонований каталог задач нового проекту: поруч із <Name>Add — ../<id>Add/Tasks, інакше Tasks/<id>. */
function suggestTasksDir(ws, id) {
  const tasks = path.basename(ws.tasksRoot);
  if (/Add$/i.test(path.basename(ws.folder))) return `../${id}Add/${tasks}`;
  return `${tasks}/${id}`;
}

function validateTasksDir(ws, value, selfId) {
  const v = String(value || '').trim();
  if (!v) return 'Вкажіть каталог';
  const abs = path.resolve(ws.folder, v);
  for (const b of model(ws).boards) {
    if (b.kind !== 'project' || !b.ownRoot || b.project.id === selfId) continue;
    if (core.samePath(b.root, abs)) return `Цей каталог уже належить проекту ${b.project.title}`;
  }
  return null;
}

/** Діалоги назви, каталогу задач, псевдонімів, опису і кольору. Повертає проект або undefined (Esc). */
async function projectDialog(ws, step, init, isNew) {
  const title = await vscode.window.showInputBox({
    title: `${step} — назва`,
    prompt: 'Назва проекту на дашборді і в рядку «Проекти» нових задач',
    value: init.title || '',
    validateInput: (v) => (v.trim() ? null : 'Вкажіть назву'),
  });
  if (!title) return;
  const tasksDir = await vscode.window.showInputBox({
    title: `${step} — каталог задач`,
    prompt:
      'Свій каталог задач проекту відносно робочої області: у ньому — каталоги колонок, _template і задачі ' +
      '(<каталог>/<етап>/<номер>/). Порожньо — спільний каталог, задачі за рядком «Проекти».',
    value: init.tasksDir !== undefined ? init.tasksDir : isNew ? suggestTasksDir(ws, core.slugify(title) || 'project') : '',
    validateInput: (v) => (v.trim() ? validateTasksDir(ws, v, init.id) : null),
  });
  if (tasksDir === undefined) return;
  const aliases = await vscode.window.showInputBox({
    title: `${step} — псевдоніми`,
    prompt: 'Інші назви цього проекту в рядку «Проекти» задач, через кому (порожньо — немає)',
    placeHolder: 'напр. ultra-delphi, Ultra',
    value: (init.aliases || []).join(', '),
  });
  if (aliases === undefined) return;
  const description = await vscode.window.showInputBox({
    title: `${step} — опис`,
    prompt: 'Короткий опис для картки на дашборді (порожньо — немає)',
    value: init.description || '',
  });
  if (description === undefined) return;
  const pick = await vscode.window.showQuickPick(
    core.PROJECT_COLORS.map((c) => ({ label: COLOR_NAMES[c] || c, description: c === init.color ? 'поточний' : '', color: c })),
    { title: `${step} — колір`, placeHolder: 'Колір проекту на дашборді і дошці' },
  );
  if (!pick) return;
  // решта полів (stages, transitions, templateDir) зберігається як була
  const p = { ...init, title: title.trim(), color: pick.color };
  delete p.configured;
  delete p.aliases;
  delete p.description;
  delete p.tasksDir;
  if (tasksDir.trim()) p.tasksDir = tasksDir.trim().replace(/\\/g, '/');
  const al = splitList(aliases).filter((a) => a.toLowerCase() !== p.title.toLowerCase());
  if (al.length) p.aliases = al;
  if (description.trim()) p.description = description.trim();
  return p;
}

/** Створює каталог задач проекту: колонки (свої = копія загальних) і шаблон. */
function prepareRoot(ws, p) {
  if (!p.tasksDir) return p;
  const root = path.resolve(ws.folder, p.tasksDir);
  if (core.samePath(root, ws.tasksRoot)) return p;
  const n = { ...p };
  if (!n.stages || !n.stages.length) n.stages = ws.stages.map((s) => ({ ...s }));
  core.initProjectRoot(root, n.stages, path.resolve(ws.tasksRoot, ws.templateDir), p.templateDir || ws.templateDir);
  log(`${p.id}: каталог задач ${relPath(ws, root)} (${n.stages.map((s) => s.dir).join(', ')})`);
  return n;
}

async function addProject(init = {}) {
  const ws = requireWorkspace();
  if (!ws) return;
  const taken = new Set(ws.projects.map((p) => p.id.toLowerCase()));
  const draft = await projectDialog(ws, 'Новий проект', init, true);
  if (!draft) return;
  let suggested = core.slugify(draft.title) || 'project';
  for (let n = 2; taken.has(suggested.toLowerCase()); n++) suggested = `${core.slugify(draft.title) || 'project'}-${n}`;
  const id = await vscode.window.showInputBox({
    title: 'Новий проект — ідентифікатор',
    prompt: 'Незмінний ідентифікатор (латиницею); за ним проект зберігається в taskKanban.projects',
    value: suggested,
    validateInput: (v) => {
      const s = v.trim();
      if (!/^[\w.-]+$/.test(s)) return 'Лише латиниця, цифри, _ . -';
      return taken.has(s.toLowerCase()) ? `Проект ${s} уже є` : null;
    },
  });
  if (!id) return;
  const p = prepareRoot(ws, { ...draft, id: id.trim() });
  await saveProjects([...ws.projects, p]);
}

async function editProject(id) {
  const ws = requireWorkspace();
  if (!ws) return;
  const p = ws.projects.find((x) => x.id === id);
  if (!p) {
    // проект лише згадано в задачах — додати його в налаштування; стара назва лишається псевдонімом
    return addProject({ title: id, aliases: [id], tasksDir: '' });
  }
  const next = await projectDialog(ws, `Проект ${p.id}`, p, false);
  if (!next) return;
  if ((next.tasksDir || '') !== (p.tasksDir || '')) {
    const ok = await vscode.window.showWarningMessage(
      `Змінити каталог задач проекту «${p.title}» на ${next.tasksDir || 'спільний'}? Задачі не переносяться — ` +
        'наявні каталоги задач перенесіть вручну або кнопкою ⇄ на картках.',
      { modal: true },
      'Змінити',
    );
    if (ok !== 'Змінити') return;
  }
  await saveProjects(ws.projects.map((x) => (x.id === id ? prepareRoot(ws, next) : x)));
}

async function deleteProject(id) {
  const ws = requireWorkspace();
  const p = ws && ws.projects.find((x) => x.id === id);
  if (!p) return;
  const where = p.tasksDir ? ` Каталог задач ${p.tasksDir} лишається на диску.` : '';
  const ok = await vscode.window.showWarningMessage(
    `Видалити проект «${p.title}» з налаштувань? Задачі не змінюються.${where}`,
    { modal: true },
    'Видалити',
  );
  if (ok !== 'Видалити') return;
  const b = boards.get(id);
  if (b) b.dispose();
  await saveProjects(ws.projects.filter((x) => x.id !== id));
}

/** Проекти задачі в спільному каталозі: рядок «Проекти» в task.md; примітки в дужках зберігаються. */
async function setProjects(where, taskId) {
  const ws = requireWorkspace();
  if (!ws) return;
  const m = model(ws);
  const ctx = m.get(where);
  const task = ctx && ctx.tasks.find((t) => t.id === taskId);
  if (!task || !task.taskFile) return;
  if (ctx.ownRoot) return moveToProject(where, taskId);
  const shared = m.boards.filter((b) => b.kind === 'project' && !b.ownRoot).map((b) => b.project);
  const current = ctx.projectsOf(task);
  const items = shared.map((p) => ({
    label: p.title,
    description: p.configured ? p.id : 'немає в налаштуваннях',
    picked: current.includes(p.id),
    id: p.id,
  }));
  items.push({ label: '$(add) Інша назва…', alwaysShow: true, other: true });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Проекти задачі ${taskId}`,
    placeHolder: 'Позначте проекти задачі (нічого — прибрати); у проект з окремим каталогом — кнопка ⇄',
  });
  if (!picked) return;
  const ids = picked.filter((x) => !x.other).map((x) => x.id);
  if (picked.some((x) => x.other)) {
    const extra = await vscode.window.showInputBox({ title: `Проекти задачі ${taskId}`, prompt: 'Назви через кому' });
    if (extra === undefined) return;
    for (const n of splitList(extra)) if (!ids.includes(n)) ids.push(n);
  }
  const text = fs.readFileSync(task.taskFile, 'utf8');
  const raw = core.readField(text, ws.projectField) || '';
  const value = core.setTaskProjects(raw, ids, shared) || '—';
  const next = core.writeField(text, ws.projectField, value);
  if (next !== text) {
    fs.writeFileSync(task.taskFile, next, 'utf8');
    log(`${taskId}: ${ws.projectField} — ${value}`);
  }
  postState();
}

async function pickProjectBoard(context) {
  const ws = requireWorkspace();
  if (!ws) return;
  const m = model(ws);
  const items = m.boards
    .filter((b) => b.kind === 'project' || (b.kind === 'all' && b.tasks.length) || (b.kind === 'none' && b.tasks.length))
    .map((b) => ({
      label: `${b.kind === 'project' ? '$(project)' : b.kind === 'all' ? '$(list-flat)' : '$(question)'} ${ctxTitle(b)}`,
      description: `${b.tasks.length} задач · ${relPath(ws, b.root)}`,
      id: b.id,
    }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Канбан-дошка проекту' });
  if (pick) openBoard(context, pick.id);
}

// ---------- колонки ----------

async function addColumn(where, after) {
  const ws = requireWorkspace();
  if (!ws) return;
  const ctx = boardCtx(ws, where);
  if (!ctx) return;
  const title = await vscode.window.showInputBox({
    title: `Нова колонка — ${ctxTitle(ctx)} (1/3)`,
    prompt: 'Назва колонки на дошці',
    placeHolder: 'напр. Архів',
    validateInput: (v) => (v.trim() ? null : 'Вкажіть назву'),
  });
  if (!title) return;
  const suggested = core.suggestStageDir(ctx.stages, title);
  const dir = await vscode.window.showInputBox({
    title: 'Нова колонка (2/3)',
    prompt: `Каталог етапу в ${relPath(ws, ctx.root)}/ (латиницею; порядок колонок задається на дошці, не іменем)`,
    value: suggested,
    validateInput: (v) => core.validateStageDir(ctx.root, ctx.stages, v),
  });
  if (!dir) return;
  const status = await vscode.window.showInputBox({
    title: 'Нова колонка (3/3)',
    prompt: 'Статус, що пишеться в task.md при перенесенні сюди (порожньо — не змінювати)',
    value: title.trim().toLowerCase(),
  });
  if (status === undefined) return;
  let pos = typeof after === 'number' ? after : ctx.stages.length - 1;
  if (typeof after !== 'number' && ctx.stages.length) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'На початок', index: -1 },
        ...ctx.stages.map((s, i) => ({ label: `Після «${s.title || s.dir}»`, description: s.dir, index: i })),
      ],
      { title: 'Де розмістити колонку', placeHolder: 'За замовчуванням — у кінці' },
    );
    if (!pick) return;
    pos = pick.index;
  }
  await saveStages(ctx, core.addStage(ctx.root, ctx.stages, { dir, title, status }, pos));
  core.ensureStageDir(ctx.root, dir.trim());
  postState();
}

async function editColumn(where, dir) {
  const ws = requireWorkspace();
  const ctx = ws && boardCtx(ws, where);
  const st = ctx && ctx.stages.find((s) => s.dir === dir);
  if (!st) return;
  const title = await vscode.window.showInputBox({
    title: `Колонка ${dir}`,
    prompt: 'Назва колонки на дошці',
    value: st.title || st.dir,
    validateInput: (v) => (v.trim() ? null : 'Вкажіть назву'),
  });
  if (!title) return;
  const status = await vscode.window.showInputBox({
    title: `Колонка ${dir}`,
    prompt: 'Статус для task.md (порожньо — не змінювати статус при перенесенні)',
    value: st.status || '',
  });
  if (status === undefined) return;
  await saveStages(ctx, core.updateStage(ctx.stages, dir, { title, status }));
}

async function deleteColumn(where, dir) {
  const ws = requireWorkspace();
  const ctx = ws && boardCtx(ws, where);
  const st = ctx && ctx.stages.find((s) => s.dir === dir);
  if (!st) return;
  const count = core.scanTasks(ctx.root, ctx.stages).filter((t) => t.stage === dir).length;
  if (count) {
    vscode.window.showWarningMessage(`У колонці «${st.title || dir}» задач: ${count}. Спершу перенесіть їх в інші колонки.`);
    return;
  }
  const used = core.transitionsUsing(ctx.transitions, dir);
  const note = used.length ? ` Її згадують переходи (${used.length}) — вони перестануть спрацьовувати.` : '';
  const ok = await vscode.window.showWarningMessage(
    `Видалити колонку «${st.title || dir}»? Порожній каталог ${dir} буде видалено.${note}`,
    { modal: true },
    'Видалити',
  );
  if (ok !== 'Видалити') return;
  const res = core.removeStage(ctx.root, ctx.stages, dir);
  if (!res.folderRemoved) log(`${dir}: каталог не порожній (службові файли) — залишено`);
  await saveStages(ctx, res.stages);
}

async function resetColumns() {
  const ws = requireWorkspace();
  if (!ws) return;
  const ok = await vscode.window.showWarningMessage(
    'Повернути стандартний список загальних колонок (taskKanban.stages)? Колонки проектів з власним каталогом не змінюються; ' +
      'каталоги не змінюються; задачі з етапів, яких не буде в списку, з’являться в колонці «Без етапу».',
    { modal: true },
    'Повернути',
  );
  if (ok === 'Повернути') await saveStages(null, undefined);
}

// ---------- підзадачі ----------

/**
 * Розбиття задачі: нова підзадача або підзадачі з пунктів плану (розділ «Підзадачі» без посилань).
 * Підзадача — окрема задача в першій колонці того самого каталогу; звʼязок — [[номер]] в обох task.md.
 */
async function addSubtask(where, taskId) {
  const ws = requireWorkspace();
  if (!ws || busy) return;
  const m = model(ws);
  const ctx = m.get(where);
  const parent = ctx && ctx.tasks.find((t) => t.id === taskId);
  if (!parent) return;
  if (!parent.taskFile) throw new Error(`У задачі ${taskId} немає task.md`);
  if (!ctx.stages.length) throw new Error('На дошці немає колонок');
  const stage = ctx.stages[0];
  const taken = new Set((ctx.rootTasks || ctx.tasks).map((t) => t.id));
  const plan = parent.subtasks.filter((x) => !x.id);

  let mode = 'one';
  if (plan.length) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(list-ordered) Розбити за планом — ${plan.length}`, detail: plan.map((x) => x.text).join(' · '), mode: 'plan' },
        { label: '$(add) Нова підзадача…', mode: 'one' },
      ],
      { title: `Підзадачі ${taskId}`, placeHolder: `Пункти розділу «${ws.subtasksHeading}» без посилань — план розбиття` },
    );
    if (!pick) return;
    mode = pick.mode;
  }
  const opts = { ...scanOpts(ws), status: stage.status };
  const created = [];

  if (mode === 'plan') {
    const picked = await vscode.window.showQuickPick(
      plan.map((x) => ({ label: x.text, picked: true, item: x })),
      {
        canPickMany: true,
        title: `Розбити ${taskId}: підзадачі з пунктів плану`,
        placeHolder: `Номери — ${taskId}.1, ${taskId}.2…; колонка «${stage.title || stage.dir}»`,
      },
    );
    if (!picked || !picked.length) return;
    for (const p of picked) {
      const id = core.nextSubtaskId(taskId, taken);
      taken.add(id);
      created.push(core.createSubtask(ctx.root, ctx.template, stage.dir, parent, id, p.item.text, { ...opts, planLine: p.item.line }));
    }
  } else {
    const title = await vscode.window.showInputBox({
      title: `Нова підзадача ${taskId} (1/2)`,
      prompt: 'Що зробити — опис підзадачі і текст пункту в розділі «Підзадачі» батьківської',
    });
    if (title === undefined) return;
    const id = await vscode.window.showInputBox({
      title: `Нова підзадача ${taskId} (2/2)`,
      prompt: `Номер підзадачі (каталог у ${relPath(ws, ctx.root)}/${stage.dir}/); можна номер з трекера`,
      value: core.nextSubtaskId(taskId, taken),
      validateInput: (v) => {
        const s = v.trim();
        if (!/^[\w.-]+$/.test(s)) return 'Лише цифри, літери, _ . -';
        return [...taken].some((x) => x.toLowerCase() === s.toLowerCase()) ? `Задача ${s} уже є` : null;
      },
    });
    if (!id) return;
    created.push(core.createSubtask(ctx.root, ctx.template, stage.dir, parent, id.trim(), title.trim(), opts));
  }
  log(`${taskId}: підзадачі ${created.map((t) => t.id).join(', ')}`);
  postState();
  if (created.length === 1 && created[0].taskFile) {
    await vscode.window.showTextDocument(vscode.Uri.file(created[0].taskFile), { preview: false });
  } else if (created.length) {
    vscode.window.showInformationMessage(`${taskId}: створено підзадачі ${created.map((t) => t.id).join(', ')}`);
  }
}

/** [[номер]] у markdown-файлах каталогу задач — посилання на task.md задачі з цим номером (у тому самому каталозі). */
function wikiLinkProvider() {
  let cache = null;
  const boardsNow = () => {
    if (cache && Date.now() - cache.at < 2000) return cache.boards;
    const ws = workspace();
    cache = { at: Date.now(), boards: ws ? model(ws).boards : [] };
    return cache.boards;
  };
  return {
    provideDocumentLinks(doc) {
      const file = path.resolve(doc.uri.fsPath).toLowerCase();
      const board = boardsNow().find((b) => file.startsWith(path.resolve(b.root).toLowerCase() + path.sep));
      if (!board) return [];
      const tasks = board.rootTasks || board.tasks;
      const text = doc.getText();
      const out = [];
      for (const m of text.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
        const id = core.wikiTarget(m[1]).toLowerCase();
        const t = tasks.find((x) => x.id.toLowerCase() === id);
        if (!t || !t.taskFile) continue;
        const range = new vscode.Range(doc.positionAt(m.index + 2), doc.positionAt(m.index + m[0].length - 2));
        const link = new vscode.DocumentLink(range, vscode.Uri.file(t.taskFile));
        link.tooltip = `Задача ${t.id}${t.title ? ' — ' + t.title : ''}`;
        out.push(link);
      }
      return out;
    },
  };
}

// ---------- нова задача ----------

/**
 * Поле номера задачі з кнопкою «Наступний номер» (найбільший цифровий номер каталогу + 1, core.nextTaskId).
 * taken — номери наявних задач каталогу. Повертає номер або undefined (скасовано).
 */
function askTaskId({ title, prompt, taken }) {
  const busyIds = new Set(taken.map((x) => String(x).toLowerCase()));
  const validate = (v) => {
    const s = v.trim();
    if (!s) return '';
    if (!/^[\w.-]+$/.test(s)) return 'Лише цифри, літери, _ . -';
    return busyIds.has(s.toLowerCase()) ? `Задача ${s} уже є` : '';
  };
  const nextBtn = { iconPath: new vscode.ThemeIcon('arrow-up'), tooltip: `Наступний номер: ${core.nextTaskId(taken)} (найбільший + 1)` };
  const box = vscode.window.createInputBox();
  box.title = title;
  box.prompt = prompt;
  box.placeholder = core.nextTaskId(taken);
  box.buttons = [nextBtn];
  box.ignoreFocusOut = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      box.dispose();
    };
    box.onDidChangeValue((v) => (box.validationMessage = validate(v) || undefined));
    box.onDidTriggerButton((b) => {
      if (b !== nextBtn) return;
      box.value = core.nextTaskId(taken);
      box.validationMessage = validate(box.value) || undefined;
    });
    box.onDidAccept(() => {
      const s = box.value.trim();
      if (!s || validate(s)) return;
      finish(s);
    });
    box.onDidHide(() => finish(undefined));
    box.show();
  });
}

/** board — id дошки, на якій створюється задача; '*'/undefined — спитати проект, якщо проекти є. */
async function newTask(board) {
  const ws = requireWorkspace();
  if (!ws) return;
  const m = model(ws);
  let ctx = board !== undefined && board !== null ? m.get(board) : null;
  const projects = m.boards.filter((b) => b.kind === 'project');
  if ((!ctx || ctx.kind === 'all') && projects.length) {
    const items = projects.map((b) => ({ label: b.project.title, description: relPath(ws, b.root), ctx: b }));
    const all = m.get(ALL);
    if (all && all.tasks.length) items.push({ label: 'Без проекту', description: `${relPath(ws, all.root)} — рядок «Проекти» як у шаблоні`, ctx: all });
    const pick = await vscode.window.showQuickPick(items, { title: 'Нова задача — проект' });
    if (!pick) return;
    ctx = pick.ctx;
  }
  if (!ctx) ctx = m.get(ALL);
  if (!ctx || !ctx.stages.length) return;
  const taken = (ctx.rootTasks || ctx.tasks).map((t) => t.id);
  const id = await askTaskId({
    title: ctx.kind === 'project' ? `Нова задача — ${ctx.project.title}` : 'Нова задача',
    prompt: `Номер задачі з трекера (каталог у ${relPath(ws, ctx.root)}/${ctx.stages[0].dir}/); кнопка ↑ у заголовку — наступний номер (найбільший + 1)`,
    taken,
  });
  if (!id) return;
  const stage = ctx.stages[0];
  const t = core.createTask(ctx.root, ctx.template, stage.dir, id.trim());
  if (t.taskFile) {
    let text = fs.readFileSync(t.taskFile, 'utf8');
    const orig = text;
    if (stage.status) text = core.writeStatus(text, stage.status) ?? text;
    if (ctx.kind === 'project') text = core.writeField(text, ws.projectField, ctx.project.title);
    else if (ctx.kind === 'none') text = core.writeField(text, ws.projectField, '—');
    if (text !== orig) fs.writeFileSync(t.taskFile, text, 'utf8');
  }
  postState();
  if (t.taskFile) await vscode.window.showTextDocument(vscode.Uri.file(t.taskFile), { preview: false });
}

// ---------- активація ----------

let watchers = [];

/** Стежить за каталогами задач усіх проектів (і поза робочою областю). */
function watchRoots(refreshSoon) {
  for (const w of watchers) w.dispose();
  watchers = [];
  const ws = workspace();
  if (!ws) return;
  const roots = [ws.tasksRoot];
  for (const b of model(ws).boards) if (!roots.some((r) => core.samePath(r, b.root))) roots.push(b.root);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**'));
    w.onDidCreate(refreshSoon);
    w.onDidDelete(refreshSoon);
    w.onDidChange(refreshSoon);
    watchers.push(w);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('taskKanban.open', () => openDashboard(context)),
    vscode.commands.registerCommand('taskKanban.openBoard', (id) =>
      typeof id === 'string' ? openBoard(context, id) : pickProjectBoard(context),
    ),
    vscode.commands.registerCommand('taskKanban.addProject', () => addProject()),
    vscode.commands.registerCommand('taskKanban.newTask', () => newTask(lastBoard)),
    vscode.commands.registerCommand('taskKanban.refresh', () => postState()),
    vscode.commands.registerCommand('taskKanban.addColumn', () => addColumn(lastBoard)),
    vscode.commands.registerCommand('taskKanban.resetColumns', () => resetColumns()),
    vscode.commands.registerCommand('taskKanban.openTaskSession', (id) => pickTaskSession(id)),
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ language: 'markdown', scheme: 'file' }, wikiLinkProvider()),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(dashboard) Проекти';
  status.tooltip = 'Дашборд проектів: звідси — канбан-дошка кожного проекту';
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
    watchRoots(refreshSoon);
  };
  setup();
  context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.dispose()) });
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
