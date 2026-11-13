// Дашборд проектів у webview. Дані — повідомлення {type:'state'}, дії — postMessage.
// Текст задач і проектів вставляється лише через textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let filter = saved.filter || '';
  let state = null;

  const root = document.getElementById('root');
  const filterInput = document.getElementById('filter');
  const busyEl = document.getElementById('busy');
  const subtitle = document.getElementById('subtitle');
  const tip = document.getElementById('tip');
  filterInput.value = filter;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  function colorOf(c) {
    if (!c) return 'var(--vscode-descriptionForeground)';
    return /^(#|rgb|hsl)/i.test(c) ? c : `var(--vscode-charts-${c}, var(--vscode-focusBorder))`;
  }

  function fmtMin(min) {
    return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  }

  function plural(n, one, few, many) {
    const a = n % 10;
    const b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }
  const tasksWord = (n) => `${n} ${plural(n, 'задача', 'задачі', 'задач')}`;

  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'щойно';
    if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
    if (s < 86400) return `${Math.floor(s / 3600)} год тому`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} дн тому`;
    const d = new Date(ms);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  }

  function initials(title) {
    const words = String(title || '?').split(/[\s_.-]+/).filter(Boolean);
    const s = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }

  // ---------- підказка ----------

  function hover(node, text) {
    node.addEventListener('mouseenter', () => {
      tip.textContent = text;
      tip.hidden = false;
    });
    node.addEventListener('mousemove', (e) => {
      const w = tip.offsetWidth;
      const x = Math.min(e.clientX + 12, window.innerWidth - w - 8);
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${e.clientY + 16}px`;
    });
    node.addEventListener('mouseleave', () => (tip.hidden = true));
  }

  // ---------- частини картки ----------

  function stageName(stages, dir) {
    const s = stages.find((x) => x.dir === dir);
    return s ? s.title : 'Без етапу';
  }

  /** Розподіл задач по колонках проекту: послідовна шкала його кольору, світліше → темніше по ходу етапів. */
  function stageBar(stages, stats, color) {
    const wrap = el('div', 'dist');
    const bar = el('div', 'bar');
    const legend = el('div', 'legend');
    const n = stages.length;
    const parts = [];
    stages.forEach((s, i) => {
      const count = stats.byStage[s.dir] || 0;
      if (!count) return;
      const pct = n > 1 ? Math.round(35 + (65 * i) / (n - 1)) : 100;
      const base = color ? colorOf(color) : 'var(--vscode-foreground)';
      parts.push({ title: s.title, count, done: s.done, fill: `color-mix(in srgb, ${base} ${pct}%, var(--surface))` });
    });
    if (stats.noStage) parts.push({ title: 'Без етапу', count: stats.noStage, fill: 'var(--vscode-disabledForeground, #888)' });
    if (!parts.length) {
      bar.classList.add('empty');
      wrap.appendChild(bar);
      return wrap;
    }
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', parts.map((p) => `${p.title}: ${p.count}`).join(', '));
    for (const p of parts) {
      const seg = el('span', 'seg');
      seg.style.flexGrow = String(p.count);
      seg.style.setProperty('--fill', p.fill);
      hover(seg, `${p.title}: ${tasksWord(p.count)}${p.done ? ' (завершені)' : ''}`);
      bar.appendChild(seg);

      const item = el('span', 'legend-item');
      const sw = el('span', 'swatch');
      sw.style.setProperty('--fill', p.fill);
      item.append(sw, el('span', 'legend-title', p.title), el('span', 'legend-count', String(p.count)));
      legend.appendChild(item);
    }
    wrap.append(bar, legend);
    return wrap;
  }

  function metric(label, value, cls) {
    const m = el('div', 'metric' + (cls ? ` ${cls}` : ''));
    m.append(el('div', 'metric-value', value), el('div', 'metric-label', label));
    return m;
  }

  function recentList(p) {
    const box = el('div', 'recent');
    if (!p.recent.length) {
      box.appendChild(el('div', 'recent-empty', 'Активних задач немає'));
      return box;
    }
    box.appendChild(el('div', 'section-label', 'Останні активні'));
    for (const t of p.recent) {
      const row = el('button', 'recent-row');
      row.title = 'Відкрити task.md';
      row.append(el('span', 'recent-id', t.id), el('span', 'recent-title', t.title || '—'), el('span', 'pill', stageName(p.stages, t.stage)));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'open', id: t.id, file: 'task', project: p.id });
      });
      box.appendChild(row);
    }
    return box;
  }

  function iconBtn(text, title, onClick) {
    const b = el('button', 'icon', text);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = !!state.busy;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /** kind: 'project' — проект; 'all' — усі задачі; 'none' — задачі без проекту. */
  function projectCard(p, kind) {
    const isProject = kind === 'project';
    const card = el('article', `pcard ${kind}${isProject && !p.configured ? ' auto' : ''}`);
    card.style.setProperty('--c', colorOf(isProject ? p.color : ''));
    card.tabIndex = 0;
    const open = () => post({ type: 'openBoard', project: p.id });
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === card) open();
    });

    const head = el('header', 'pcard-head');
    const avatar = el('div', 'avatar', kind === 'all' ? '∑' : kind === 'none' ? '?' : initials(p.title));
    const names = el('div', 'names');
    names.appendChild(el('h2', 'pcard-title', p.title));
    let meta = '';
    if (kind === 'all') meta = `спільний каталог · ${p.tasksDir}`;
    else if (kind === 'none') meta = 'у task.md не вказано проект';
    else if (!p.configured) meta = 'з task.md · немає в налаштуваннях';
    else meta = [p.id, ...(p.aliases || [])].join(' · ');
    names.appendChild(el('div', 'pcard-meta', meta));
    if (isProject && p.ownRoot) {
      const dir = el('div', 'pcard-dir', `📁 ${p.tasksDir}${p.ownStages ? ' · свої колонки' : ''}`);
      dir.title = 'Власний каталог задач проекту: <каталог>/<етап>/<номер>/';
      names.appendChild(dir);
    }
    head.append(avatar, names);
    if (isProject) {
      const actions = el('div', 'pcard-actions');
      if (p.configured) {
        actions.append(
          iconBtn('✎', 'Змінити проект', () => post({ type: 'editProject', project: p.id })),
          iconBtn('✕', 'Видалити проект з налаштувань', () => post({ type: 'deleteProject', project: p.id })),
        );
      } else {
        actions.append(iconBtn('＋', 'Додати в налаштування (назва, колір, опис)', () => post({ type: 'editProject', project: p.id })));
      }
      head.appendChild(actions);
    }
    card.appendChild(head);

    if (p.description) card.appendChild(el('p', 'pcard-desc', p.description));

    const st = p.stats;
    const metrics = el('div', 'metrics');
    metrics.append(
      metric('активні', String(st.active), 'lead'),
      metric('усього', String(st.total)),
      metric('завершено', String(st.done)),
    );
    const eff = metric('трудомісткість', st.withEffort ? fmtMin(st.effortMinutes) : '—');
    if (st.withEffort) hover(eff, `Сума «Трудомісткість» по ${tasksWord(st.withEffort)}`);
    metrics.appendChild(eff);
    card.appendChild(metrics);

    card.appendChild(stageBar(p.stages, st, isProject ? p.color : ''));
    card.appendChild(recentList(p));

    const foot = el('footer', 'pcard-foot');
    foot.appendChild(el('span', 'muted', st.updated ? `оновлено ${ago(st.updated)}` : 'задач ще немає'));
    const btns = el('span', 'foot-btns');
    if (kind !== 'none') {
      const nb = el('button', 'secondary', '+ Задача');
      nb.disabled = !!state.busy;
      nb.addEventListener('click', (e) => {
        e.stopPropagation();
        post({ type: 'newTask', project: p.id });
      });
      btns.appendChild(nb);
    }
    const ob = el('button', '', 'Дошка →');
    ob.addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
    btns.appendChild(ob);
    foot.appendChild(btns);
    card.appendChild(foot);
    return card;
  }

  function kpi(label, value, sub) {
    const k = el('div', 'kpi');
    k.append(el('div', 'kpi-label', label), el('div', 'kpi-value', value));
    if (sub) k.appendChild(el('div', 'kpi-sub', sub));
    return k;
  }

  function matches(p) {
    if (!filter) return true;
    const f = filter.toLowerCase();
    return [p.id, p.title, p.description || '', ...(p.aliases || [])].some((s) => String(s).toLowerCase().includes(f));
  }

  function render() {
    if (!state) return;
    busyEl.hidden = !state.busy;
    const all = state.total;
    subtitle.textContent = `${state.folder} · ${tasksWord(all.total)}`;
    root.textContent = '';

    const configured = state.projects.filter((p) => p.configured).length;
    const auto = state.projects.length - configured;
    const kpis = el('section', 'kpis');
    kpis.append(
      kpi('Проекти', String(state.projects.length), auto ? `${configured} налаштовано · ${auto} лише в задачах` : 'усі налаштовані'),
      kpi('Активні задачі', String(all.active), `з ${tasksWord(all.total)}`),
      kpi('Завершено', String(all.done), all.total ? `${Math.round((100 * all.done) / all.total)}% задач` : ''),
      kpi('Трудомісткість', all.withEffort ? fmtMin(all.effortMinutes) : '—', all.withEffort ? `год:хв по ${tasksWord(all.withEffort)}` : 'ще не оцінено'),
    );
    root.appendChild(kpis);

    const shown = state.projects.filter(matches);
    const grid = el('section', 'grid');
    for (const p of shown) grid.appendChild(projectCard(p, 'project'));
    if (!filter && state.all) grid.appendChild(projectCard(state.all, 'all'));
    if (!filter && state.none) grid.appendChild(projectCard(state.none, 'none'));

    if (!state.projects.length) {
      const empty = el('article', 'pcard empty-card');
      empty.append(
        el('h2', 'pcard-title', 'Проектів ще немає'),
        el('p', 'pcard-desc', 'Створіть проект — у нього буде своя канбан-дошка. Задачі потрапляють у проект за рядком «- **Проекти:** …» у task.md.'),
      );
      const b = el('button', '', '+ Проект');
      b.addEventListener('click', () => post({ type: 'addProject' }));
      empty.appendChild(b);
      grid.appendChild(empty);
    } else if (filter && !shown.length) {
      grid.appendChild(el('div', 'nothing', `Проектів за «${filter}» не знайдено`));
    }
    root.appendChild(grid);
  }

  filterInput.addEventListener('input', () => {
    filter = filterInput.value.trim();
    vscode.setState({ filter });
    render();
  });
  document.getElementById('addProject').addEventListener('click', () => post({ type: 'addProject' }));
  document.getElementById('refresh').addEventListener('click', () => post({ type: 'refresh' }));

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      tip.hidden = true;
      render();
    }
  });
  // «оновлено N хв тому» — перераховувати без нових даних
  setInterval(render, 60000);
  post({ type: 'ready' });
})();
