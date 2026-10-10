'use strict';
/* День 29: читает results.json, рисует таблицу осей, таблицу «что это дало»,
   таблицу сжатия весов, строку правила выбора «после» и подвал.
   Раскладка и тексты — agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md.
   Ни одного числа прогона в разметке нет (I-8); вывод дня, порог шума, слова
   колонки «Разница», перечень осей, вошедших в «после», и фраза о числе
   изменённых осей считаются в verdict.js — у них есть тест. */

const DAY = 29;
const ERROR_MSG = 'Не удалось прочитать результаты прогона (results.json). ' +
  'Страница живёт по адресу challenge.zpq.ai/day29/; с диска она данных не покажет.';
const EMPTY_MSG = 'Прогон ещё не сделан. Числа появятся после первого полного прогона.';

/* Счёт и вердикт — в verdict.js (подключён раньше), чтобы у них был тест. */
const { NO_DATA, plural, num, signed, axisRows, suspectLine, changedLine, gainRows,
  afterRule, verdictText, quantRows, quantNames, stability, limitIdsLine } = globalThis.DAY29_VERDICT;

/* Оговорки прогона приходят из данных и местами повторяют то, что на странице
   уже сказано постоянным текстом: вторым списком под границами меры они
   читаются как новые сведения. Повторяющиеся снимаются по началу строки, а
   снятое называется числом — молчание выглядело бы как пропажа части файла.
   Правило fail-open: оговорка, не узнанная ни одной парой, остаётся на
   экране. Вторая колонка — где именно это сказано; она держит пару живой при
   правке текстов (её проверяет test/day29-page-load.test.js). */
const ALREADY_SAID = [
  ['Один прогон на ось, один повтор на вопрос', 'границы меры: повторы и шум'],
  ['Ось квантования сравнивает не только сжатие', 'абзац над таблицей сжатия весов'],
  ['Тексты ответов сборки без отказов не публикуются', 'строка под таблицей сжатия весов'],
  ['Замер на ноутбуке — не замер прода', 'границы меры: мерено на ноутбуке'],
  ['Пик RSS — сумма по всем процессам', 'пояснение «Как мерена память»'],
  ['Память по осям не мерена', 'границы меры: память по осям'],
  ['Три вопроса стабильности в этом прогоне не повторялись', 'границы меры и секция «Стабильность»'],
];
const saidOnPage = (n) => ALREADY_SAID.some((pair) => n.indexOf(pair[0]) === 0);

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

/* ── Состояния ────────────────────────────────────────────────────────── */

function showMessage(text) {
  $('verdict').textContent = text;
  $('rule-text').textContent = '';
  $('changed-line').textContent = '';
  $('stab-line').textContent = '';
  $('quant-names').textContent = '';
  ['gain-tbl', 'axes-tbl', 'quant-tbl'].forEach((id) => { $(id).hidden = true; });
  ['run-notes-cap', 'run-notes', 'run-notes-dup'].forEach((id) => { $(id).hidden = true; });
  ['axes-status', 'quant-status'].forEach((id) => {
    $(id).textContent = text;
    $(id).hidden = false;
  });
  /* Промпты — тоже данные прогона: без файла в них не остаётся «читаю…». */
  ['prompt-before', 'prompt-after'].forEach((id) => { $(id).textContent = NO_DATA; });
}

/* Свой день в файле сверяется: четыре одинаковых по форме файла в четырёх
   каталогах, и скопированный не туда показал бы чужие числа как свои. */
function valid(d) {
  return !!d && typeof d === 'object' && d.day === DAY &&
    typeof d.generated === 'string' && typeof d.host === 'string' &&
    typeof d.model === 'string' && typeof d.runner === 'string' &&
    typeof d.repeats === 'number' && Array.isArray(d.axes) &&
    !!d.base && typeof d.base === 'object';
}

/* ── Строки таблиц ───────────────────────────────────────────────────── */

/* Таблица с четырьмя столбцами «Метрика | До | После | Разница»: ею устроены
   и «что это дало», и сжатие весов. Знак и слово стоят вместе — знак не
   единственный носитель смысла. */
function pairRow(r) {
  const tr = document.createElement('tr');
  const th = el('th', null, r.name);
  th.scope = 'row';
  tr.appendChild(th);
  tr.appendChild(el('td', 'num', num(r.a, r.digits)));
  tr.appendChild(el('td', 'num', num(r.b, r.digits)));
  const diff = el('td', 'num', typeof r.d === 'number' ? signed(r.d, r.digits) : NO_DATA);
  if (typeof r.d === 'number') diff.appendChild(el('span', 'cell-sub', r.word));
  tr.appendChild(diff);
  return tr;
}

/* Ячейка значения оси: число (temperature, окно контекста, потолок ответа)
   или слово. Числа здесь сравнивают глазами по колонке — отсюда .num. Если у
   оси есть свой разбор, слово в ячейке становится ссылкой на него: двум
   абзацам промпта в ячейке делать нечего. */
function axisCell(text, anchor) {
  const td = el('td', 'num');
  if (!anchor) { td.textContent = text; return td; }
  const a = el('a', null, text);
  a.href = '#' + anchor;
  /* Повторный щелчок по той же ссылке hashchange не вызывает: без этого
     закрытый вручную блок второй раз не открылся бы. */
  a.addEventListener('click', () => setTimeout(openFromHash, 0));
  td.appendChild(a);
  return td;
}

function axisRow(r) {
  const tr = document.createElement('tr');
  const th = el('th', null, r.name);
  th.scope = 'row';
  tr.appendChild(th);
  tr.appendChild(axisCell(r.before, r.anchor));
  tr.appendChild(axisCell(r.after, r.anchor));
  tr.appendChild(el('td', 'num', r.score));
  /* «Нет данных» вместо испорченного счётчика — и рядом причина словом, а не
     одна пустота: почему числа нет, сказано в границах меры. */
  const tps = el('td', 'num', r.tps);
  if (r.suspect) tps.appendChild(el('span', 'cell-sub', 'счётчик испорчен'));
  tr.appendChild(tps);
  return tr;
}

/* ── Сборка ───────────────────────────────────────────────────────────── */

function render(data) {
  if (!valid(data)) { showMessage(ERROR_MSG); return; }
  const axes = data.axes.filter((a) => a && typeof a.name === 'string' && a.name);
  if (!axes.length) { showMessage(EMPTY_MSG); return; }

  $('limit-repeats').textContent = String(data.repeats);
  $('limit-ids').textContent = limitIdsLine(data);
  $('limit-judge').textContent = typeof data.judge === 'string' && data.judge
    ? data.judge : NO_DATA;
  const suspect = suspectLine(data);
  $('limit-suspect').textContent = suspect;
  $('limit-suspect').hidden = !suspect;

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
  const dup = notes.length - fresh.length;
  $('run-notes-dup').textContent = dup ? 'Ещё ' + dup + ' ' +
    plural(dup, 'оговорка прогона повторяет', 'оговорки прогона повторяют',
      'оговорок прогона повторяют') +
    ' сказанное выше — на экране они не продублированы.' : '';
  $('run-notes-dup').hidden = !dup;

  $('verdict').textContent = verdictText(data);

  const gainBody = $('gain-body');
  gainRows(data).forEach((r) => gainBody.appendChild(pairRow(r)));
  $('gain-tbl').hidden = false;

  const axesBody = $('axes-body');
  axisRows(data).forEach((r) => axesBody.appendChild(axisRow(r)));
  $('axes-tbl').hidden = false;
  $('axes-status').hidden = true;
  $('changed-line').textContent = changedLine(data);

  /* Правило выбора «после»: и результат, и причина по каждой оси. Фраза
     вычисляется — это место, где страница могла бы соврать молча. */
  const rule = afterRule(data);
  $('rule-text').textContent = rule.text;
  const ruleList = $('rule-list');
  rule.kept.concat(rule.rejected).forEach((a) => {
    ruleList.appendChild(el('li', null, a.name + ' — ' + a.why));
  });

  /* Сторона сжатия: только числа и имена. Ни ответа, ни промпта, ни слов
     судьи по сборке без отказов страница не показывает и в данных не ждёт. */
  if (data.quant && typeof data.quant === 'object') {
    const qBody = $('quant-body');
    quantRows(data).forEach((r) => qBody.appendChild(pairRow(r)));
    $('quant-tbl').hidden = false;
    $('quant-status').hidden = true;
    $('quant-names').textContent = quantNames(data)
      .map((s) => s.label + ' — ' + s.model + ' (' + s.note + ')').join('; ') + '.';
  } else {
    $('quant-tbl').hidden = true;
    $('quant-status').textContent = 'Оси сжатия весов в этом прогоне нет: сравнивать нечего.';
    $('quant-status').hidden = false;
  }

  $('stab-line').textContent = stability(data);

  const prompts = (data.prompts && typeof data.prompts === 'object') ? data.prompts : {};
  ['before', 'after'].forEach((key) => {
    const node = $('prompt-' + key);
    node.textContent = typeof prompts[key] === 'string' && prompts[key]
      ? prompts[key] : 'Шаблона в данных нет.';
  });

  $('run-line').textContent = 'Прогон ' + fmtRun(data.generated) + ' · ' + data.host +
    /* «Ollama {runner}» из шаблона здесь дало бы «Ollama ollama 0.33.3»: имя
       движка приходит в самом значении, и дублировать его незачем. */
    ' · модель ' + data.model + ' · движок ' + data.runner + ' · коммит ' +
    (typeof data.commit === 'string' && data.commit ? data.commit : NO_DATA) + '.';

  markScrollable();
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

/* Переход по ссылке из таблицы: блок раскрывается, фокус уходит на его
   summary — иначе клавиатурный посетитель стоит перед закрытым блоком. */
function openFromHash() {
  const id = decodeURIComponent((location.hash || '').slice(1));
  if (!id) return;
  const det = document.getElementById(id);
  if (!det || det.tagName !== 'DETAILS') return;
  det.open = true;
  markScrollable();
  const sum = det.querySelector('summary');
  if (sum) sum.focus();
}

/* Прокручиваемая область достижима с клавиатуры и получает подсказку только
   когда она реально переполнена: мёртвой остановки табуляции на широком
   экране не появляется. Переставляется на resize, а не один раз при загрузке.
   Промпты в <pre> — та же мера: длинная строка прокручивается сама. */
function markScrollable() {
  document.querySelectorAll('.tbl-scroll, .code').forEach((n) => {
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
/* Раскрытие details меняет ширину содержимого, а resize при этом не
   происходит: без этого у промпта в закрытом блоке не появилось бы ни
   подсказки, ни остановки табуляции. */
document.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', markScrollable));

fetch('results.json', { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(render)
  .catch(() => showMessage(ERROR_MSG));
