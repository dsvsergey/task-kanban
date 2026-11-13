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

const META_LINE = /^[ \t]*[-*][ \t]*\*\*[^*\r\n]+:\*\*/;

/**
 * Записує «- **<label>:** value». Наявний рядок замінюється (разом з коментарем), інакше новий рядок
 * додається після останнього рядка-поля в шапці (до першого «##»), а без полів — після заголовка «#».
 */
function writeField(text, label, value) {
  const re = new RegExp(`^([ \\t]*[-*][ \\t]*\\*\\*${escapeRegExp(label)}:\\*\\*)([^\\r\\n]*)`, 'mi');
  if (re.test(text)) return text.replace(re, (_m, head) => `${head} ${value}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `- **${label}:** ${value}`;
  const lines = text.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,6}\s/.test(lines[i])) break;
    if (META_LINE.test(lines[i])) at = i;
  }
  if (at >= 0) {
    lines.splice(at + 1, 0, line);
    return lines.join(eol);
  }
  const h = lines.findIndex((l) => /^#\s/.test(l));
  if (h < 0) return `${line}${eol}${text}`;
  lines.splice(h + 1, 0, '', line);
  return lines.join(eol);
}

// ---------- проекти ----------
// Задача належить проектам з рядка «- **Проекти:** Ultra (лише БД), ultra-replicator».
// Примітки в дужках і `код` не входять у назву; кома в дужках не ділить список.

/** Частини поля «Проекти» верхнього рівня: [{name, text}], text — разом з приміткою в дужках. */
function projectSegments(value) {
  const out = [];
  if (!value) return out;
  let depth = 0;
  let cur = '';
  const push = () => {
    const text = cur.trim();
    const name = text.replace(/\([^)]*\)?/g, ' ').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    if (name && !/^[—–-]+$/.test(name)) out.push({ name, text });
    cur = '';
  };
  for (const ch of String(value)) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    if ((ch === ',' || ch === ';') && depth === 0) push();
    else cur += ch;
  }
  push();
  return out;
}

function parseProjectList(value) {
  return projectSegments(value).map((s) => s.name);
}

// кольори тем VS Code (--vscode-charts-<колір>), у фіксованому порядку
const PROJECT_COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'yellow'];

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Проекти з налаштувань в єдиному вигляді; записи без id і title та повтори id відкидаються. */
function normalizeProjects(list) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || slugify(p.title) || '').trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const n = { id, title: String(p.title || id).trim() };
    if (p.description && String(p.description).trim()) n.description = String(p.description).trim();
    const aliases = (Array.isArray(p.aliases) ? p.aliases : []).map((a) => String(a).trim()).filter(Boolean);
    if (aliases.length) n.aliases = aliases;
    if (p.color) n.color = String(p.color).trim();
    if (p.tasksDir && String(p.tasksDir).trim()) n.tasksDir = String(p.tasksDir).trim();
    if (p.templateDir && String(p.templateDir).trim()) n.templateDir = String(p.templateDir).trim();
    if (Array.isArray(p.stages) && p.stages.length) n.stages = p.stages.filter((s) => s && s.dir);
    if (Array.isArray(p.transitions)) n.transitions = p.transitions;
    out.push(n);
  }
  return out;
}

function projectKeys(p) {
  return [p.id, p.title, ...(p.aliases || [])].map((k) => String(k).trim().toLowerCase()).filter(Boolean);
}

/**
 * Усі проекти: з налаштувань (configured: true) і згадані в задачах, але не описані
 * (configured: false, id = назва з task.md). Повертає { projects, projectsOf(task) → [id] }.
 */
function resolveProjects(configured, tasks) {
  const projects = normalizeProjects(configured).map((p, i) => ({
    ...p,
    color: p.color || PROJECT_COLORS[i % PROJECT_COLORS.length],
    configured: true,
  }));
  const byKey = new Map();
  for (const p of projects) for (const k of projectKeys(p)) if (!byKey.has(k)) byKey.set(k, p.id);
  const auto = [];
  const ofTask = new Map();
  for (const t of tasks) {
    const ids = [];
    for (const name of t.projects || []) {
      const k = name.toLowerCase();
      let id = byKey.get(k);
      if (!id) {
        id = name;
        byKey.set(k, id);
        auto.push({ id, title: name, configured: false });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    ofTask.set(t, ids);
  }
  auto.sort((a, b) => a.title.localeCompare(b.title));
  auto.forEach((p, i) => (p.color = PROJECT_COLORS[(projects.length + i) % PROJECT_COLORS.length]));
  return { projects: [...projects, ...auto], projectsOf: (t) => ofTask.get(t) || [] };
}

/** Задачі проекту: '*' — усі, '' — без проекту, інакше id. */
function filterByProject(tasks, projectsOf, id) {
  if (id === '*') return tasks.slice();
  if (id === '') return tasks.filter((t) => !projectsOf(t).length);
  return tasks.filter((t) => projectsOf(t).includes(id));
}

/** Етапи «завершено»: позначені done: true; якщо таких немає — згорнуті за замовчуванням і останній. */
function doneStages(stages) {
  const marked = stages.filter((s) => s.done).map((s) => s.dir);
  if (marked.length) return new Set(marked);
  const set = new Set(stages.filter((s) => s.collapsed).map((s) => s.dir));
  if (stages.length) set.add(stages[stages.length - 1].dir);
  return set;
}

/** «3:20» → 200 хв, «2» → 120; не час — null. */
function parseEffort(v) {
  const m = /^\s*(\d+)(?::(\d{1,2}))?\s*$/.exec(String(v || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
}

function formatMinutes(min) {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

/** Зведення по задачах проекту для дашборду. */
function projectStats(tasks, stages) {
  const done = doneStages(stages);
  const byStage = {};
  for (const s of stages) byStage[s.dir] = 0;
  const st = { total: tasks.length, active: 0, done: 0, byStage, noStage: 0, effortMinutes: 0, withEffort: 0, updated: 0 };
  for (const t of tasks) {
    if (Object.prototype.hasOwnProperty.call(byStage, t.stage)) byStage[t.stage]++;
    else st.noStage++;
    if (done.has(t.stage)) st.done++;
    else st.active++;
    const e = parseEffort(t.effort);
    if (e !== null) {
      st.effortMinutes += e;
      st.withEffort++;
    }
    if (t.updated > st.updated) st.updated = t.updated;
  }
  return st;
}

// ---------- дошки проектів ----------
// Проект з tasksDir має власний корінь задач (<корінь>/<етап>/<номер>/), свої колонки (stages, інакше —
// загальні), шаблон (<корінь>/_template, інакше — загальний) і переходи. Усі задачі цього кореня — його.
// Проекти без tasksDir ділять загальний корінь (taskKanban.tasksDir) і загальні колонки, а задачі між ними
// розподіляє рядок «Проекти» у task.md.

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Контексти дошок. cfg: { folder, tasksRoot, stages, transitions, templateDir, projects, scan }
 * (scan — опції scanTasks). Повертає { boards: [ctx], get(id), sharedOwned }, де ctx:
 * { id, kind: 'project'|'all'|'none', project, root, stages, ownRoot, ownStages, template, transitions, tasks, rootTasks, projectsOf }
 * (rootTasks — усі задачі кореня: для звʼязків підзадач між проектами спільного каталогу).
 * 'all' (id '*') і 'none' (id '') — лише коли загальний корінь не належить жодному проекту.
 */
function buildBoards(cfgIn) {
  const cfg = { ...cfgIn, stages: cfgIn.stages || [] };
  const projects = normalizeProjects(cfg.projects);
  const tplName = cfg.templateDir || '_template';
  const sharedTemplate = path.resolve(cfg.tasksRoot, tplName);
  const owned = [];
  const seenRoots = [];
  for (const p of projects) {
    if (!p.tasksDir) continue;
    const root = path.resolve(cfg.folder, p.tasksDir);
    if (seenRoots.some((r) => samePath(r, root))) continue; // другий проект з тим самим коренем — як без tasksDir
    seenRoots.push(root);
    owned.push({ p, root });
  }
  const ownedIds = new Set(owned.map((o) => o.p.id));
  const sharedOwner = owned.find((o) => samePath(o.root, cfg.tasksRoot));
  const scan = (root, stages) =>
    scanTasks(root, stages, { ...(cfg.scan || {}), exclude: seenRoots.filter((r) => !samePath(r, root)) });

  const shared = sharedOwner ? [] : scan(cfg.tasksRoot, cfg.stages);
  // кольори — за порядком у налаштуваннях; поле «Проекти» зіставляється лише з проектами спільного кореня
  const resolved = resolveProjects(projects, shared);
  const colorOf = new Map(resolved.projects.map((p) => [p.id, p.color]));
  const sharedOf = (t) => resolved.projectsOf(t).filter((id) => !ownedIds.has(id));

  const boards = [];
  for (const p of resolved.projects) {
    const o = owned.find((x) => x.p.id === p.id);
    if (o) {
      const stages = p.stages && p.stages.length ? p.stages : cfg.stages;
      const own = path.resolve(o.root, p.templateDir || tplName);
      const tasks = scan(o.root, stages);
      boards.push({
        id: p.id,
        kind: 'project',
        project: { ...p, color: colorOf.get(p.id) },
        root: o.root,
        stages,
        ownRoot: true,
        ownStages: !!(p.stages && p.stages.length),
        template: fs.existsSync(own) ? own : sharedTemplate,
        transitions: p.transitions || (samePath(o.root, cfg.tasksRoot) ? cfg.transitions || [] : []),
        tasks,
        rootTasks: tasks,
        projectsOf: () => [],
      });
    } else if (!sharedOwner) {
      boards.push({
        id: p.id,
        kind: 'project',
        project: p,
        root: cfg.tasksRoot,
        stages: cfg.stages,
        ownRoot: false,
        ownStages: false,
        template: sharedTemplate,
        transitions: p.transitions || cfg.transitions || [],
        tasks: filterByProject(shared, sharedOf, p.id),
        rootTasks: shared,
        projectsOf: sharedOf,
      });
    }
  }
  if (!sharedOwner) {
    const base = { root: cfg.tasksRoot, stages: cfg.stages, ownRoot: false, ownStages: false, template: sharedTemplate, transitions: cfg.transitions || [], projectsOf: sharedOf, rootTasks: shared };
    boards.push({ ...base, id: '*', kind: 'all', project: null, tasks: shared });
    boards.push({ ...base, id: '', kind: 'none', project: null, tasks: filterByProject(shared, sharedOf, '') });
  }
  const byId = new Map(boards.map((b) => [b.id, b]));
  return { boards, get: (id) => byId.get(id) || null, sharedOwned: !!sharedOwner };
}

/** Каталоги етапів і шаблон у корені проекту (шаблон копіюється з загального, якщо свого немає). */
function initProjectRoot(root, stages, sharedTemplate, templateName = '_template') {
  fs.mkdirSync(root, { recursive: true });
  for (const s of stages) fs.mkdirSync(path.join(root, s.dir), { recursive: true });
  const tpl = path.join(root, templateName);
  if (!fs.existsSync(tpl) && sharedTemplate && fs.existsSync(sharedTemplate) && !samePath(tpl, sharedTemplate)) {
    fs.cpSync(sharedTemplate, tpl, { recursive: true });
  }
}

/**
 * Переносить каталог задачі в інший корінь (інший проект) у етап stage; статус — зі stage.
 * Між дисками (EXDEV) — копіювання і видалення.
 */
async function moveTaskToRoot(task, dstRoot, stage, retry) {
  const dst = path.join(dstRoot, stage.dir, task.id);
  if (fs.existsSync(dst)) throw new Error(`Каталог ${dst} уже існує`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    await renameWithRetry(task.dir, dst, retry);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(task.dir, dst, { recursive: true });
    fs.rmSync(task.dir, { recursive: true, force: true });
  }
  let statusUpdated = false;
  const moved = readTask(dst, task.id, stage.dir);
  if (stage.status && moved.taskFile) {
    const text = fs.readFileSync(moved.taskFile, 'utf8');
    const next = writeStatus(text, stage.status);
    if (next !== null && next !== text) {
      fs.writeFileSync(moved.taskFile, next, 'utf8');
      statusUpdated = true;
    }
  }
  return { task: readTask(dst, task.id, stage.dir), statusUpdated };
}

/** Нове значення поля «Проекти»: лишає частини (з примітками) вибраних проектів, дописує нові назви. */
function setTaskProjects(value, picked, projects) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const keysOf = (id) => (byId.has(id) ? projectKeys(byId.get(id)) : [String(id).toLowerCase()]);
  const keep = [];
  const covered = new Set();
  for (const seg of projectSegments(value)) {
    const id = picked.find((x) => keysOf(x).includes(seg.name.toLowerCase()));
    if (id !== undefined && !covered.has(id)) {
      keep.push(seg.text);
      covered.add(id);
    }
  }
  for (const id of picked) if (!covered.has(id)) keep.push(byId.has(id) ? byId.get(id).title : id);
  return keep.join(', ');
}

// ---------- підзадачі ----------
// Підзадача — звичайна задача (свій каталог і колонка). Звʼязок — wiki-посилання на номер задачі:
//   у підзадачі   «- **Батьківська задача:** [[00003]]»;
//   у батьківській розділ «## Підзадачі» з пунктами «- [ ] [[00003.1]] опис» (галочка — підзадача завершена).
// Пункт розділу без посилання — план: з нього можна створити підзадачу («розбити задачу»).

const DEFAULT_PARENT_FIELD = 'Батьківська задача';
const DEFAULT_SUBTASKS_HEADING = 'Підзадачі';
const WIKI_LINK = /\[\[([^\]\r\n]+)\]\]/g;
const LIST_ITEM = /^([ \t]*[-*+][ \t]+)(?:\[([ xX])\][ \t]+)?(.*)$/;

/** «[[Tasks/00003.md#Опис|задача]]» → «00003»: ціль без шляху, розширення, якоря і підпису. */
function wikiTarget(s) {
  let t = String(s).split('|')[0].split('#')[0].trim();
  t = t.split(/[\\/]/).pop().replace(/\.md$/i, '').trim();
  return t;
}

function parseWikiLinks(s) {
  const out = [];
  for (const m of String(s || '').matchAll(WIKI_LINK)) {
    const t = wikiTarget(m[1]);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Номер батьківської задачі з поля: «[[00003]]» або просто «00003»; немає — null. */
function readParent(text, field = DEFAULT_PARENT_FIELD) {
  const v = readField(text, field);
  if (!v) return null;
  const links = parseWikiLinks(v);
  if (links.length) return links[0];
  const m = /^[\w.-]+/.exec(v.trim());
  return m ? m[0] : null;
}

/** Межі розділу «## <heading>»: { head, start, end } (індекси рядків) або null. */
function subtaskSection(lines, heading = DEFAULT_SUBTASKS_HEADING) {
  const names = [heading, 'Subtasks'].map((h) => String(h).trim().toLowerCase());
  const head = lines.findIndex((l) => {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(l);
    return m && names.includes(m[2].trim().toLowerCase());
  });
  if (head < 0) return null;
  let end = head + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
  return { head, start: head + 1, end };
}

/**
 * Пункти розділу підзадач: [{ line, id, checked, text }]. id — перше wiki-посилання (null — пункт плану),
 * checked — стан галочки (null — без галочки), text — текст без посилань.
 */
function readSubtasks(text, heading = DEFAULT_SUBTASKS_HEADING) {
  const lines = String(text).split(/\r?\n/);
  const sec = subtaskSection(lines, heading);
  if (!sec) return [];
  const out = [];
  for (let i = sec.start; i < sec.end; i++) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) continue;
    const body = stripComments(m[3]);
    if (!body || /^<[^>]*>$/.test(body)) continue; // порожній пункт або заглушка шаблону
    const ids = parseWikiLinks(body);
    const rest = body
      .replace(WIKI_LINK, ' ')
      .replace(/^[\s—–:-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ line: i, id: ids[0] || null, checked: m[2] === undefined ? null : m[2] !== ' ', text: rest });
  }
  return out;
}

/** Номер нової підзадачі: <батьківська>.<n>, перший вільний. */
function nextSubtaskId(parentId, takenIds) {
  const taken = new Set([...takenIds].map((x) => String(x).toLowerCase()));
  let n = 1;
  while (taken.has(`${parentId}.${n}`.toLowerCase())) n++;
  return `${parentId}.${n}`;
}

/**
 * Наступний номер задачі: найбільший суто цифровий номер + 1 з тією ж шириною (провідні нулі: 00006 → 00007).
 * Номери з літерами і підзадачі (00003.1) не враховуються; цифрових немає — '1'.
 */
function nextTaskId(ids) {
  let best = null;
  for (const raw of ids) {
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) continue;
    const v = BigInt(s);
    if (!best || v > best.v || (v === best.v && s.length > best.s.length)) best = { v, s };
  }
  if (!best) return '1';
  return String(best.v + 1n).padStart(best.s.length, '0');
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Додає пункт «- [ ] [[id]] title» у розділ підзадач; розділу немає — створює його після Description. */
function addSubtaskLink(text, id, title, heading = DEFAULT_SUBTASKS_HEADING) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const item = `- [ ] [[${id}]]${title ? ` ${String(title).replace(/\s+/g, ' ').trim()}` : ''}`;
  const sec = subtaskSection(lines, heading);
  if (sec) {
    if (readSubtasks(text, heading).some((x) => x.id && x.id.toLowerCase() === String(id).toLowerCase())) return text;
    // після останнього пункту списку (заглушку шаблону «<...>» замінюємо)
    let at = -1;
    for (let i = sec.start; i < sec.end; i++) {
      const m = LIST_ITEM.exec(lines[i]);
      if (m) at = i;
      else if (/^\s*<[^>]*>\s*$/.test(lines[i])) {
        lines[i] = item;
        return lines.join(eol);
      }
    }
    if (at >= 0) {
      if (!stripComments(LIST_ITEM.exec(lines[at])[3])) lines[at] = item; // порожній «- »
      else lines.splice(at + 1, 0, item);
    } else {
      let i = sec.start;
      while (i < sec.end && !lines[i].trim()) i++;
      lines.splice(sec.start, i - sec.start, '', item, ...(i < sec.end ? [''] : []));
    }
    return lines.join(eol);
  }
  const block = [`## ${heading}`, '', item, ''];
  const desc = lines.findIndex((l) => DESCRIPTION_HEADING.test(l.trim()));
  let at = -1;
  if (desc >= 0) for (let i = desc + 1; i < lines.length && at < 0; i++) if (/^#{1,6}\s/.test(lines[i])) at = i;
  if (at < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', ...block);
  } else lines.splice(at, 0, ...block);
  return lines.join(eol);
}

/** Пункт плану (рядок line) → «- [ ] [[id]] текст». */
function linkSubtaskItem(text, line, id) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const m = LIST_ITEM.exec(lines[line] || '');
  if (!m) throw new Error(`Рядок ${line + 1} — не пункт списку`);
  const box = m[2] === undefined ? '[ ] ' : `[${m[2]}] `;
  lines[line] = `${m[1]}${box}[[${id}]] ${m[3].trim()}`;
  return lines.join(eol);
}

/** Галочка пункту підзадачі id у розділі; пункту з галочкою немає — текст без змін. */
function setSubtaskChecked(text, id, done, heading = DEFAULT_SUBTASKS_HEADING) {
  const item = readSubtasks(text, heading).find((x) => x.id && x.id.toLowerCase() === String(id).toLowerCase());
  if (!item || item.checked === null || item.checked === !!done) return text;
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  lines[item.line] = lines[item.line].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
  return lines.join(eol);
}

/** Текст розділу Description: заглушку шаблону «<...>» замінює, інакше дописує першим рядком. */
function writeDescription(text, value) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const v = String(value || '').trim();
  if (!v) return text;
  const h = lines.findIndex((l) => DESCRIPTION_HEADING.test(l.trim()));
  if (h < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', '## Description', '', v, '');
    return lines.join(eol);
  }
  let end = h + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
  const body = lines.slice(h + 1, end).filter((l) => l.trim());
  if (body.every((l) => /^\s*<[^>]*>\s*$/.test(l))) {
    lines.splice(h + 1, end - h - 1, '', v, '');
  } else {
    let i = h + 1;
    while (i < end && !lines[i].trim()) i++;
    lines.splice(i, 0, v, '');
  }
  return lines.join(eol);
}

/**
 * Звʼязки задач одного каталогу. Батьківська задача підзадачі — з її поля «Батьківська задача», а якщо
 * поля немає — перша задача, що згадує її в розділі «Підзадачі». Повертає Map(id → { parent, children, missing }):
 * parent — номер (може не існувати), children — номери підзадач (порядок розділу, далі за номером),
 * missing — посилання розділу на задачі, яких немає в каталозі.
 */
function linkSubtasks(tasks) {
  const key = (id) => String(id).toLowerCase();
  const byId = new Map(tasks.map((t) => [key(t.id), t]));
  const parentOf = new Map();
  for (const t of tasks) if (t.parent && key(t.parent) !== key(t.id)) parentOf.set(key(t.id), t.parent);
  for (const t of tasks) {
    for (const it of t.subtasks || []) {
      if (!it.id || key(it.id) === key(t.id) || !byId.has(key(it.id))) continue;
      if (!parentOf.has(key(it.id))) parentOf.set(key(it.id), t.id);
    }
  }
  const info = new Map(tasks.map((t) => [t.id, { parent: parentOf.get(key(t.id)) || null, children: [], missing: [] }]));
  for (const t of tasks) {
    const own = info.get(t.id);
    const kids = tasks.filter((c) => {
      const p = parentOf.get(key(c.id));
      return p && key(p) === key(t.id);
    });
    const order = (t.subtasks || []).filter((x) => x.id).map((x) => key(x.id));
    kids.sort((a, b) => {
      const ia = order.indexOf(key(a.id));
      const ib = order.indexOf(key(b.id));
      if (ia >= 0 || ib >= 0) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
      return compareIds(a.id, b.id);
    });
    own.children = kids.map((c) => c.id);
    for (const it of t.subtasks || []) if (it.id && !byId.has(key(it.id)) && !own.missing.includes(it.id)) own.missing.push(it.id);
  }
  return info;
}

/**
 * Створює підзадачу parent у колонці stageDir кореня root: копія шаблону, поле батьківської задачі,
 * опис, проекти батьківської; у батьківській — пункт у розділі підзадач (або посилання в пункт плану planLine).
 * opts: { parentField, subtasksHeading, projectField, effortField, status, planLine }.
 */
function createSubtask(root, templateDir, stageDir, parent, id, title, opts = {}) {
  if (!parent.taskFile) throw new Error(`У задачі ${parent.id} немає task.md`);
  const parentField = opts.parentField || DEFAULT_PARENT_FIELD;
  const heading = opts.subtasksHeading || DEFAULT_SUBTASKS_HEADING;
  const projectField = opts.projectField === undefined ? DEFAULT_PROJECT_FIELD : opts.projectField;
  const parentText = fs.readFileSync(parent.taskFile, 'utf8');
  const child = createTask(root, templateDir, stageDir, id);
  if (child.taskFile) {
    let text = fs.readFileSync(child.taskFile, 'utf8');
    const orig = text;
    if (opts.status) text = writeStatus(text, opts.status) ?? text;
    const projects = projectField && readField(parentText, projectField);
    if (projects) text = writeField(text, projectField, projects);
    text = writeField(text, parentField, `[[${parent.id}]]`);
    if (title) text = writeDescription(text, title);
    if (text !== orig) fs.writeFileSync(child.taskFile, text, 'utf8');
  }
  const next =
    opts.planLine !== undefined && opts.planLine !== null
      ? linkSubtaskItem(parentText, opts.planLine, id)
      : addSubtaskLink(parentText, id, title, heading);
  if (next !== parentText) fs.writeFileSync(parent.taskFile, next, 'utf8');
  return readTask(child.dir, id, stageDir, opts);
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
const DEFAULT_PROJECT_FIELD = 'Проекти';

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

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
    projects: parseProjectList(readField(text, opts.projectField === undefined ? DEFAULT_PROJECT_FIELD : opts.projectField)),
    parent: readParent(text, opts.parentField || DEFAULT_PARENT_FIELD),
    subtasks: readSubtasks(text, opts.subtasksHeading || DEFAULT_SUBTASKS_HEADING),
    updated: Math.max(mtime(dir), taskFile ? mtime(taskFile) : 0, mtime(path.join(dir, 'notes.md'))),
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
  // корені інших проектів усередині цього (напр. Tasks/<проект>/) — не задачі і не етапи
  const excluded = (dir) => (opts.exclude || []).some((x) => samePath(x, dir));
  const tasks = [];
  for (const s of stages) {
    for (const id of listDirs(path.join(tasksRoot, s.dir))) {
      if (excluded(path.join(tasksRoot, s.dir, id))) continue;
      tasks.push(readTask(path.join(tasksRoot, s.dir, id), id, s.dir, opts));
    }
  }
  for (const id of listDirs(tasksRoot)) {
    if (stageDirs.has(id)) continue;
    const dir = path.join(tasksRoot, id);
    if (excluded(dir)) continue;
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
  const src = path.resolve(tasksRoot, templateDir); // templateDir може бути абсолютним (загальний шаблон)
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

// ---------- сесії Claude Code ----------
// Сесії лежать у <claudeDir>/projects/<шлях робочої папки, де все крім латиниці й цифр → '->/<id>.jsonl.
// Задачу шукаємо за номером у запитах користувача. Не рахуються: службові вставки (isMeta — тексти скілів),
// результати інструментів, відкриті в редакторі файли (<ide_opened_file>), нагадування, вивід команд.

function claudeProjectDir(claudeDir, workspaceFolder) {
  return path.join(claudeDir, 'projects', path.resolve(workspaceFolder).replace(/[^A-Za-z0-9]/g, '-'));
}

const IGNORED_TAGS =
  /<(ide_opened_file|ide_selection|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;

function userPromptText(obj) {
  if (!obj || obj.type !== 'user' || obj.isMeta || obj.isSidechain || !obj.message) return null;
  const c = obj.message.content;
  let parts;
  if (typeof c === 'string') parts = [c];
  else if (Array.isArray(c)) parts = c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text);
  else return null;
  const text = parts.join('\n').replace(IGNORED_TAGS, ' ').trim();
  return text || null;
}

const NUM_RE = /\d{4,}/g;
const TS_RE = /"timestamp":"([^"]+)"/;

/** Короткий опис однієї сесії: назва, перший запит, час, номери (4+ цифр) з запитів користувача. */
function summarizeTranscript(text, sessionId) {
  const s = { sessionId, title: null, aiTitle: null, firstPrompt: null, start: null, end: null, numbers: new Set(), firstNumbers: new Set() };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const ts = TS_RE.exec(line);
    if (ts) {
      if (!s.start) s.start = ts[1];
      s.end = ts[1];
    }
    const isUser = line.includes('"type":"user"');
    const isTitle = line.includes('"custom-title"') || line.includes('"ai-title"');
    if (!isUser && !isTitle) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'custom-title' && obj.customTitle) s.title = obj.customTitle;
    else if (obj.type === 'ai-title' && obj.aiTitle) s.aiTitle = obj.aiTitle;
    const prompt = userPromptText(obj);
    if (!prompt) continue;
    const nums = prompt.match(NUM_RE) || [];
    if (!s.firstPrompt) {
      s.firstPrompt = prompt.replace(/\s+/g, ' ').slice(0, 200);
      for (const n of nums) s.firstNumbers.add(n);
    }
    for (const n of nums) s.numbers.add(n);
  }
  // назва з auto-title теж підказує задачу («Задача 86170 …»)
  for (const n of (s.aiTitle || '').match(NUM_RE) || []) s.numbers.add(n);
  for (const n of (s.title || '').match(NUM_RE) || []) s.numbers.add(n);
  return s;
}

/**
 * Сесії, де згадується задача. cache — Map(file → {mtimeMs, size, summary}), щоб не перечитувати незмінені файли.
 * Номер задачі «86937_86525» — збіг за будь-якою з частин (4+ цифр).
 */
async function findTaskSessions(projectDir, taskId, cache = new Map()) {
  const keys = String(taskId).match(NUM_RE) || [String(taskId)];
  let names;
  try {
    names = await fs.promises.readdir(projectDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(projectDir, name);
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      let text;
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch {
        continue;
      }
      entry = { mtimeMs: st.mtimeMs, size: st.size, summary: summarizeTranscript(text, name.slice(0, -6)) };
      cache.set(file, entry);
    }
    const s = entry.summary;
    if (!keys.some((k) => s.numbers.has(k))) continue;
    out.push({
      sessionId: s.sessionId,
      file,
      title: s.title || s.aiTitle || s.firstPrompt || s.sessionId,
      firstPrompt: s.firstPrompt,
      start: s.start,
      end: s.end || new Date(st.mtimeMs).toISOString(),
      primary: keys.some((k) => s.firstNumbers.has(k)),
    });
  }
  // спершу сесії, що почалися з цієї задачі, далі — свіжіші
  out.sort((a, b) => (b.primary - a.primary) || String(b.end).localeCompare(String(a.end)));
  return out;
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
  writeField,
  wikiTarget,
  parseWikiLinks,
  readParent,
  readSubtasks,
  nextSubtaskId,
  nextTaskId,
  addSubtaskLink,
  linkSubtaskItem,
  setSubtaskChecked,
  writeDescription,
  linkSubtasks,
  createSubtask,
  DEFAULT_PARENT_FIELD,
  DEFAULT_SUBTASKS_HEADING,
  projectSegments,
  parseProjectList,
  normalizeProjects,
  resolveProjects,
  filterByProject,
  doneStages,
  parseEffort,
  formatMinutes,
  projectStats,
  setTaskProjects,
  buildBoards,
  initProjectRoot,
  moveTaskToRoot,
  samePath,
  slugify,
  PROJECT_COLORS,
  readStatus,
  readField,
  claudeProjectDir,
  userPromptText,
  summarizeTranscript,
  findTaskSessions,
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
