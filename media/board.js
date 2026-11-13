// Дошка у webview. Дані приходять повідомленням {type:'state'}, дії йдуть назад через postMessage.
// Текст задач вставляється лише через textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let filter = saved.filter || '';
  let collapsed = saved.collapsed || null; // {dir: bool}
  let expanded = saved.expanded || {}; // {id: true} — розгорнутий список підзадач на картці
  let state = { stages: [], tasks: [], busy: false, project: { id: '*', title: '' } };

  const board = document.getElementById('board');
  const projectEl = document.getElementById('project');

  // колір проекту: назва кольору теми VS Code або CSS-колір
  function colorOf(c) {
    if (!c) return 'var(--vscode-descriptionForeground)';
    return /^(#|rgb|hsl)/i.test(c) ? c : `var(--vscode-charts-${c}, var(--vscode-focusBorder))`;
  }

  function renderProject() {
    const p = state.project || {};
    projectEl.textContent = '';
    const dot = el('span', 'dot');
    dot.style.setProperty('--c', colorOf(p.virtual ? '' : p.color));
    projectEl.append(dot, el('span', 'project-title', p.title || ''));
    projectEl.title = p.missing
      ? 'Проекту немає ні в налаштуваннях, ні в задачах'
      : [p.description, p.tasksDir && `Каталог задач: ${p.tasksDir}${p.ownStages ? ' · свої колонки' : ''}`].filter(Boolean).join('\n');
    if (p.tasksDir) projectEl.appendChild(el('span', 'project-dir', p.tasksDir));
    if (p.missing) projectEl.appendChild(el('span', 'badge warn', 'немає'));
  }
  const filterInput = document.getElementById('filter');
  const busyEl = document.getElementById('busy');
  filterInput.value = filter;

  function save() {
    vscode.setState({ filter, collapsed, expanded });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function matches(t) {
    if (!filter) return true;
    const f = filter.toLowerCase();
    // номер батьківської — щоб фільтр за задачею показував і її підзадачі
    return t.id.toLowerCase().includes(f) || (t.title || '').toLowerCase().includes(f) || (!!t.parent && t.parent.id.toLowerCase() === f);
  }

  function stageTitle(dir) {
    const s = state.stages.find((x) => x.dir === dir);
    return s ? s.title || s.dir : dir || 'Без етапу';
  }

  /** Показати картку задачі на дошці (з підсвіткою); якщо її не видно — відкрити task.md. */
  function focusTask(id) {
    const c = board.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!c) {
      vscode.postMessage({ type: 'open', id, file: 'task' });
      return;
    }
    c.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
  }

  function subtaskList(t) {
    const list = el('ul', 'subtasks');
    for (const s of t.children) {
      const li = el('li', 'subtask' + (s.done ? ' done' : '') + (s.missing ? ' missing' : ''));
      li.appendChild(el('span', 'sub-mark', s.missing ? '?' : s.done ? '✓' : '○'));
      li.appendChild(el('span', 'card-id', s.id));
      li.appendChild(el('span', 'sub-title', s.missing ? 'немає задачі' : s.title || ''));
      if (!s.missing) li.appendChild(el('span', 'sub-stage', stageTitle(s.stage)));
      li.title = s.missing ? '' : `${s.id} — ${stageTitle(s.stage)}${s.onBoard ? '' : ' (інша дошка)'}. Клік — показати`;
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!s.missing) focusTask(s.id);
      });
      list.appendChild(li);
    }
    for (const id of t.missingChildren || []) {
      const li = el('li', 'subtask missing');
      li.append(el('span', 'sub-mark', '?'), el('span', 'card-id', id), el('span', 'sub-title', 'задачі немає в каталозі'));
      list.appendChild(li);
    }
    return list;
  }

  function columns() {
    const cols = state.stages.map((s) => ({ dir: s.dir, title: s.title || s.dir, defCollapsed: !!s.collapsed }));
    if (state.tasks.some((t) => t.stage === '')) cols.unshift({ dir: '', title: 'Без етапу', defCollapsed: false, noDrop: true });
    return cols;
  }

  function isCollapsed(c) {
    if (collapsed && Object.prototype.hasOwnProperty.call(collapsed, c.dir)) return collapsed[c.dir];
    return c.defCollapsed;
  }

  function card(t) {
    const c = el('article', 'card');
    c.draggable = !state.busy;
    c.dataset.id = t.id;
    c.title = 'Клік — task.md';

    const head = el('div', 'card-head');
    head.appendChild(el('span', 'card-id', t.id));
    const tools = el('span', 'card-tools');
    const notes = el('button', 'icon', '✎');
    notes.title = 'notes.md';
    notes.disabled = !t.hasNotes;
    notes.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'open', id: t.id, file: 'notes' });
    });
    const reveal = el('button', 'icon', '📁');
    reveal.title = 'Показати в провіднику';
    reveal.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'reveal', id: t.id });
    });
    const chat = el('button', 'icon', '💬');
    chat.title = 'Сесії Claude Code цієї задачі';
    chat.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'sessions', id: t.id });
    });
    // 🏷 — рядок «Проекти» (лише у спільному каталозі); ⇄ — перенести каталог задачі в інший проект
    if (!state.project.ownRoot) {
      const tag = el('button', 'icon', '🏷');
      tag.title = 'Проекти задачі (рядок «Проекти» в task.md)';
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'setProjects', id: t.id });
      });
      tools.appendChild(tag);
    }
    if (state.moveTargets) {
      const mv = el('button', 'icon', '⇄');
      mv.title = 'Перенести в інший проект (каталог задачі переїде)';
      mv.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'moveToProject', id: t.id });
      });
      tools.appendChild(mv);
    }
    const split = el('button', 'icon', '⊕');
    split.title = t.plan ? `Розбити на підзадачі: план — ${t.plan} пункт.` : 'Додати підзадачу';
    split.disabled = state.busy;
    split.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'addSubtask', id: t.id });
    });
    tools.append(split, chat, notes, reveal);
    head.appendChild(tools);
    c.appendChild(head);

    if (t.title) c.appendChild(el('div', 'card-title', t.title));

    const badges = el('div', 'badges');
    if (t.parent) {
      const p = t.parent;
      const b = el('span', 'badge link' + (p.missing ? ' warn' : ''), `↑ ${p.id}`);
      b.title = p.missing ? `Батьківської задачі ${p.id} немає в каталозі` : `Підзадача ${p.id}${p.title ? ' — ' + p.title : ''}. Клік — показати`;
      if (!p.missing) {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          focusTask(p.id);
        });
      }
      badges.appendChild(b);
    }
    const kids = (t.children || []).length + (t.missingChildren || []).length;
    if (kids) {
      const n = t.children.filter((s) => s.done).length;
      const b = el('span', 'badge link' + (n === t.children.length && !t.missingChildren.length ? ' all-done' : ''), `${expanded[t.id] ? '▾' : '▸'} ☑ ${n}/${kids}`);
      b.title = `Підзадачі: завершено ${n} з ${kids}. Клік — ${expanded[t.id] ? 'згорнути' : 'розгорнути'} список`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = Object.assign({}, expanded);
        if (expanded[t.id]) delete expanded[t.id];
        else expanded[t.id] = true;
        save();
        render();
      });
      badges.appendChild(b);
    }
    if (t.plan) {
      const b = el('span', 'badge plan', `☐ план ${t.plan}`);
      b.title = 'Пункти розділу «Підзадачі» без задач — ⊕ щоб розбити задачу за планом';
      badges.appendChild(b);
    }
    // на дошці одного проекту його чип зайвий — показуємо лише інші проекти задачі
    for (const p of t.projects || []) {
      if (p.id === state.project.id) continue;
      const b = el('span', 'badge proj', p.title);
      b.style.setProperty('--c', colorOf(p.color));
      b.title = `Проект ${p.title} — відкрити його дошку`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openBoard', project: p.id });
      });
      badges.appendChild(b);
    }
    if (t.effort) {
      const b = el('span', 'badge effort', `⏱ ${t.effort}`);
      b.title = `Трудомісткість: ${t.effort}`;
      badges.appendChild(b);
    }
    if (t.hasSql) badges.appendChild(el('span', 'badge', 'path.sql'));
    if (t.zipVersion) badges.appendChild(el('span', 'badge zip', `zip v${t.zipVersion}`));
    const stage = state.stages.find((s) => s.dir === t.stage);
    if (stage && stage.status && t.status && t.status.toLowerCase() !== stage.status.toLowerCase()) {
      const b = el('span', 'badge warn', `статус: ${t.status}`);
      b.title = `У task.md статус «${t.status}», а етап — «${stage.status}»`;
      badges.appendChild(b);
    }
    if (badges.childElementCount) c.appendChild(badges);
    if (kids && expanded[t.id]) c.appendChild(subtaskList(t));
    if (t.parent) c.classList.add('is-subtask');

    c.addEventListener('click', () => vscode.postMessage({ type: 'open', id: t.id, file: 'task' }));
    c.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', t.id);
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
    });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
    return c;
  }

  function columnTools(col, total) {
    const tools = el('span', 'column-tools');
    const idx = state.stages.findIndex((s) => s.dir === col.dir);
    const btn = (text, title, msg, disabled) => {
      const b = el('button', 'icon', text);
      b.title = title;
      b.disabled = !!disabled || state.busy;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage(msg);
      });
      tools.appendChild(b);
    };
    btn('◀', 'Перемістити ліворуч', { type: 'moveColumn', dir: col.dir, delta: -1 }, idx <= 0);
    btn('▶', 'Перемістити праворуч', { type: 'moveColumn', dir: col.dir, delta: 1 }, idx >= state.stages.length - 1);
    btn('✎', 'Змінити назву і статус', { type: 'editColumn', dir: col.dir });
    btn('＋', 'Додати колонку праворуч', { type: 'addColumn', after: idx });
    btn(
      '✕',
      total ? 'Видалити можна лише порожню колонку' : 'Видалити колонку',
      { type: 'deleteColumn', dir: col.dir },
      total > 0 || state.stages.length <= 1,
    );
    return tools;
  }

  function render() {
    busyEl.hidden = !state.busy;
    renderProject();
    board.textContent = '';
    for (const col of columns()) {
      const tasks = state.tasks.filter((t) => t.stage === col.dir && matches(t));
      const total = state.tasks.filter((t) => t.stage === col.dir).length;
      const isC = isCollapsed(col);

      const section = el('section', 'column' + (isC ? ' collapsed' : ''));
      section.dataset.dir = col.dir;
      const header = el('header', 'column-head');
      header.appendChild(el('span', 'column-title', col.title));
      const right = el('span', 'column-right');
      if (!col.noDrop && !isC) right.appendChild(columnTools(col, total));
      right.appendChild(el('span', 'count', filter ? `${tasks.length}/${total}` : String(total)));
      header.appendChild(right);
      header.title = isC ? 'Розгорнути' : 'Згорнути';
      header.addEventListener('click', () => {
        collapsed = Object.assign({}, collapsed, { [col.dir]: !isC });
        save();
        render();
      });
      section.appendChild(header);

      const list = el('div', 'cards');
      if (!isC) for (const t of tasks) list.appendChild(card(t));
      section.appendChild(list);

      if (!col.noDrop) {
        section.addEventListener('dragover', (e) => {
          if (state.busy) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          section.classList.add('drop');
        });
        section.addEventListener('dragleave', (e) => {
          if (!section.contains(e.relatedTarget)) section.classList.remove('drop');
        });
        section.addEventListener('drop', (e) => {
          e.preventDefault();
          section.classList.remove('drop');
          const id = e.dataTransfer.getData('text/plain');
          const t = state.tasks.find((x) => x.id === id);
          if (t && t.stage !== col.dir) vscode.postMessage({ type: 'move', id, to: col.dir });
        });
      }
      board.appendChild(section);
    }
  }

  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim();
    save();
    render();
  });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newTask', project: state.project.id }));
  document.getElementById('back').addEventListener('click', () => vscode.postMessage({ type: 'dashboard' }));
  document.getElementById('addColumn').addEventListener('click', () => vscode.postMessage({ type: 'addColumn' }));

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
