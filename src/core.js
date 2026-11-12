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

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Значення рядка «- **<label>:** …» з task.md; порожнє, «—» чи «-» — null. */
function readField(text, label) {
  if (!label) return null;
  const re = new RegExp(`^[ \\t]*[-*][ \\t]*\\*\\*${escapeRegExp(label)}:\\*\\*([^\\r\\n]*)`, 'mi');
  const m = re.exec(text);
  if (!m) return null;
  const v = stripComments(m[1]);
  return v && !/^[—–-]+$/.test(v) ? v : null;
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

const DEFAULT_EFFORT_FIELD = 'Трудомісткість';

function readTask(dir, id, stage, opts = {}) {
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
    effort: readField(text, opts.effortField === undefined ? DEFAULT_EFFORT_FIELD : opts.effortField),
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
function scanTasks(tasksRoot, stages, opts = {}) {
  const stageDirs = new Set(stages.map((s) => s.dir));
  const tasks = [];
  for (const s of stages) {
    for (const id of listDirs(path.join(tasksRoot, s.dir))) {
      tasks.push(readTask(path.join(tasksRoot, s.dir, id), id, s.dir, opts));
    }
  }
  for (const id of listDirs(tasksRoot)) {
    if (stageDirs.has(id)) continue;
    const dir = path.join(tasksRoot, id);
    if (findTaskFile(dir)) {
      tasks.push(readTask(dir, id, '', opts));
      continue;
    }
    // каталог етапу, якого немає в списку колонок: його задачі — «без етапу»
    for (const sub of listDirs(dir)) tasks.push(readTask(path.join(dir, sub), sub, '', opts));
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

// ---------- колонки (етапи) ----------
// Список етапів незмінний: кожна функція повертає новий масив для запису в налаштування.

function validateStageDir(tasksRoot, stages, dir) {
  const d = String(dir || '').trim();
  if (!d) return 'Вкажіть назву каталогу';
  if (!/^[\w.-]+$/.test(d)) return 'Лише латиниця, цифри, _ . -';
  if (d.startsWith('_') || d.startsWith('.')) return 'Каталог не може починатися з _ або .';
  if (stages.some((s) => s.dir.toLowerCase() === d.toLowerCase())) return `Колонка ${d} уже є`;
  const full = path.join(tasksRoot, d);
  if (fs.existsSync(full) && findTaskFile(full)) return `${d} — це каталог задачі, а не етапу`;
  return null;
}

/**
 * Новий список з колонкою після індексу after (-1 — на початок; за замовчуванням — у кінець).
 * Каталог не створює: це робить ensureStageDir після того, як список збережено, — інакше збій запису
 * налаштувань лишає порожній каталог без колонки.
 */
function addStage(tasksRoot, stages, stage, after = stages.length - 1) {
  const err = validateStageDir(tasksRoot, stages, stage.dir);
  if (err) throw new Error(err);
  const s = { dir: stage.dir.trim(), title: (stage.title || stage.dir).trim() };
  if (stage.status && stage.status.trim()) s.status = stage.status.trim();
  const at = Math.max(0, Math.min(stages.length, after + 1));
  return [...stages.slice(0, at), s, ...stages.slice(at)];
}

function ensureStageDir(tasksRoot, dir) {
  fs.mkdirSync(path.join(tasksRoot, dir), { recursive: true });
}

function updateStage(stages, dir, patch) {
  return stages.map((s) => {
    if (s.dir !== dir) return s;
    const n = { ...s };
    for (const k of ['title', 'status']) {
      if (!(k in patch)) continue;
      const v = String(patch[k] || '').trim();
      if (v) n[k] = v;
      else delete n[k];
    }
    if ('collapsed' in patch) {
      if (patch.collapsed) n.collapsed = true;
      else delete n.collapsed;
    }
    return n;
  });
}

function moveStage(stages, dir, delta) {
  const i = stages.findIndex((s) => s.dir === dir);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= stages.length) return stages;
  const out = [...stages];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * Прибирає колонку. Лише порожню: задачі спершу перенести в інші колонки.
 * Каталог видаляється, якщо в ньому лишилися тільки службові файли (.gitkeep тощо).
 */
function removeStage(tasksRoot, stages, dir) {
  if (!stages.some((s) => s.dir === dir)) throw new Error(`Колонки ${dir} немає`);
  if (stages.length <= 1) throw new Error('Остання колонка — видаляти нема куди переносити задачі');
  const count = scanTasks(tasksRoot, stages).filter((t) => t.stage === dir).length;
  if (count) throw new Error(`У колонці ${dir} задач: ${count} — спершу перенесіть їх в інші колонки`);
  const full = path.join(tasksRoot, dir);
  let folderRemoved = false;
  if (fs.existsSync(full)) {
    const rest = fs.readdirSync(full).filter((n) => !/^\.(gitkeep|keep|DS_Store)$/i.test(n) && n !== 'desktop.ini');
    if (!rest.length) {
      fs.rmSync(full, { recursive: true, force: true });
      folderRemoved = true;
    }
  }
  return { stages: stages.filter((s) => s.dir !== dir), folderRemoved };
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '', "'": '', 'ʼ': '', '’': '',
};

/** Пропонує каталог для нової колонки: <наступний номер>_<транслітерація назви>, без збігів з наявними. */
function suggestStageDir(stages, title) {
  const slug =
    String(title || '')
      .toLowerCase()
      .split('')
      .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
      .join('')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'stage';
  const nums = stages.map((s) => parseInt(s.dir, 10)).filter((n) => !isNaN(n));
  let n = nums.length ? Math.max(...nums) + 1 : stages.length + 1;
  const taken = new Set(stages.map((s) => s.dir.toLowerCase()));
  let dir = `${n}_${slug}`;
  while (taken.has(dir.toLowerCase())) dir = `${++n}_${slug}`;
  return dir;
}

/** Переходи, що згадують етап (from/to) — щоб попередити перед видаленням. */
function transitionsUsing(transitions, dir) {
  return (transitions || []).filter((t) => t.from === dir || t.to === dir);
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
  readField,
  writeStatus,
  readTitle,
  readTask,
  scanTasks,
  findTask,
  moveTask,
  renameWithRetry,
  createTask,
  validateStageDir,
  suggestStageDir,
  addStage,
  ensureStageDir,
  updateStage,
  moveStage,
  removeStage,
  transitionsUsing,
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
