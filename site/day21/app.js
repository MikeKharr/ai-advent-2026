'use strict';
/* Итог дня 21: читает results.json, считает вердикт, рисует строки вопросов.
   Раскладка и тексты — agent_docs/design/2026-10-02-1950-day21-rag-results.md.
   Вердикт, признак расхождения, порог шума и числа на чипах считаются здесь:
   файл данных не может сказать «лучше структурная» при числах, говорящих обратное. */

const ERROR_MSG = 'Не удалось прочитать результаты прогона (results.json). ' +
  'Страница живёт по адресу challenge.zpq.ai/day21/; с диска она данных не покажет.';
const EMPTY_MSG = 'Прогон меры ещё не сделан. Числа появятся после первого полного ' +
  'прогона на собранном индексе.';
const NO_DETAIL = 'нет данных';

/* Порядок на экране — fixed, затем structural (как в данных и в ADR). */
const SIDES = ['fixed', 'structural'];
const METRICS = [
  { row: 'recall', key: 'recall@5', name: 'Recall@5', basis: 'queries', kind: 'abs' },
  { row: 'mrr', key: 'mrr@10', name: 'MRR@10', basis: 'queries', kind: 'abs' },
  { row: 'phrase', key: 'phrase_in_first_chunk', name: 'фраза-ответ в первом чанке',
    basis: 'phrase_queries', kind: 'points' },
];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* Склонение после числа: 1 файл, 2 файла, 5 файлов. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
}
/* Четыре знака — как в самих данных; выравнивание колонки важнее краткости. */
const fmt = (v) => v.toFixed(4);
const fmtDiff = (d) => (d < 0 ? '−' : '+') + Math.abs(d).toFixed(4);
const quote = (label) => '«' + label.charAt(0).toLowerCase() + label.slice(1) + '»';

function fmtRun(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
}

function hasMetrics(s) {
  return !!s && !s.error && typeof s.queries === 'number' &&
    METRICS.every((m) => typeof s[m.key] === 'number');
}

function showMessage(text) {
  const v = $('verdict');
  v.className = 'status msg js-only';
  v.textContent = text;
  $('metrics').hidden = true;
  $('metrics-note').hidden = true;
  $('sum-partial').hidden = true;
  $('strat-status').textContent = text;
  $('q-status').textContent = text;
  $('corpus-files').textContent = 'число файлов будет после прогона';
}

/* ── Вердикт ──────────────────────────────────────────────────────────── */

function deltas(data) {
  const basis = (name) => {
    const a = data.fixed && data.fixed[name], b = data.structural && data.structural[name];
    return typeof a === 'number' ? a : b;
  };
  return METRICS.map((m) => {
    const d = data.structural[m.key] - data.fixed[m.key];
    const total = basis(m.basis);
    const noise = 2 / total;
    return { m: m, d: d, noise: noise, beyond: Math.abs(d) > noise };
  });
}

/* Счёт по отдельным вопросам: у кого верный документ выше. Считается из
   queries[].<стратегия>.rank — тех же рангов, из которых мера берёт MRR@10.
   null — нет в первой десятке. Вопросы без разбора по одной из стратегий не
   считаются вовсе. */
function headToHead(data) {
  if (!Array.isArray(data.queries)) return null;
  let s = 0, f = 0, tie = 0, none = 0, n = 0;
  data.queries.forEach((q) => {
    if (!q.fixed || !q.structural) return;
    const a = q.fixed.rank, b = q.structural.rank;
    n += 1;
    if (a == null && b == null) { none += 1; tie += 1; return; }
    if (b != null && (a == null || b < a)) s += 1;
    else if (a != null && (b == null || a < b)) f += 1;
    else tie += 1;
  });
  return n ? { structural: s, fixed: f, tie: tie, none: none, n: n } : null;
}

/* Двусторонний знаковый тест: вероятность получить случайно такой или более
   сильный перекос при равных стратегиях. Ничьи не участвуют. */
function signTestP(a, b) {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.max(a, b);
  let tail = 0, c = 1;            // c = C(n, i), считаем от i = 0
  for (let i = 0; i <= n; i += 1) {
    if (i >= k) tail += c;
    c = c * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * tail / Math.pow(2, n));
}

function verdictText(data, ds) {
  const beyond = ds.filter((x) => x.beyond);
  const total = typeof data.fixed.queries === 'number' ? data.fixed.queries : data.structural.queries;
  if (beyond.length === 0) {
    return 'Стратегии неразличимы: разница по всем трём метрикам не больше двух вопросов из ' +
      total + '.';
  }
  const amount = (x) => x.m.kind === 'points'
    ? (() => { const p = Math.round(Math.abs(x.d) * 100);
        return p + ' ' + plural(p, 'пункт', 'пункта', 'пунктов'); })()
    : fmt(Math.abs(x.d));
  const sameWay = beyond.every((x) => (x.d > 0) === (beyond[0].d > 0));
  if (sameWay) {
    // «Направление», а не «лучше»: превышение порога шума говорит, что разница
    // не нулевая, но не что она доказана. Доказанность отвечает знаковый тест
    // по отдельным вопросам (находка design-review: страница писала «Лучше» при
    // p ≈ 0,31, а презентация того же прогона — «не доказан»).
    const winSide = beyond[0].d > 0 ? 'structural' : 'fixed';
    const loseSide = winSide === 'structural' ? 'fixed' : 'structural';
    const winner = data[winSide].label;
    const parts = beyond.map((x, i) => x.m.name + (i === 0 ? ' выше на ' : ' — на ') + amount(x));
    let text = 'Направление за ' + quote(winner) + ': ' + parts.join(', ') + '.';
    const h = headToHead(data);
    if (!h) return text + ' По отдельным вопросам этот прогон не разбирался.';
    const w = h[winSide], l = h[loseSide], diverged = w + l;
    const p = signTestP(w, l);
    const score = 'по отдельным вопросам ' + quote(winner) + ' впереди в ' + w + ' из ' + diverged +
      ' разошедшихся, ' + quote(data[loseSide].label) + ' — в ' + l + ', ничьих ' + h.tie;
    text += p < 0.05
      ? ' Перевес доказан: ' + score + ' (знаковый тест, p = ' + p.toFixed(2) + ').'
      : ' Перевес не доказан: ' + score + '. Случайно такой или более сильный расклад ' +
        'получается с вероятностью ' + p.toFixed(2) + ' (знаковый тест).';
    return text;
  }
  const parts = beyond.map((x, i) => x.m.name + (i === 0 ? ' выше у ' : ' — у ') +
    quote(data[x.d > 0 ? 'structural' : 'fixed'].label) + ' на ' + amount(x));
  return 'Метрики расходятся: ' + parts.join(', ') + '. Одной лучшей стратегии числа не дают.';
}

/* ── Итог ─────────────────────────────────────────────────────────────── */

function renderSummary(data) {
  const ok = { fixed: hasMetrics(data.fixed), structural: hasMetrics(data.structural) };
  const v = $('verdict');

  SIDES.forEach((s) => { $('m-' + s).textContent = data[s].label || s; });
  METRICS.forEach((m) => {
    SIDES.forEach((s) => {
      $('m-' + m.row + '-' + s).textContent = ok[s] ? fmt(data[s][m.key]) : NO_DETAIL;
    });
  });

  if (ok.fixed && ok.structural) {
    const ds = deltas(data);
    ds.forEach((x) => {
      const cell = $('m-' + x.m.row + '-diff');
      cell.textContent = '';
      cell.appendChild(document.createTextNode(fmtDiff(x.d)));
      cell.appendChild(el('span', 'diff-word', x.beyond ? 'больше шума' : 'шум'));
    });
    v.className = 'verdict js-only';
    // Сколько вопросов не нашла ни одна стратегия — часть ответа «насколько
    // уверенно», а не подробность для фильтра (находка design-review).
    const h = headToHead(data);
    v.textContent = verdictText(data, ds) + (h && h.none
      ? ' У ' + h.none + ' ' + plural(h.none, 'вопроса', 'вопросов', 'вопросов') + ' из ' + h.n +
        ' ни одна стратегия не нашла эталон в первой десятке.'
      : '');
    $('sum-partial').hidden = true;
  } else {
    METRICS.forEach((m) => { $('m-' + m.row + '-diff').textContent = NO_DETAIL; });
    v.className = 'verdict js-only';
    v.textContent = 'Сравнивать нечего: измерена одна стратегия из двух.';
    const missing = SIDES.filter((s) => !ok[s]).map((s) => {
      const why = (data[s] && data[s].error) ? data[s].error : 'метрик в прогоне нет';
      return 'Стратегия ' + quote(data[s].label || s) + ' не измерена: ' + why + '.';
    });
    const p = $('sum-partial');
    p.textContent = missing.join(' ');
    p.hidden = false;
  }

  const total = ok.fixed ? data.fixed.queries : data.structural.queries;
  const phrase = ok.fixed ? data.fixed.phrase_queries : data.structural.phrase_queries;
  $('metrics-note').textContent = 'Вопросов: ' + total + ', из них с фразой-ответом: ' + phrase + '.';
  $('limit-total').textContent = String(total);
  $('metrics').hidden = false;
  $('metrics-note').hidden = false;
  return total;
}

/* ── Две стратегии ────────────────────────────────────────────────────── */

const STATS = [
  { key: 'chunks', label: 'Чанков' },
  { key: 'len_median', label: 'Медиана длины' },
  { key: 'len_max', label: 'Максимум' },
];

function renderStrategies(data) {
  const box = $('strats');
  box.textContent = '';
  SIDES.forEach((s) => {
    const src = data[s] || {};
    const panel = el('div', 'panel strat');
    panel.appendChild(el('h3', null, src.label || s));
    if (src.about) panel.appendChild(el('p', 'strat-about', src.about));
    if (src.error) panel.appendChild(el('p', 'strat-about', 'Не измерена: ' + src.error));
    const dl = el('dl', 'strat-stats');
    STATS.forEach((st) => {
      dl.appendChild(el('dt', null, st.label));
      dl.appendChild(el('dd', null, typeof src[st.key] === 'number' ? String(src[st.key]) : NO_DETAIL));
    });
    panel.appendChild(dl);
    box.appendChild(panel);
  });
  $('strat-status').hidden = true;
}

/* ── Сто вопросов по одному ───────────────────────────────────────────── */

/* Признак расхождения: ранги разошлись. Равные ненулевые ранги при разных
   путях расхождением не считаются — мера документная. */
function tagOf(q) {
  const a = q.fixed, b = q.structural;
  if (!a || !b) return '';
  if (a.rank === null && b.rank === null) return 'ни одна';
  if (a.rank !== b.rank) return 'разошлись';
  return '';
}

function rankText(side) {
  if (!side) return NO_DETAIL;
  return side.rank === null ? 'нет' : String(side.rank);
}

function queryRow(q, data) {
  const li = document.createElement('li');
  const det = document.createElement('details');
  const sum = el('summary', 'q-sum');
  sum.appendChild(el('span', 'q-id num', q.id || ''));
  sum.appendChild(el('span', 'q-text', q.question || ''));
  const ranks = el('span', 'ranks');
  SIDES.forEach((s) => {
    const r = el('span', 'rank');
    r.appendChild(el('span', 'rank-label', (data[s] && data[s].label) || s));
    r.appendChild(el('span', 'rank-val', rankText(q[s])));
    ranks.appendChild(r);
  });
  sum.appendChild(ranks);
  const tag = el('span', 'q-tag');
  const t = tagOf(q);
  if (t) tag.appendChild(el('span', null, t));
  sum.appendChild(tag);
  const mark = el('span', 'q-mark');
  mark.setAttribute('aria-hidden', 'true');
  sum.appendChild(mark);
  det.appendChild(sum);

  const body = el('div', 'q-body');
  const exp = el('p', 'q-exp');
  exp.appendChild(el('span', 'lbl', 'Эталонный документ'));
  exp.appendChild(document.createTextNode(' '));
  const paths = Array.isArray(q.expected) ? q.expected : [];
  paths.forEach((path, i) => {
    if (i) exp.appendChild(document.createTextNode(', '));
    exp.appendChild(el('code', null, path));
  });
  body.appendChild(exp);

  const cols = el('div', 'q-cols');
  SIDES.forEach((s) => {
    const col = el('div', 'q-col');
    const side = q[s];
    const label = (data[s] && data[s].label) || s;
    if (!side) {
      col.appendChild(el('p', 'q-col-head', label + ' · ' + NO_DETAIL));
      cols.appendChild(col);
      return;
    }
    col.appendChild(el('p', 'q-col-head', label + ' · ранг ' + rankText(side)));
    const first = Array.isArray(side.top) ? side.top[0] : null;
    if (first) {
      // Ярлык обязателен: без него путь под «ранг нет» читался как эталон
      // (находка design-review, q02).
      col.appendChild(el('span', 'lbl', 'Первым нашлось'));
      col.appendChild(el('p', 'q-path', first.source || ''));
      if (first.section) col.appendChild(el('p', 'q-sect', first.section));
      if (first.excerpt) col.appendChild(el('p', 'q-exc', '«' + first.excerpt + '»'));
    }
    if (side.phrase_in_first !== null && side.phrase_in_first !== undefined) {
      col.appendChild(el('p', 'q-phrase',
        'Фраза-ответ в первом чанке: ' + (side.phrase_in_first ? 'да' : 'нет')));
    }
    cols.appendChild(col);
  });
  body.appendChild(cols);
  det.appendChild(body);
  li.appendChild(det);
  return li;
}

const FILTERS = [
  { id: 'all', text: 'Все', keep: () => true },
  { id: 'diverged', text: 'Разошлись', keep: (q) => tagOf(q) === 'разошлись' },
  { id: 'none', text: 'Ни одна не нашла', keep: (q) => tagOf(q) === 'ни одна' },
];

function renderQueries(data) {
  const list = Array.isArray(data.queries) ? data.queries : null;
  if (!list || list.length === 0) {
    $('q-status').textContent =
      'Разбора по вопросам в этом прогоне нет: сводка снята без построчного отчёта.';
    return;
  }
  const rows = list.map((q) => ({ q: q, node: queryRow(q, data) }));
  const ul = $('qs');
  rows.forEach((r) => ul.appendChild(r.node));
  $('q-headbar').hidden = false;
  SIDES.forEach((s) => { $('hb-' + s).textContent = (data[s] && data[s].label) || s; });
  $('q-status').hidden = true;

  const chips = $('chips');
  const apply = (f) => {
    let shown = 0;
    rows.forEach((r) => {
      const keep = f.keep(r.q);
      r.node.hidden = !keep;
      if (keep) shown += 1;
    });
    $('q-count').textContent = 'Показано ' + shown + ' из ' + list.length;
    Array.prototype.forEach.call(chips.children, (b) => {
      b.setAttribute('aria-pressed', String(b.dataset.filter === f.id));
    });
  };
  FILTERS.forEach((f) => {
    const n = list.filter(f.keep).length;
    const b = el('button', 'chip', f.text + ' ' + n);
    b.type = 'button';
    b.dataset.filter = f.id;
    b.setAttribute('aria-pressed', 'false');
    /* Чип с нулём выключен, а не спрятан: исчезающий ряд читается как сбой. */
    if (n === 0) b.disabled = true;
    else b.addEventListener('click', () => apply(f));
    chips.appendChild(b);
  });
  $('filter').hidden = false;
  apply(FILTERS[0]);
}

/* ── Сборка ───────────────────────────────────────────────────────────── */

function valid(d) {
  return !!d && typeof d === 'object' &&
    typeof d.generated === 'string' && typeof d.commit === 'string' &&
    typeof d.model === 'string' &&
    !!d.corpus && typeof d.corpus.files === 'number' &&
    !!d.fixed && typeof d.fixed === 'object' &&
    !!d.structural && typeof d.structural === 'object';
}

function render(data) {
  if (!valid(data)) { showMessage(ERROR_MSG); return; }
  if (!hasMetrics(data.fixed) && !hasMetrics(data.structural)) { showMessage(EMPTY_MSG); return; }
  $('corpus-files').textContent =
    data.corpus.files + ' ' + plural(data.corpus.files, 'файл', 'файла', 'файлов') + '.';
  $('run-line').textContent = 'Прогон ' + fmtRun(data.generated) + ' · коммит ' +
    data.commit + ' · модель ' + data.model + '.';
  renderSummary(data);
  renderStrategies(data);
  renderQueries(data);
}

fetch('results.json', { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch(() => showMessage(ERROR_MSG));
