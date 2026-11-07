'use strict';
// Логіка дошки без залежності від vscode: сканування задач, статус у task.md,
// перенесення каталогу, збір файлів задачі в git і коміт. Тестується окремо (test/).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// «- **Статус:** в роботі <!-- ... -->»
const STATUS_BULLET = /^([ \t]*[-*][ \t]*\*\*Статус:\*\*)([^\r\n]*)/m;
// «## Статус» і перший непорожній рядок під ним
const STATUS_HEADING = /^(#{1,6}[ \t]*Статус[ \t]*\r?\n(?:[ \t]*\r?\n)*)([^\r\n#][^\r\n]*)/m;
const DESCRIPTION_HEADING = /^#{1,6}\s*(description|опис)\b/i;

// ---------- task.md ----------

function findTaskFile(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const exact = names.find((n) => n.toLowerCase() === 'task.md');
  if (exact) return path.join(dir, exact);
  const alt = names.find((n) => /_task\.md$/i.test(n));
  return alt ? path.join(dir, alt) : null;
}

function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function readStatus(text) {
  const b = STATUS_BULLET.exec(text);
  if (b) return stripComments(b[2]);
  const h = STATUS_HEADING.exec(text);
  if (h) return stripComments(h[2]);
  return null;
}

/** Повертає новий текст або null, якщо рядка статусу немає. */
function writeStatus(text, status) {
  if (STATUS_BULLET.test(text)) {
    return text.replace(STATUS_BULLET, (_m, head) => `${head} ${status}`);
  }
  if (STATUS_HEADING.test(text)) {
    return text.replace(STATUS_HEADING, (_m, head) => `${head}${status}`);
  }
  return null;
}

function readTitle(text) {
  const lines = text.split(/\r?\n/);
  const isMeta = (t) => /^[-*]\s*\*\*[^*]+:\*\*/.test(t);
  const start = lines.findIndex((l) => DESCRIPTION_HEADING.test(l.trim()));
  const out = [];
  for (let k = start >= 0 ? start + 1 : 0; k < lines.length && out.length < TITLE_LINES; k++) {
    const t = lines[k].trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      if (start >= 0 || out.length) break;
      continue;
    }
    if (isMeta(t)) continue;
    out.push(t.replace(/^[-*]\s+/, ''));
  }
  return out.join(' · ');
}

const TITLE_LINES = 2;

// ---------- сканування ----------

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readTask(dir, id, stage) {
  const taskFile = findTaskFile(dir);
  let text = '';
  if (taskFile) {
    try {
      text = fs.readFileSync(taskFile, 'utf8');
    } catch {
      text = '';
    }
  }
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  let zipVersion = 0;
  for (const f of files) {
    const m = /\.v(\d+)\.zip$/i.exec(f);
    if (m) zipVersion = Math.max(zipVersion, Number(m[1]));
  }
  return {
    id,
    stage,
    dir,
    taskFile,
    notesFile: files.find((f) => f.toLowerCase() === 'notes.md') ? path.join(dir, 'notes.md') : null,
    title: readTitle(text),
    status: readStatus(text),
    hasSql: files.some((f) => f.toLowerCase() === 'path.sql'),
    zipVersion,
  };
}

function compareIds(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/**
 * Задачі з усіх етапів. Каталоги просто в tasksDir (не етап, не `_*`) потрапляють
 * в етап '' — «без етапу».
 */
function scanTasks(tasksRoot, stages) {
  const stageDirs = new Set(stages.map((s) => s.dir));
  const tasks = [];
  for (const s of stages) {
    for (const id of listDirs(path.join(tasksRoot, s.dir))) {
      tasks.push(readTask(path.join(tasksRoot, s.dir, id), id, s.dir));
    }
  }
  for (const id of listDirs(tasksRoot)) {
    if (!stageDirs.has(id)) tasks.push(readTask(path.join(tasksRoot, id), id, ''));
  }
  tasks.sort((a, b) => compareIds(a.id, b.id));
  return tasks;
}

function findTask(tasksRoot, stages, id) {
  return scanTasks(tasksRoot, stages).find((t) => t.id === id) || null;
}

// ---------- перенесення ----------

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * rename з повторами: у Windows каталог не перейменовується, поки хтось тримає в ньому файл
 * (антивірус, індексатор — зазвичай на мить; термінал/Провідник у цьому каталозі — постійно).
 */
async function renameWithRetry(src, dst, { attempts = 12, delayMs = 250 } = {}) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      if (!LOCK_CODES.has(e.code) || i >= attempts) {
        if (LOCK_CODES.has(e.code)) {
          const err = new Error(
            `каталог ${src} зайнятий іншим процесом (${e.code}). Закрийте термінал, Провідник або програму, ` +
              `відкриті в ньому чи на його файлах, і повторіть.`,
          );
          err.code = 'LOCKED';
          err.cause = e;
          throw err;
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function moveTask(tasksRoot, stages, id, toDir, retry) {
  const task = findTask(tasksRoot, stages, id);
  if (!task) throw new Error(`Задачу ${id} не знайдено в ${tasksRoot}`);
  const stage = stages.find((s) => s.dir === toDir);
  if (!stage) throw new Error(`Невідомий етап ${toDir}`);
  if (task.stage === toDir) return { task, moved: false, statusUpdated: false };

  const dstParent = path.join(tasksRoot, toDir);
  const dst = path.join(dstParent, id);
  if (fs.existsSync(dst)) throw new Error(`Каталог ${dst} уже існує`);
  fs.mkdirSync(dstParent, { recursive: true });
  await renameWithRetry(task.dir, dst, retry);

  let statusUpdated = false;
  const moved = readTask(dst, id, toDir);
  if (stage.status && moved.taskFile) {
    const text = fs.readFileSync(moved.taskFile, 'utf8');
    const next = writeStatus(text, stage.status);
    if (next !== null && next !== text) {
      fs.writeFileSync(moved.taskFile, next, 'utf8');
      statusUpdated = true;
    }
  }
  return { task: readTask(dst, id, toDir), from: task.stage, moved: true, statusUpdated };
}

function createTask(tasksRoot, templateDir, stageDir, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`Недопустимий номер задачі: ${id}`);
  const dst = path.join(tasksRoot, stageDir, id);
  if (fs.existsSync(dst)) throw new Error(`Каталог ${dst} уже існує`);
  const src = path.join(tasksRoot, templateDir);
  fs.mkdirSync(dst, { recursive: true });
  if (fs.existsSync(src)) {
    fs.cpSync(src, dst, { recursive: true });
    for (const f of walk(dst)) {
      if (!/\.(md|txt|sql)$/i.test(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      const next = text.split('<номер>').join(id);
      if (next !== text) fs.writeFileSync(f, next, 'utf8');
    }
  }
  return readTask(dst, id, stageDir);
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---------- переходи ----------

function matchTransitions(transitions, from, to) {
  const actions = [];
  for (const t of transitions || []) {
    const f = t.from || '*';
    if ((f === '*' || f === from) && (t.to === '*' || t.to === to)) actions.push(...(t.actions || []));
  }
  return actions;
}

function fill(template, vars) {
  return String(template).replace(/\$\{(\w+)\}|\{(\w+)\}/g, (m, a, b) => {
    const k = a || b;
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
}

function globToRegExp(mask) {
  const re = mask
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 'i');
}

/** Маски check, яким не відповідає жоден файл у каталозі задачі. */
function missingFiles(taskDir, masks) {
  let names;
  try {
    names = fs.readdirSync(taskDir);
  } catch {
    names = [];
  }
  return (masks || []).filter((m) => !names.some((n) => globToRegExp(m).test(n)));
}

// ---------- git ----------

function git(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...(opts.env || {}) },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

async function isGitRepo(dir) {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

async function gitTopLevel(dir) {
  return path.normalize((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
}

function parsePorcelainZ(out) {
  const parts = out.split('\0');
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const code = s.slice(0, 2);
    res.push({ code, path: s.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') {
      const orig = parts[++i];
      if (orig && code[0] === 'R') res.push({ code: 'D ', path: orig });
    }
  }
  return res;
}

async function changedFiles(repo, pathspecs) {
  if (!pathspecs.length) return [];
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '-uall', '--', ...pathspecs]);
  const seen = new Set();
  return parsePorcelainZ(out).filter((f) => !seen.has(f.path) && seen.add(f.path));
}

async function repoFiles(repo) {
  const out = await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out.split('\0').filter(Boolean);
}

/**
 * Файли для коміту за дією commit. Повертає { repo, name, files: [{path, code}], warning }.
 * ctx: { workspaceFolder, task, vars }
 */
async function collectCommit(action, ctx) {
  const repoPath = path.resolve(ctx.workspaceFolder, fill(action.repo || '${workspaceFolder}', ctx.vars));
  const name = action.name || path.basename(repoPath);
  if (!fs.existsSync(repoPath) || !(await isGitRepo(repoPath))) {
    return { repo: repoPath, name, files: [], warning: `${name}: не git-репозиторій, пропущено` };
  }
  const repo = await gitTopLevel(repoPath);
  const pathspecs = (action.paths || []).map((p) => `:(glob)${fill(p, ctx.vars)}`);

  if (action.sourceDir) {
    const src = path.join(ctx.task.dir, fill(action.sourceDir, ctx.vars));
    const wanted = new Set(walk(src).map((f) => path.basename(f).toLowerCase()));
    if (wanted.size) {
      const matched = (await repoFiles(repo)).filter((f) => wanted.has(path.posix.basename(f).toLowerCase()));
      for (const f of matched) pathspecs.push(`:(literal)${f}`);
    }
  }
  const files = await changedFiles(repo, pathspecs);
  return { repo, name, files };
}

async function commitFiles(repo, files, message) {
  if (!files.length) return null;
  const listFile = path.join(os.tmpdir(), `task-kanban-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(listFile, files.join('\0'), 'utf8');
  const env = { GIT_LITERAL_PATHSPECS: '1' };
  try {
    await git(repo, ['add', '-A', `--pathspec-from-file=${listFile}`, '--pathspec-file-nul'], { env });
    await git(repo, ['commit', '-m', message, '--only', `--pathspec-from-file=${listFile}`, '--pathspec-file-nul'], {
      env,
    });
    return (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

module.exports = {
  findTaskFile,
  readStatus,
  writeStatus,
  readTitle,
  readTask,
  scanTasks,
  findTask,
  moveTask,
  renameWithRetry,
  createTask,
  matchTransitions,
  fill,
  missingFiles,
  git,
  isGitRepo,
  parsePorcelainZ,
  changedFiles,
  collectCommit,
  commitFiles,
};
