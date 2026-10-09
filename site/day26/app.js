'use strict';
/* День 26: читает results.json, рисует таблицы, разбор и подвал.
   Раскладка и тексты — agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md.
   Вывод дня, сводка под таблицей, диапазоны и слова про остановку считаются
   здесь: файл данных не может сказать «ответила верно», если числа говорят
   обратное. Ни одного числа прогона в разметке нет (I-8). */

const DAY = 26;
const ERROR_MSG = 'Не удалось прочитать результаты прогона (results.json). ' +
  'Страница живёт по адресу challenge.zpq.ai/day26/; с диска она данных не покажет.';
const EMPTY_MSG = 'Прогон ещё не сделан. Числа появятся после первого полного прогона.';
const PARTIAL_MSG = 'Вывод будет после полного прогона.';
const NO_DATA = 'нет данных';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* Десятичная запятая: страница русская, и числа в ней читают глазами. */
function num(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NO_DATA;
  return v.toFixed(digits).replace('.', ',');
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function fmtRun(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
}
/* Причина остановки словами: значение, отличное от обычного завершения, —
   это результат прогона, а не сбой страницы. */
function stopWords(reason) {
  if (reason === 'stop') return 'модель закончила сама';
  if (reason === 'length') return 'оборвано на потолке длины';
  if (typeof reason === 'string' && reason) return reason;
  return NO_DATA;
}
const hasNums = (p) => typeof p.ttft_answer_s === 'number' && typeof p.tps === 'number';

/* ── Состояния ────────────────────────────────────────────────────────── */

function showMessage(text) {
  const v = $('verdict');
  v.textContent = text;
  $('steps-tbl').hidden = true;
  $('access-tbl').hidden = true;
  $('bd-status').textContent = text;
  $('bd-status').hidden = false;
  $('acc-status').textContent = text;
  $('acc-status').hidden = false;
}

function valid(d) {
  return !!d && typeof d === 'object' && d.day === DAY &&
    typeof d.generated === 'string' && typeof d.host === 'string' &&
    typeof d.model === 'string' && typeof d.runner === 'string' &&
    typeof d.repeats === 'number' && Array.isArray(d.prompts);
}

/* ── Итог дня ─────────────────────────────────────────────────────────── */

function verdictText(rows) {
  const scored = rows.filter((p) => typeof p.verdict === 'string' && p.verdict);
  const timed = rows.filter(hasNums);
  /* Неполный прогон вывода не получает: средняя из того, что есть, обещала бы
     больше, чем измерено. Вместо вывода — что именно недостаёт. */
  if (scored.length < rows.length || timed.length < rows.length) {
    const gaps = [];
    if (scored.length < rows.length) {
      const n = rows.length - scored.length;
      gaps.push('без вердикта ' + n + ' ' + plural(n, 'строка', 'строки', 'строк'));
    }
    if (timed.length < rows.length) {
      const n = rows.length - timed.length;
      gaps.push('без чисел ' + n + ' ' + plural(n, 'строка', 'строки', 'строк'));
    }
    return PARTIAL_MSG + ' Измерено не всё: ' + gaps.join(', ') + ' из ' + rows.length + '.';
  }
  const ok = scored.filter((p) => p.verdict === 'верно');
  const off = scored.filter((p) => p.verdict !== 'верно');
  let t = 'Модель на ноутбуке ответила верно на ' + ok.length + ' ' +
    plural(ok.length, 'прогоне', 'прогонах', 'прогонах') + ' из ' + scored.length + '. ';
  if (off.length) {
    t += (off.length === 1 ? 'Единственная осечка — ' : 'Осечки — ') +
      off.map((p) => p.label + (p.mode ? ' (' + p.mode + ')' : '') + ': ' + p.verdict).join('; ') + '. ';
  }
  const ttft = timed.map((p) => p.ttft_answer_s), tps = timed.map((p) => p.tps);
  t += 'До первого токена ответа — от ' + num(Math.min.apply(null, ttft), 2) + ' до ' +
    num(Math.max.apply(null, ttft), 2) + ' с, скорость генерации — от ' +
    num(Math.min.apply(null, tps), 2) + ' до ' + num(Math.max.apply(null, tps), 2) + ' ток/с.';
  return t;
}

function stepsSummary(rows) {
  const scored = rows.filter((p) => typeof p.verdict === 'string' && p.verdict);
  const timed = rows.filter(hasNums);
  const parts = [];
  if (scored.length) {
    const ok = scored.filter((p) => p.verdict === 'верно').length;
    parts.push('Верных ' + ok + ' из ' + scored.length + ' ' +
      plural(scored.length, 'прогона', 'прогонов', 'прогонов') + ' по ' +
      new Set(rows.map((p) => p.label)).size + ' запросам');
  }
  if (timed.length) {
    const ttft = timed.map((p) => p.ttft_answer_s), tps = timed.map((p) => p.tps);
    parts.push('до первого токена ответа от ' + num(Math.min.apply(null, ttft), 2) + ' до ' +
      num(Math.max.apply(null, ttft), 2) + ' с, от ' + num(Math.min.apply(null, tps), 2) +
      ' до ' + num(Math.max.apply(null, tps), 2) + ' ток/с');
  }
  if (timed.length < rows.length) {
    parts.push('без чисел ' + (rows.length - timed.length) + ' ' +
      plural(rows.length - timed.length, 'строка', 'строки', 'строк'));
  }
  return parts.length ? parts.join('; ') + '. Диапазон, а не центр: ступени разной сложности центром не описываются.' : '';
}

function stepsRow(p) {
  const tr = document.createElement('tr');
  const th = el('th');
  th.scope = 'row';
  /* Ссылка ведёт на разбор: полный промпт в ячейку не влезает, а четыре
     колонки обязаны остаться целыми на 360 px. */
  const a = el('a', 'sum-label', p.label);
  a.href = '#' + p.id;
  /* Повторный щелчок по той же ссылке hashchange не вызывает: без этого
     закрытый вручную блок второй раз не открылся бы. */
  a.addEventListener('click', () => setTimeout(openFromHash, 0));
  th.appendChild(a);
  if (p.mode) th.appendChild(el('span', 'cell-sub', p.mode));
  tr.appendChild(th);

  const v = el('td', null, typeof p.verdict === 'string' && p.verdict ? p.verdict : NO_DATA);
  if (typeof p.scored_by === 'string' && p.scored_by) v.appendChild(el('span', 'cell-sub', p.scored_by));
  tr.appendChild(v);

  tr.appendChild(el('td', 'num', num(p.ttft_answer_s, 2)));
  tr.appendChild(el('td', 'num', num(p.tps, 2)));
  return tr;
}

/* ── Разбор по запросам ───────────────────────────────────────────────── */

function field(body, label, text, cls) {
  if (typeof text !== 'string' || !text) return;
  body.appendChild(el('span', 'lbl', label));
  body.appendChild(el('p', cls || 'answer', text));
}

function breakdownItem(p) {
  const li = document.createElement('li');
  const det = el('details', 'exp');
  det.id = p.id;
  const sum = el('summary');
  sum.appendChild(el('span', 'sum-label', p.label + (p.mode ? ' · ' + p.mode : '')));
  const right = el('span', 'sum-verdict',
    (typeof p.verdict === 'string' && p.verdict ? p.verdict : NO_DATA) +
    (p.scored_by ? ' · ' + p.scored_by : ''));
  sum.appendChild(right);
  const mark = el('span', 'q-mark');
  mark.setAttribute('aria-hidden', 'true');
  sum.appendChild(mark);
  det.appendChild(sum);

  const body = el('div', 'exp-body');
  field(body, 'Промпт', p.prompt);
  field(body, 'Эталон', p.expected);
  field(body, 'Ответ модели', p.answer);
  if (typeof p.reason === 'string' && p.reason) {
    body.appendChild(el('p', null, 'Почему ' +
      (typeof p.verdict === 'string' && p.verdict ? p.verdict : NO_DATA) + ': ' + p.reason));
  }
  const tok = (typeof p.prompt_tokens === 'number' ? p.prompt_tokens + ' ' +
    plural(p.prompt_tokens, 'токен', 'токена', 'токенов') : NO_DATA);
  const ans = (typeof p.answer_tokens === 'number' ? p.answer_tokens + ' ' +
    plural(p.answer_tokens, 'токен', 'токена', 'токенов') : NO_DATA);
  body.appendChild(el('p', 'small', 'Промпт — ' + tok + ', ответ — ' + ans +
    '. Остановка: ' + stopWords(p.done_reason) + '.' +
    (typeof p.series === 'string' && p.series ? ' Источник чисел: ' + p.series + '.' : '')));
  if (typeof p.note === 'string' && p.note) body.appendChild(el('p', 'small', p.note));
  det.appendChild(body);
  li.appendChild(det);
  return li;
}

/* Переход по ссылке из таблицы: блок раскрывается, фокус уходит на его
   summary — иначе клавиатурный посетитель стоит перед закрытым блоком. */
function openFromHash() {
  const id = decodeURIComponent((location.hash || '').slice(1));
  if (!id) return;
  const det = document.getElementById(id);
  if (!det || det.tagName !== 'DETAILS') return;
  det.open = true;
  const sum = det.querySelector('summary');
  if (sum) sum.focus();
}

/* ── Способы доступа ──────────────────────────────────────────────────── */

function accessRow(a) {
  const tr = document.createElement('tr');
  const th = el('th', null, a.label);
  th.scope = 'row';
  tr.appendChild(th);
  tr.appendChild(el('td', null, a.answer_ok === true ? 'верен'
    : a.answer_ok === false ? 'неверен' : NO_DATA));
  tr.appendChild(el('td', 'num', num(a.ttft_answer_s, 2)));
  tr.appendChild(el('td', null, a.engine_durations === true ? 'есть'
    : a.engine_durations === false ? 'нет' : NO_DATA));
  return tr;
}

function renderAccess(list) {
  if (!Array.isArray(list) || !list.length) {
    $('acc-status').textContent = 'Способы доступа в этом прогоне не мерены.';
    return;
  }
  const body = $('access-body');
  list.forEach((a) => body.appendChild(accessRow(a)));
  $('access-tbl').hidden = false;
  $('acc-status').hidden = true;

  const dflt = list.find((a) => /v1/.test(a.label) && typeof a.reasoning_chars === 'number' && a.reasoning_chars > 0);
  const none = list.find((a) => /v1/.test(a.label) && a.reasoning_chars === 0);
  if (dflt) {
    $('trap-ttft').textContent = num(dflt.ttft_s, 2);
    $('trap-ttft-answer').textContent = num(dflt.ttft_answer_s, 2);
    $('trap-usage').textContent = typeof dflt.answer_tokens === 'number' ? String(dflt.answer_tokens) : NO_DATA;
  }
  if (none) {
    $('trap-ttft-off').textContent = num(none.ttft_answer_s, 2);
    $('trap-visible').textContent = typeof none.answer_tokens === 'number' ? String(none.answer_tokens) : NO_DATA;
  }
}

/* ── Скорость против предсказуемости текста ───────────────────────────── */

function renderSpeed(s) {
  const box = $('svc-body');
  if (!s || !Array.isArray(s.cases) || !s.cases.length) {
    $('svc-note').textContent = 'Проверка в этом прогоне не делалась.';
    return;
  }
  s.cases.forEach((c) => {
    const tr = document.createElement('tr');
    const th = el('th', null, c.label);
    th.scope = 'row';
    tr.appendChild(th);
    tr.appendChild(el('td', 'num', num(c.tps, 2)));
    box.appendChild(tr);
  });
  const opts = s.options && typeof s.options === 'object'
    ? Object.keys(s.options).map((k) => k + ' ' + s.options[k]).join(', ') : NO_DATA;
  $('svc-note').textContent = 'Параметры: ' + opts + '. Источник чисел: ' +
    (typeof s.series === 'string' && s.series ? s.series : NO_DATA) +
    '. У предельно предсказуемого текста скорости нет данных: движок не вернул счётчик токенов.';
}

/* ── Сборка ───────────────────────────────────────────────────────────── */

function render(data) {
  if (!valid(data)) { showMessage(ERROR_MSG); return; }
  const rows = data.prompts.filter((p) => p && typeof p.id === 'string' && p.id);
  if (!rows.length) { showMessage(EMPTY_MSG); return; }

  $('limit-repeats').textContent = String(data.repeats);
  const opts = data.options && typeof data.options === 'object'
    ? Object.keys(data.options).map((k) => k + ' ' + data.options[k]).join(', ') +
      (typeof data.think === 'boolean' ? ', think ' + data.think : '')
    : NO_DATA;
  $('opts').textContent = opts;

  if (Array.isArray(data.notes) && data.notes.length) {
    const ul = $('run-notes');
    data.notes.forEach((n) => { if (typeof n === 'string' && n) ul.appendChild(el('li', null, n)); });
    ul.hidden = !ul.childElementCount;
  }

  const tbody = $('steps-body');
  rows.forEach((p) => tbody.appendChild(stepsRow(p)));
  $('steps-sum').textContent = stepsSummary(rows);
  $('steps-tbl').hidden = false;
  $('verdict').textContent = verdictText(rows);

  const bd = $('breakdown');
  rows.forEach((p) => bd.appendChild(breakdownItem(p)));
  $('bd-status').hidden = true;

  renderAccess(data.access);
  renderSpeed(data.speed_vs_content);

  $('run-line').textContent = 'Прогон ' + fmtRun(data.generated) + ' · ' + data.host +
    ' · модель ' + data.model + ' · Ollama ' + data.runner + ' · коммит ' +
    (typeof data.commit === 'string' && data.commit ? data.commit : NO_DATA) + '.';

  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

/* Прокручиваемая область достижима с клавиатуры только когда она реально
   переполнена: мёртвой остановки табуляции на широком экране не появляется.
   Переставляется на resize, а не один раз при загрузке. */
function markScrollable() {
  document.querySelectorAll('.call pre, .tbl-scroll').forEach((n) => {
    if (n.scrollWidth > n.clientWidth) n.setAttribute('tabindex', '0');
    else n.removeAttribute('tabindex');
  });
}
markScrollable();
window.addEventListener('resize', markScrollable);

fetch('results.json', { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch(() => showMessage(ERROR_MSG));
