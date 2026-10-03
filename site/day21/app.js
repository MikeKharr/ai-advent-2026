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

/* Вердикт и его счёт — в verdict.js (подключён раньше), чтобы у них был тест. */
const { SIDES, METRICS, plural, fmt, quote, deltas, verdictText, noneText } =
  globalThis.DAY21_VERDICT;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* Ссылка на файл в репозитории: «верный документ» — это файл, который поиск
   должен был поставить первым, и его надо иметь возможность открыть. */
const REPO = 'https://github.com/MikeKharr/ai-advent-2026/blob/main/';
function fileLink(path) {
  const a = el('a', 'q-file');
  a.href = REPO + path.split('/').map(encodeURIComponent).join('/');
  a.appendChild(el('code', null, path));
  return a;
}

/* Ярлык стратегии в строке вопроса говорит, что за число стоит рядом: без
   слова «место» числа 1…10 читались как что угодно (замечание владельца). */
const lowerLabel = (label) => label.charAt(0).toLowerCase() + label.slice(1);
const placeLabel = (label) => 'Место · ' + lowerLabel(label);

const fmtDiff = (d) => (d < 0 ? '−' : '+') + Math.abs(d).toFixed(4);

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
    v.textContent = verdictText(data, ds) + noneText(data);
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

/* Словами: «место 4» либо «верного документа в первой десятке нет». */
function placeWords(side) {
  if (!side) return NO_DETAIL;
  return side.rank === null ? 'верного документа в первой десятке нет' : 'место ' + side.rank;
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
    r.appendChild(el('span', 'rank-label', placeLabel((data[s] && data[s].label) || s)));
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
  const paths = Array.isArray(q.expected) ? q.expected : [];
  if (paths.length) {
    const exp = el('p', 'q-exp');
    exp.appendChild(el('span', 'lbl', 'Верный документ'));
    exp.appendChild(document.createTextNode(' '));
    paths.forEach((path, i) => {
      if (i) exp.appendChild(document.createTextNode(', '));
      exp.appendChild(fileLink(path));
    });
    body.appendChild(exp);
  }
  /* Ответа и подтверждения у вопроса может не быть: тогда раздела нет вовсе —
     подставлять заглушку нельзя (I-8). */
  if (typeof q.answer === 'string' && q.answer) {
    const ans = el('p', 'q-ans');
    ans.appendChild(el('span', 'lbl', 'Верный ответ'));
    ans.appendChild(document.createTextNode(' ' + q.answer));
    body.appendChild(ans);
  }
  if (typeof q.evidence === 'string' && q.evidence) {
    const ev = el('div', 'q-ev');
    ev.appendChild(el('span', 'lbl', 'Подтверждение из документа'));
    ev.appendChild(el('p', 'q-ev-text', '«' + q.evidence + '»'));
    if (typeof q.evidence_source === 'string' && q.evidence_source) {
      const src = el('p', 'q-ev-src');
      src.appendChild(fileLink(q.evidence_source));
      ev.appendChild(src);
    }
    body.appendChild(ev);
  }

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
    /* «место», а не «ранг»: одно слово на всю страницу — в сводке, в полосе
       заголовков и здесь (замечание владельца «что означают цифры?»). */
    col.appendChild(el('p', 'q-col-head', label + ' · ' + placeWords(side)));
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

function exampleText(list, data) {
  const differs = (q) => q.fixed && q.structural && q.fixed.rank !== q.structural.rank;
  const pick = list.find((q) => differs(q) && q.fixed.rank !== null && q.structural.rank !== null) ||
    list.find(differs);
  if (!pick) return '';
  const parts = SIDES.map((s) =>
    lowerLabel((data[s] && data[s].label) || s) + ' — ' + placeWords(pick[s]));
  return ' Например, у вопроса ' + (pick.id || '') + ': ' + parts.join(', ') + '.';
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
  $('q-example').textContent = exampleText(list, data);
  $('q-headbar').hidden = false;
  SIDES.forEach((s) => { $('hb-' + s).textContent = placeLabel((data[s] && data[s].label) || s); });
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
