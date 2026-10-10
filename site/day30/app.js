'use strict';
/* День 30: читает results.json, рисует доступ, таблицу параллельных запросов,
   таблицу ограничений и подвал.
   Раскладка и тексты — agent_docs/design/2026-10-09-1335-days26-30-local-llm-day-pages.md.
   Ни одного числа прогона в разметке нет (I-8); вывод дня, причина отказа и
   сводка по ограничениям считаются здесь по данным, и у них есть тест
   (test/day30-page-load.test.js).
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

/* Прогон записывает то, что увидел клиент, вместе с заголовком `retry-after`,
   а день 5 этого заголовка не отдаёт — в записи остаётся `None`, литерал
   Python. На странице его быть не должно: посетитель такого не видел
   (находка design-review к #344). Убирается именно этот фрагмент, а не всякое
   `None`: незнакомый текст доходит до экрана как есть. */
const NO_RETRY_AFTER = /,?\s*retry-after None/;
const clientSaw = (s) => (typeof s === 'string' && s
  ? s.replace(NO_RETRY_AFTER, '') : NO_DATA);

/* Оговорки прогона, которые страница уже говорит своими словами. Пара —
   начало оговорки и место, где сказано то же. Это названный список, а не
   разбор смысла: сравнивается начало строки, и закрытой считается только
   оговорка, прямо названная здесь. Незнакомая остаётся на экране — ошибка
   списка показывает лишнее, а не прячет нужное. Правка по существу — в
   прогоне (`rag/eval/to_page.py`): это он пишет в `notes` то, что страница
   печатает из своих полей; здесь — чтобы посетитель не читал одно и то же
   дважды (находка design-review к #344, образец — site/day28/app.js). */
const ALREADY_SAID = [
  ['Замер идёт на ноутбуке владельца', 'пояснение «Чего этот замер не мерил», пункт о потолке железа'],
  ['Отказ на параллельных запросах', 'строка под таблицей «Три запроса разом»'],
  ['Тексты ответов на эту страницу не идут', 'первый абзац страницы и границы меры'],
];
const saidOnPage = (n) => ALREADY_SAID.some((pair) => n.indexOf(pair[0]) === 0);

/* Имена ограничений прогон пишет длинными, и одна его запись несёт два
   ограничения сразу: потолок дня 5, у которого проба была, и потолок роутера
   в скобках, у которого её не было. Таблица обязана показать второй отдельной
   строкой со «не проверялось» — иначе границы меры обещают пометку, которой
   в таблице нет, — а имя строки не должно повторять колонку «Значение».
   Список адресует запись дословно, по полному имени, а не разбирает прозу:
   незнакомое имя проходит на экран как есть. Все числа дополнительных строк
   стоят внутри того же имени из `results.json` — это проверяет тест, и
   поэтому литералом на странице они не становятся (I-8). Правка по существу —
   в `rag/eval/day30_probe.py`, который эти имена пишет. */
const LIMIT_ROWS = [
  ['запусков в минуту на адрес — 5',
    [{ name: 'запусков в минуту на адрес' }]],
  ['длина темы в публичном API дня 5 — 60 знаков (maxRequestTokens 6000 снаружи недостижим)',
    [{ name: 'длина темы в публичном API дня 5' },
      { name: 'потолок размера запроса у роутера (maxRequestTokens)',
        value: '6000',
        fired: null,
        client_saw: 'ничего: день 5 отвергает длинную тему раньше, чем запрос ' +
          'дойдёт до роутера, и снаружи этот потолок недостижим' }]],
  ['окно контекста напрямую: num_ctx задан (2048)',
    [{ name: 'окно контекста напрямую: num_ctx задан' }]],
  ['окно контекста напрямую: num_ctx не задан',
    [{ name: 'окно контекста напрямую: num_ctx не задан' }]],
];

/* Запись прогона → строки таблицы. Первая строка пары наследует значение,
   «сработало» и «что увидел клиент» у записи; следующие — свои собственные,
   и без них строка не появляется. */
function limitRows(limits) {
  const out = [];
  limits.forEach((l) => {
    const hit = LIMIT_ROWS.find((pair) => pair[0] === l.name);
    if (!hit) { out.push(l); return; }
    hit[1].forEach((part, i) => {
      out.push({
        name: part.name,
        value: 'value' in part ? part.value : (i === 0 ? l.value : undefined),
        fired: 'fired' in part ? part.fired : (i === 0 ? l.fired : null),
        client_saw: 'client_saw' in part ? part.client_saw
          : (i === 0 ? l.client_saw : undefined),
      });
    });
  });
  return out;
}

/* ── Состояния ────────────────────────────────────────────────────────── */

/* Одно сообщение на экран, а не четыре одинаковых в четырёх `role="status"`:
   отсутствие файла — одна причина, и читать её четыре раза незачем. Блоки,
   которым нечего показать, просто скрыты (находка design-review к #344). */
function showMessage(text) {
  $('verdict').textContent = text;
  $('burst-tbl').hidden = true;
  $('acc-box').hidden = true;
  $('lim-tbl').hidden = true;
  $('lim-sum').textContent = '';
  ['run-notes-cap', 'run-notes', 'run-notes-dup'].forEach((id) => { $(id).hidden = true; });
  ['burst-status', 'acc-status', 'lim-status'].forEach((id) => {
    $(id).textContent = '';
    $(id).hidden = true;
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
    num(prod.requests) + ' одновременных запросов до модели дошло ' +
    num(prod.served) + refusedTail(prod) + '.'];
  if (direct) {
    parts.push('Напрямую в Ollama дошло ' + num(direct.served) + ' из ' +
      num(direct.requests) +
      (direct.refused === 0 ? ' — ни одного отказа' : refusedTail(direct)) +
      ', но очередью, за ' + num(direct.total_s, 1) + ' с.');
  } else {
    parts.push('Пробы напрямую в Ollama в прогоне нет: цену очереди сравнить не с чем.');
  }
  /* Та же развёртка строк, что в таблице: иначе вывод обещал бы «все
     проверены», а таблица показывала бы строку «не проверялось». */
  parts.push(limitsPhrase(limitRows(data.limits.filter((l) => !!l && typeof l === 'object'))));
  return parts.join(' ');
}

/* Причина отказа — дословно из записи прогона, а не постоянным текстом:
   своей формулировкой страница утверждала бы причину, которой отказавший
   путь не называл (находка design-review к #344). Причины нет в записи —
   страница говорит, что её нет, а не придумывает. */
function refusedTail(r) {
  if (typeof r.refused !== 'number' || r.refused < 1) return '';
  const head = ', отвергнуто ' + num(r.refused);
  return typeof r.reason === 'string' && r.reason
    ? head + ' с причиной «' + r.reason + '»'
    : head + '; причины в записи прогона нет';
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
  tr.appendChild(el('td', 'num', clientSaw(l.client_saw)));
  return tr;
}

/* ── Сборка ───────────────────────────────────────────────────────────── */

function render(data) {
  if (!valid(data)) { showMessage(ERROR_MSG); return; }
  const raw = data.burst.filter((r) => !!r && typeof r.path === 'string' && r.path);
  /* Публичный путь первым: им ведёт вывод дня, и порядок строк совпадает с
     порядком чтения (находка design-review к #344). */
  const burst = raw.filter(isProd).concat(raw.filter((r) => !isProd(r)));
  const limits = data.limits.filter((l) => !!l && typeof l === 'object' && l.name);
  if (!burst.length && !limits.length) { showMessage(EMPTY_MSG); return; }

  $('limit-repeats').textContent = String(data.repeats);

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

  /* Пустой таблицы с одними заголовками не бывает: нет строк — на её месте
     стоит причина словами, а не сетка без чисел. */
  if (burst.length) {
    const body = $('burst-body');
    burst.forEach((r) => body.appendChild(burstRow(r)));
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
    const rows = limitRows(limits);
    rows.forEach((l) => body.appendChild(limRow(l)));
    $('lim-sum').textContent = limitsPhrase(rows);
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
