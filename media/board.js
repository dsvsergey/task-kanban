// Дошка у webview. Дані приходять повідомленням {type:'state'}, дії йдуть назад через postMessage.
// Текст задач вставляється лише через textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let filter = saved.filter || '';
  let collapsed = saved.collapsed || null; // {dir: bool}
  let state = { stages: [], tasks: [], busy: false };

  const board = document.getElementById('board');
  const filterInput = document.getElementById('filter');
  const busyEl = document.getElementById('busy');
  filterInput.value = filter;

  function save() {
    vscode.setState({ filter, collapsed });
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
    return t.id.toLowerCase().includes(f) || (t.title || '').toLowerCase().includes(f);
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
    tools.append(chat, notes, reveal);
    head.appendChild(tools);
    c.appendChild(head);

    if (t.title) c.appendChild(el('div', 'card-title', t.title));

    const badges = el('div', 'badges');
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
  document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newTask' }));
  document.getElementById('addColumn').addEventListener('click', () => vscode.postMessage({ type: 'addColumn' }));

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      render();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
