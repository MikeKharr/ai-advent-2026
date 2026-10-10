'use strict';
/* День 30: читает results.json, рисует доступ, таблицу параллельных запросов,
   таблицу ограничений и подвал.
   Раскладка и тексты — agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md.
   Ни одного числа прогона в разметке нет (I-8); вывод дня и строка причин
   считаются здесь по данным, и у них есть тест (test/day30-page-load.test.js).
   Текстов ответов модели страница не получает вовсе: их нет в данных. */

const DAY = 30;
const NO_DATA = 'нет данных';
const ERROR_MSG = 'Не удалось прочитать результаты прогона (results.json). ' +
  'Страница живёт по адресу challenge.zpq.ai/day30/; с диска она данных не покажет.';
const EMPTY_MSG = 'Прогон ещё не сделан. Числа появятся после первого полного прогона.';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* Выдуманных нулей не бывает: не число — слово «нет данных», а не 0. */
function num(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NO_DATA;
  return v.toFixed(digits === undefined ? 0 : digits).replace('.', ',');
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
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
/* Третий случай — честный: «не проверялось» это не «нет» и не пустая ячейка.
   Защита без отрицательной пробы не проверена, и так она и помечается. */
function firedWord(v) {
  if (v === true) return 'да';
  if (v === false) return 'нет';
  return 'не проверялось';
}
const word = (v) => (typeof v === 'string' && v ? v : NO_DATA);

/* ── Состояния ────────────────────────────────────────────────────────── */

function showMessage(text) {
  $('verdict').textContent = text;
  $('burst-tbl').hidden = true;
  $('burst-reasons').textContent = '';
  $('acc-box').hidden = true;
  $('lim-tbl').hidden = true;
  $('lim-sum').textContent = '';
  ['burst-status', 'acc-status', 'lim-status'].forEach((id) => {
    $(id).textContent = text;
    $(id).hidden = false;
  });
}

function valid(d) {
  return !!d && typeof d === 'object' && d.day === DAY &&
    typeof d.generated === 'string' && typeof d.host === 'string' &&
    typeof d.model === 'string' && typeof d.runner === 'string' &&
    typeof d.repeats === 'number' &&
    Array.isArray(d.burst) && Array.isArray(d.limits) &&
    !!d.access && typeof d.access === 'object';
}

/* ── Вывод дня ────────────────────────────────────────────────────────── */
/* Считается здесь, а не читается из файла: иначе данные смогли бы сказать
   «сервис доступен» при числах, говорящих обратное. */

const isProd = (r) => !!r && typeof r.path === 'string' && /публичн/i.test(r.path);
const isDirect = (r) => !!r && typeof r.path === 'string' && /напрямую/i.test(r.path);

function limitsPhrase(limits) {
  const rows = limits.filter((l) => !!l && typeof l === 'object');
  if (!rows.length) return 'Ограничений в этом прогоне не проверялось ни одного.';
  const checked = rows.filter((l) => l.fired === true || l.fired === false);
  const fired = rows.filter((l) => l.fired === true);
  const tail = rows.length > checked.length
    ? ', ещё ' + (rows.length - checked.length) + ' не проверялось'
    : '';
  if (!checked.length) return 'Ни одно ограничение отрицательной пробой не проверено.';
  if (fired.length === checked.length) {
    return 'Все проверенные ограничения сработали: ' + fired.length + ' из ' +
      checked.length + tail + '.';
  }
  return 'Сработало ' + fired.length + ' ' +
    plural(fired.length, 'ограничение', 'ограничения', 'ограничений') + ' из ' +
    checked.length + ' проверенных' + tail + '.';
}

function verdictText(data) {
  const rows = data.burst.filter((r) => !!r && typeof r.path === 'string' && r.path);
  const prod = rows.find(isProd);
  const direct = rows.find(isDirect);
  /* Частичный результат: пробы через прод требуют включённой частной сети, и
     без неё они дают один ответ «провайдер недоступен», то есть не различают
     гипотез. Вывод в этом случае не считается вовсе. */
  if (!prod) {
    return 'Измерена одна сторона из двух: пробы через публичный адрес сайта в ' +
      'прогоне нет. Вывод будет после полного прогона.';
  }
  if (typeof prod.served !== 'number' || prod.served < 1) {
    return 'Через публичный адрес сайта до модели не дошёл ни один запрос: пока ' +
      'частная сеть на ноутбуке выключена, пробы этим путём дают один и тот же ' +
      'ответ «провайдер недоступен» и гипотез не различают. Вывод будет после ' +
      'полного прогона.';
  }
  /* Слова вокруг чисел подобраны так, чтобы фраза читалась при любых числах:
     «обслужен 1» и «обслужено 3» требуют разных форм, а «дошло N» — нет. */
  const parts = ['Сервис доступен снаружи: через публичный адрес сайта из ' +
    num(prod.requests) + ' одновременных запросов до модели дошло ' + num(prod.served) +
    (typeof prod.refused === 'number' && prod.refused > 0
      ? ', отвергнуто роутером ' + num(prod.refused) + ' — ёмкость локального ' +
        'провайдера занята первым запросом'
      : '') + '.'];
  if (direct) {
    parts.push('Напрямую в Ollama дошло ' + num(direct.served) + ' из ' +
      num(direct.requests) + (direct.refused === 0 ? ' — ни одного отказа' : '') +
      ', но очередью, за ' + num(direct.total_s, 1) + ' с.');
  } else {
    parts.push('Пробы напрямую в Ollama в прогоне нет: цену очереди сравнить не с чем.');
  }
  parts.push(limitsPhrase(data.limits));
  return parts.join(' ');
}

/* Причина отказа — дословно из тела ответа, по каждому пути, где отказ был.
   Без причины отказ читался бы как сбой, а он выбор конфигурации. */
function reasonsLine(data) {
  return data.burst
    .filter((r) => !!r && typeof r.refused === 'number' && r.refused > 0 &&
      typeof r.reason === 'string' && r.reason)
    .map((r) => 'Отказ на пути «' + r.path + '»: «' + r.reason + '».')
    .join(' ');
}

/* ── Таблицы ──────────────────────────────────────────────────────────── */

function burstRow(r) {
  const tr = document.createElement('tr');
  const th = el('th', null, r.path);
  th.scope = 'row';
  tr.appendChild(th);
  tr.appendChild(el('td', 'num', num(r.requests)));
  tr.appendChild(el('td', 'num', num(r.served)));
  tr.appendChild(el('td', 'num', num(r.refused)));
  tr.appendChild(el('td', 'num', num(r.total_s, 1)));
  return tr;
}

function limRow(l) {
  const tr = document.createElement('tr');
  const th = el('th', null, word(l.name));
  th.scope = 'row';
  tr.appendChild(th);
  tr.appendChild(el('td', 'num', word(l.value)));
  tr.appendChild(el('td', null, firedWord(l.fired)));
  tr.appendChild(el('td', 'num', word(l.client_saw)));
  return tr;
}

/* ── Сборка ───────────────────────────────────────────────────────────── */

function render(data) {
  if (!valid(data)) { showMessage(ERROR_MSG); return; }
  const burst = data.burst.filter((r) => !!r && typeof r.path === 'string' && r.path);
  const limits = data.limits.filter((l) => !!l && typeof l === 'object' && l.name);
  if (!burst.length && !limits.length) { showMessage(EMPTY_MSG); return; }

  $('limit-repeats').textContent = String(data.repeats);
  if (Array.isArray(data.notes) && data.notes.length) {
    const ul = $('run-notes');
    data.notes.forEach((n) => { if (typeof n === 'string' && n) ul.appendChild(el('li', null, n)); });
    ul.hidden = !ul.childElementCount;
  }

  $('verdict').textContent = verdictText(data);

  /* Пустой таблицы с одними заголовками не бывает: нет строк — на её месте
     стоит причина словами, а не сетка без чисел. */
  if (burst.length) {
    const body = $('burst-body');
    burst.forEach((r) => body.appendChild(burstRow(r)));
    $('burst-reasons').textContent = reasonsLine(data);
    $('burst-tbl').hidden = false;
    $('burst-status').hidden = true;
  } else {
    $('burst-tbl').hidden = true;
    $('burst-status').textContent = 'Проб с несколькими запросами разом в этом прогоне нет.';
    $('burst-status').hidden = false;
  }

  const acc = data.access;
  const accParts = [['acc-how', acc.how], ['acc-without', acc.without],
    ['acc-key', acc.where_key]];
  if (accParts.some(([, v]) => typeof v === 'string' && v)) {
    accParts.forEach(([id, v]) => { $(id).textContent = word(v); });
    $('acc-box').hidden = false;
    $('acc-status').hidden = true;
  } else {
    $('acc-box').hidden = true;
    $('acc-status').textContent = 'Описания доступа в этом прогоне нет.';
    $('acc-status').hidden = false;
  }

  if (limits.length) {
    const body = $('lim-body');
    limits.forEach((l) => body.appendChild(limRow(l)));
    $('lim-sum').textContent = limitsPhrase(limits);
    $('lim-tbl').hidden = false;
    $('lim-status').hidden = true;
  } else {
    $('lim-tbl').hidden = true;
    $('lim-status').textContent = 'Отрицательных проб по ограничениям в этом прогоне нет.';
    $('lim-status').hidden = false;
  }

  $('run-line').textContent = 'Прогон ' + fmtRun(data.generated) + ' · ' + data.host +
    /* «Ollama {runner}» из шаблона здесь дало бы «Ollama ollama 0.33.3»: имя
       движка приходит в самом значении, и дублировать его незачем. */
    ' · модель ' + data.model + ' · движок ' + data.runner + ' · коммит ' +
    (typeof data.commit === 'string' && data.commit ? data.commit : NO_DATA) + '.';

  markScrollable();
}

/* Прокручиваемая область достижима с клавиатуры и получает подсказку только
   когда она реально переполнена: мёртвой остановки табуляции на широком
   экране не появляется. Переставляется на resize, а не один раз при загрузке. */
function markScrollable() {
  document.querySelectorAll('.tbl-scroll, .code pre').forEach((n) => {
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
