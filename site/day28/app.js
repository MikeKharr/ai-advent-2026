'use strict';
/* День 28: читает results.json, рисует таблицы, стабильность, разбор и подвал.
   Раскладка и тексты — agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md.
   Ни одного числа прогона в разметке нет (I-8); вывод дня, порог шума, слова
   колонки «Разница», отбор вопросов с совпавшим поиском и строка стабильности
   считаются в verdict.js — у них есть тест. */

const DAY = 28;
const ERROR_MSG = 'Не удалось прочитать результаты прогона (results.json). ' +
  'Страница живёт по адресу challenge.zpq.ai/day28/; с диска она данных не покажет.';
const EMPTY_MSG = 'Прогон ещё не сделан. Числа появятся после первого полного прогона.';

/* Счёт и вердикт — в verdict.js (подключён раньше), чтобы у них был тест. */
const { NO_DATA, plural, num, signed, counts, summaryRows, verdictText, matchLine,
  stability } = globalThis.DAY28_VERDICT;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function fmtRun(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
}
/* Причина остановки словами: значение, отличное от обычного завершения, —
   это результат прогона, а не сбой страницы. Незаписанная причина — «нет
   данных», а не «модель закончила сама». */
function stopWords(reason) {
  if (reason === 'stop') return 'модель закончила сама';
  if (reason === 'length') return 'оборвано на потолке длины';
  if (typeof reason === 'string' && reason) return reason;
  return NO_DATA;
}
/* Совпадение поиска. Третий случай — не пустая ячейка и не «нет»: у общего
   вопроса верного документа в проекте не существует, и совпадать нечему. */
function matchWord(v) {
  if (v === true) return 'да';
  if (v === false) return 'нет';
  return 'документа нет';
}
const word = (v) => (typeof v === 'string' && v ? v : NO_DATA);

/* Оговорки прогона, которые страница говорит сама, и место, где она их
   говорит. Это названный список, а не разбор смысла: сравнивается начало
   строки, и закрытой считается только оговорка, прямо названная здесь.
   Незнакомая остаётся на экране — ошибка списка показывает лишнее, а не
   прячет нужное. Правка по существу — в прогоне (`rag/eval/to_page.py`): это
   он пишет в `notes` то, что страница уже печатает из полей; здесь — чтобы
   посетитель не читал одно и то же дважды (находка design-review). */
const ALREADY_SAID = [
  ['Один повтор на вопрос', 'границы меры: повторы и три вопроса стабильности'],
  ['Индексы двух сторон разные', 'границы меры: индексы сторон разные'],
  ['Судья — модель', 'границы меры: судья и отсутствие статистики'],
  ['Время облачной стороны не измерено', 'строка под таблицей «По вопросам» и «Чего этот замер не мерил»'],
  ['Выдачи поиска облачной стороны в файле нет', 'пояснение «Что именно сравнивалось»'],
  ['«Поиск совпал» означает', 'пояснение «Что именно сравнивалось»'],
  ['Признаки «путь назван»', 'пояснение «Как мерено качество»'],
];
const saidOnPage = (n) => ALREADY_SAID.some((pair) => n.indexOf(pair[0]) === 0);

/* ── Состояния ────────────────────────────────────────────────────────── */

function showMessage(text) {
  $('verdict').textContent = text;
  $('match-line').textContent = '';
  $('cmp-tbl').hidden = true;
  $('q-tbl').hidden = true;
  $('stab-tbl').hidden = true;
  $('stab-line').textContent = '';
  ['run-notes-cap', 'run-notes', 'run-notes-dup'].forEach((id) => { $(id).hidden = true; });
  ['q-status', 'stab-status', 'bd-status'].forEach((id) => {
    $(id).textContent = text;
    $(id).hidden = false;
  });
}

function valid(d) {
  return !!d && typeof d === 'object' && d.day === DAY &&
    typeof d.generated === 'string' && typeof d.host === 'string' &&
    typeof d.model === 'string' && typeof d.runner === 'string' &&
    typeof d.repeats === 'number' && Array.isArray(d.questions) &&
    !!d.summary && typeof d.summary === 'object';
}

/* ── Итог сравнения ───────────────────────────────────────────────────── */

function cmpRow(r) {
  const tr = document.createElement('tr');
  const th = el('th', null, r.name);
  th.scope = 'row';
  tr.appendChild(th);
  tr.appendChild(el('td', 'num', num(r.a, r.digits)));
  tr.appendChild(el('td', 'num', num(r.b, r.digits)));
  /* Знак и слово вместе: знак не единственный носитель смысла. Разницы нет —
     нет и слова: «нет данных» дважды в одной ячейке ничего не добавляет. */
  const diff = el('td', 'num', typeof r.d === 'number' ? signed(r.d, r.digits) : NO_DATA);
  if (typeof r.d === 'number') diff.appendChild(el('span', 'cell-sub', r.word));
  tr.appendChild(diff);
  return tr;
}

/* ── По вопросам ──────────────────────────────────────────────────────── */

function qRow(q) {
  const tr = document.createElement('tr');
  const th = el('th');
  th.scope = 'row';
  /* Ссылка ведёт на разбор: текст вопроса целиком в ячейку шести колонок не
     влезает, а разбор обязан быть достижим с клавиатуры. */
  const a = el('a', 'sum-label', q.id);
  a.href = '#' + q.id;
  /* Повторный щелчок по той же ссылке hashchange не вызывает: без этого
     закрытый вручную блок второй раз не открылся бы. */
  a.addEventListener('click', () => setTimeout(openFromHash, 0));
  th.appendChild(a);
  tr.appendChild(th);
  tr.appendChild(el('td', null, word(q.local && q.local.verdict)));
  tr.appendChild(el('td', null, word(q.cloud && q.cloud.verdict)));
  tr.appendChild(el('td', 'num', num(q.local && q.local.time_s, 1)));
  tr.appendChild(el('td', 'num', num(q.cloud && q.cloud.time_s, 1)));
  tr.appendChild(el('td', null, matchWord(q.retrieved_match)));
  return tr;
}

function qSummary(data) {
  const c = counts(data.questions);
  const parts = [];
  if (c.nodoc) {
    parts.push('«Документа нет» — общий вопрос: верного документа в проекте не ' +
      'существует, и совпадать нечему; в вывод дня такой вопрос не входит');
  }
  const noTime = data.questions.filter((q) => q && q.cloud && typeof q.cloud.time_s !== 'number').length;
  if (noTime) {
    parts.push('Время облачной стороны не измерено у ' + noTime + ' ' +
      plural(noTime, 'вопроса', 'вопросов', 'вопросов') +
      ': прогон дня 22 его не записывает, и нуля вместо него тут нет');
  }
  return parts.length ? parts.join('. ') + '.' : '';
}

/* ── Стабильность ─────────────────────────────────────────────────────── */

function stabRow(r) {
  const tr = document.createElement('tr');
  const th = el('th');
  th.scope = 'row';
  const a = el('a', 'sum-label', r.id);
  a.href = '#' + r.id;
  a.addEventListener('click', () => setTimeout(openFromHash, 0));
  th.appendChild(a);
  tr.appendChild(th);
  /* Три слова через запятую, а не счёт: видно, разошлись они или нет. */
  tr.appendChild(el('td', null, r.verdicts.join(', ')));
  tr.appendChild(el('td', 'num', r.times.join(', ')));
  tr.appendChild(el('td', 'num', r.cuts));
  return tr;
}

/* ── Разбор по вопросам ───────────────────────────────────────────────── */

function field(body, label, text, cls) {
  if (typeof text !== 'string' || !text) return;
  body.appendChild(el('span', 'lbl', label));
  body.appendChild(el('p', cls || 'answer', text));
}

function sideBlock(body, side, title) {
  body.appendChild(el('span', 'lbl', title));
  if (!side || typeof side !== 'object') {
    body.appendChild(el('p', 'small', 'Этой стороны в прогоне нет.'));
    return;
  }
  body.appendChild(el('p', 'answer', typeof side.answer === 'string' && side.answer
    ? side.answer : 'Ответа в данных нет.'));
  const sources = Array.isArray(side.sources) ? side.sources : [];
  if (sources.length) {
    const ul = el('ul', 'srcs');
    sources.forEach((s) => {
      const li = document.createElement('li');
      li.appendChild(el('span', null, (s && s.path) || NO_DATA));
      if (s && typeof s.section === 'string' && s.section) {
        li.appendChild(el('span', 'sec', ' · ' + s.section));
      }
      ul.appendChild(li);
    });
    body.appendChild(ul);
  } else {
    body.appendChild(el('p', 'small', 'Найденных фрагментов в данных нет: прогон этой ' +
      'стороны записывает ответ и признаки, а не список путей.'));
  }
  const bits = ['оценка судьи — ' + word(side.verdict) +
    (typeof side.score === 'number' ? ' (' + side.score + ' из 2)' : ' (' + NO_DATA + ')')];
  bits.push(side.refused === true ? 'модель отвечать отказалась'
    : side.refused === false ? 'отказа не было' : 'про отказ в данных нет записи');
  if (typeof side.time_s === 'number') bits.push('полное время ' + num(side.time_s, 2) + ' с');
  body.appendChild(el('p', 'small', bits.join('; ') + '.'));
  if (typeof side.judge_note === 'string' && side.judge_note) {
    body.appendChild(el('p', 'small', 'Судья: ' + side.judge_note));
  }
}

function breakdownItem(q) {
  const li = document.createElement('li');
  const det = el('details', 'exp');
  det.id = q.id;
  const sum = el('summary');
  sum.appendChild(el('span', 'sum-label', q.id + ' · ' +
    (typeof q.text === 'string' && q.text ? q.text : NO_DATA)));
  sum.appendChild(el('span', 'sum-verdict',
    'лок. ' + word(q.local && q.local.verdict) + ' · обл. ' + word(q.cloud && q.cloud.verdict)));
  const mark = el('span', 'q-mark');
  mark.setAttribute('aria-hidden', 'true');
  sum.appendChild(mark);
  det.appendChild(sum);

  const body = el('div', 'exp-body');
  body.appendChild(el('p', 'small', 'Поиск совпал: ' + matchWord(q.retrieved_match) + '.'));
  sideBlock(body, q.local, 'Локально: ответ и фрагменты');
  sideBlock(body, q.cloud, 'В облаке: ответ и фрагменты');
  const runs = q.local && Array.isArray(q.local.runs) ? q.local.runs : [];
  if (runs.length) {
    body.appendChild(el('span', 'lbl', 'Три прогона локальной стороны'));
    const ul = el('ul', 'srcs');
    runs.forEach((r, i) => {
      ul.appendChild(el('li', null, 'Прогон ' + (i + 1) + ': ' + word(r && r.verdict) +
        ', ' + num(r && r.time_s, 2) + ' с, остановка — ' + stopWords(r && r.done_reason)));
    });
    body.appendChild(ul);
  }
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

/* ── Сборка ───────────────────────────────────────────────────────────── */

function render(data) {
  if (!valid(data)) { showMessage(ERROR_MSG); return; }
  const rows = data.questions.filter((q) => q && typeof q.id === 'string' && q.id);
  if (!rows.length) { showMessage(EMPTY_MSG); return; }

  $('limit-repeats').textContent = String(data.repeats);
  $('limit-ids').textContent = Array.isArray(data.stability_ids) && data.stability_ids.length
    ? data.stability_ids.join(', ') : NO_DATA;
  $('limit-judge').textContent = typeof data.judge === 'string' && data.judge
    ? data.judge : NO_DATA;

  /* Оговорки прогона стоят под своей подписью, а не вторым безымянным списком
     под постоянными границами меры: иначе на экране они неотличимы. */
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((n) => typeof n === 'string' && n) : [];
  const fresh = notes.filter((n) => !saidOnPage(n));
  const ul = $('run-notes');
  fresh.forEach((n) => ul.appendChild(el('li', null, n)));
  /* Видимость ставится обеими ветвями, а не только положительной: иначе она
     держится атрибутом в разметке, и состояние блока нельзя проверить. */
  ul.hidden = !fresh.length;
  $('run-notes-cap').hidden = !fresh.length;
  /* Снятое с экрана названо числом: промолчать значило бы, что часть файла
     данных исчезла со страницы незаметно. */
  const dup = notes.length - fresh.length;
  $('run-notes-dup').textContent = dup ? 'Ещё ' + dup + ' ' +
    plural(dup, 'оговорка прогона повторяет', 'оговорки прогона повторяют',
      'оговорок прогона повторяют') +
    ' сказанное выше — на экране они не продублированы.' : '';
  $('run-notes-dup').hidden = !dup;

  $('verdict').textContent = verdictText(data);
  $('match-line').textContent = matchLine(data);

  const cmp = summaryRows(data);
  const cmpBody = $('cmp-body');
  cmp.forEach((r) => cmpBody.appendChild(cmpRow(r)));
  $('cmp-tbl').hidden = false;

  const qBody = $('q-body');
  rows.forEach((q) => qBody.appendChild(qRow(q)));
  $('q-sum').textContent = qSummary(data);
  $('q-tbl').hidden = false;
  $('q-status').hidden = true;

  /* Пустой таблицы с одними заголовками не бывает: без повторов секция
     говорит это словами, а таблица не показывается вовсе. */
  const st = stability(data);
  $('stab-line').textContent = st.text;
  if (st.rows.length) {
    const stBody = $('stab-body');
    st.rows.forEach((r) => stBody.appendChild(stabRow(r)));
    $('stab-tbl').hidden = false;
    $('stab-status').hidden = true;
  } else {
    $('stab-tbl').hidden = true;
    $('stab-status').hidden = true;
  }

  const bd = $('breakdown');
  rows.forEach((q) => bd.appendChild(breakdownItem(q)));
  $('bd-status').hidden = true;

  $('run-line').textContent = 'Прогон ' + fmtRun(data.generated) + ' · ' + data.host +
    /* «Ollama {runner}» из шаблона здесь дало бы «Ollama ollama 0.33.3»: имя
       движка приходит в самом значении, и дублировать его незачем. */
    ' · модель ' + data.model + ' · движок ' + data.runner + ' · коммит ' +
    (typeof data.commit === 'string' && data.commit ? data.commit : NO_DATA) + '.';

  markScrollable();
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

/* Прокручиваемая область достижима с клавиатуры и получает подсказку только
   когда она реально переполнена: мёртвой остановки табуляции на широком
   экране не появляется. Переставляется на resize, а не один раз при загрузке. */
function markScrollable() {
  document.querySelectorAll('.tbl-scroll').forEach((n) => {
    const over = n.scrollWidth > n.clientWidth;
    if (over) n.setAttribute('tabindex', '0');
    else n.removeAttribute('tabindex');
    const fig = n.parentNode;
    const hint = fig && fig.querySelector ? fig.querySelector('.tbl-hint') : null;
    if (hint) hint.hidden = !over;
  });
}
markScrollable();
window.addEventListener('resize', markScrollable);

fetch('results.json', { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch(() => showMessage(ERROR_MSG));
