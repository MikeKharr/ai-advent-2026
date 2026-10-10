// Вердикт страницы дня 29 — чистые функции без DOM. Подключается обычным
// скриптом перед app.js, тест test/day29-verdict.test.js — импортом в Node.
// Вынесено, чтобы у счёта был держатель: вывод дня, порог шума, слова колонки
// «Разница», перечень осей, вошедших в «после», и фраза о числе изменённых
// осей считаются здесь, а не читаются из данных (спецификация дней 26–30,
// «Что страница считает сама и чего в файле нет»).
//
// Обёртка — функция, а НЕ голый блок `{ … }`: в нестрогом скрипте объявления
// функций внутри блока по Annex B утекают в глобальную область, и
// `const { plural, … } = globalThis.DAY29_VERDICT` в app.js падает с
// SyntaxError — страница тогда вечно «читает результаты» (находка
// design-review к #295). В Node Annex B не действует, поэтому это держит
// test/day29-page-load.test.js, а не тест вердикта.
(function () {
const NO_DATA = 'нет данных';
const PARTIAL_MSG = 'Вывод будет после полного прогона.';

/* Ось, у которой счётчики скорости прогона испорчены: токены в секунду и
   время до первого токена у неё несопоставимы с соседними осями (у части
   ответов счётчик дал десятые доли токена в секунду и треть секунды до
   первого токена при пяти тысячах токенов промпта на той же машине). Такие
   числа на странице не показываются как результат: в колонке стоит «нет
   данных», причина — в границах меры. Полное время ответов этой оси прогон
   записал верно, но по осям его в файле нет вовсе, и показывать нечего.

   Ось названа строкой из данных, а не угадана порогом: порог, подогнанный
   под один прогон, молча перестал бы ловить. test/day29-verdict.test.js
   проверяет, что названная ось в results.json всё ещё есть, — переименуют
   её, и красным станет тест, а не страница. */
const SPEED_SUSPECT = {
  'temperature 1 → 0,2':
    'счётчики скорости у этой оси испорчены: у части ответов прогон записал '
    + 'десятые доли токена в секунду и треть секунды до первого токена',
};
const isSuspect = (name) => Object.prototype.hasOwnProperty.call(SPEED_SUSPECT, name);

/* Ось, которая не входит в «после» ни при каких числах: «после» — это
   конфигурация той модели, что стоит в проде, а сборка без отказов в проде
   не стоит (ADR недели, п. 4.5). Опознаётся по названию оси: отдельного
   признака «сборка без отказов» в данных нет, и выводить его из чисел
   значило бы угадывать. */
const QUANT_AXIS = /квантование/i;

/* Ось, у которой на странице есть свой разбор: слово в её ячейках становится
   ссылкой туда. Сегодня такая одна — промпт-шаблон, и два его абзаца в ячейке
   таблицы нечитаемы. Якорь — id раскрывающегося блока в разметке. */
const AXIS_ANCHOR = [[/промпт/i, 'prompts']];
function axisAnchor(name) {
  const hit = AXIS_ANCHOR.find((pair) => pair[0].test(name));
  return hit ? hit[1] : null;
}

/* Склонение после числа: 1 ось, 2 оси, 5 осей. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
}
/* Десятичная запятая: страница русская, и числа в ней читают глазами. */
function num(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NO_DATA;
  return v.toFixed(digits).replace('.', ',');
}
/* Знак — не единственный носитель смысла, но он нужен: рядом всегда стоит
   слово (см. diffWord). Минус — типографский, как в спецификации. */
function signed(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NO_DATA;
  if (Math.abs(v) < Math.pow(10, -digits) / 2) return num(0, digits);
  return (v > 0 ? '+' : '−') + num(Math.abs(v), digits);
}
/* Доля в процентах — только когда есть от чего считать. */
function pct(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || !from) return null;
  return (to - from) / Math.abs(from) * 100;
}
/* Порог шума — два вопроса из набора, а не константа: правило владельца
   «разница в один-два вопроса — шум» в единицах рубрики 0/1/2. */
function noise(n) {
  return n > 0 ? 2 / n : null;
}
/* Слово к знаку в колонке «Разница». Равенство называется равенством, а не
   «шумом»: шум — это про неразличимость, а не про совпадение. */
function diffWord(d, noiseVal, higher, lower) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return NO_DATA;
  if (d === 0) return 'столько же';
  if (typeof noiseVal === 'number' && Math.abs(d) <= noiseVal) return 'в пределах шума';
  return d > 0 ? higher : lower;
}
const word = (v) => (typeof v === 'string' && v ? v : NO_DATA);
/* Значение оси «до»/«после»: число, слово или ничего. Нуля вместо
   отсутствующего значения не бывает (I-8). */
function axisValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return num(v, v % 1 ? 1 : 0);
  return word(typeof v === 'string' ? v : null);
}

const axesOf = (data) => (Array.isArray(data && data.axes) ? data.axes.filter(Boolean) : []);

/* ── Таблица «Оси» ──────────────────────────────────────────────────────
   Ток/с у подозрительной оси — «нет данных», а не её испорченное среднее. */
function axisRows(data) {
  return axesOf(data).map((a) => ({
    name: word(a.name),
    before: axisValue(a.before),
    after: axisValue(a.after),
    score: num(a.score_avg, 2),
    tps: isSuspect(a.name) ? NO_DATA : num(a.tps, 2),
    suspect: isSuspect(a.name),
    anchor: axisAnchor(word(a.name)),
  }));
}

/* Строка о испорченных счётчиках — на виду, в границах меры: показать «нет
   данных» и не сказать почему значило бы спрятать причину. */
function suspectLine(data) {
  const bad = axesOf(data).filter((a) => isSuspect(a.name));
  if (!bad.length) return '';
  return bad.map((a) => 'Ось «' + word(a.name) + '»: ' + SPEED_SUSPECT[a.name]).join('; ')
    + '. Ток/с и время до первого токена по ней — «нет данных»; на остальные оси это не '
    + 'переносится.';
}

/* Фраза о числе изменённых осей. Это место, где страница может соврать
   молча, и потому она вычисляется, а не пишется руками. */
function changedLine(data) {
  const axes = axesOf(data);
  if (!axes.length) return '';
  const many = axes.filter((a) => typeof a.changed === 'number' && a.changed > 1);
  if (!many.length) {
    return 'В каждом прогоне менялась одна ось: выигрыш и проигрыш числа принадлежат ей.';
  }
  return many.map((a) => 'У оси «' + word(a.name) + '» менялось ' + a.changed + ' '
    + plural(a.changed, 'ось', 'оси', 'осей') + ' разом: какой из них принадлежит '
    + 'выигрыш, этот замер не говорит').join('; ') + '.';
}

/* ── Таблица «Что это дало» ─────────────────────────────────────────────
   Значения — из данных, знак и слово — здесь. Строки, которых прогон не
   записал, из таблицы не убираются: «нет данных» в них — тоже результат. */
function gainRows(data) {
  const b = (data && data.base) || {}, a = (data && data.after) || {};
  const nzScore = noise(typeof b.answers === 'number' ? b.answers : 0);
  const pair = (key) => {
    const x = b[key], y = a[key];
    return { a: x, b: y, d: typeof x === 'number' && typeof y === 'number' ? y - x : null };
  };
  const rows = [];
  const s = pair('score_avg');
  rows.push({ name: 'Оценка судьи, 0–2', digits: 2, ...s,
    word: diffWord(s.d, nzScore, 'выше после', 'ниже после') });
  const t = pair('time_s_mean');
  rows.push({ name: 'Полное время ответа, с (среднее по разным вопросам)', digits: 1, ...t,
    word: diffWord(t.d, null, 'дольше после', 'быстрее после') });
  [['retrieved', 'Ответов с найденным верным документом'],
    ['cited', 'Ответов со ссылкой на источник'],
    ['refused', 'Отказов отвечать']].forEach(([key, name]) => {
    const p = pair(key);
    rows.push({ name: name, digits: 0, ...p,
      word: diffWord(p.d, 2, 'больше после', 'меньше после') });
  });
  /* Скорость и память по конфигурациям «до» и «после» прогон в файл страницы
     не положил. Строки остаются: их отсутствие читалось бы как «не важно». */
  [['Ток/с', 2], ['До 1-го токена, с', 2], ['Память, МиБ', 0]].forEach(([name, digits]) => {
    rows.push({ name: name, digits: digits, a: null, b: null, d: null, word: NO_DATA });
  });
  return rows;
}

/* ── Правило выбора «после» ─────────────────────────────────────────────
   Берутся оси, у которых оценка не упала, а время выросло в пользу ответа
   (ADR недели, п. 4.5). Сборка без отказов не входит ни при каких числах.
   Выигрыш во времени считается по ток/с против базы — и вот тут у этих
   данных предел: ток/с базовой конфигурации прогон в файл не положил, так
   что подтвердить выигрыш нечем. Функция это говорит, а не делает вид, что
   правило применилось. */
function afterRule(data) {
  const axes = axesOf(data);
  const base = (data && data.base) || {};
  const baseScore = typeof base.score_avg === 'number' ? base.score_avg : null;
  const baseTps = typeof base.tps === 'number' ? base.tps : null;
  const kept = [], rejected = [];
  axes.forEach((a) => {
    const name = word(a.name);
    if (QUANT_AXIS.test(name)) {
      rejected.push({ name: name, why: 'сборка без отказов не входит в «после» ни при каких числах' });
      return;
    }
    if (typeof a.score_avg !== 'number') {
      rejected.push({ name: name, why: 'оценки по этой оси в данных нет' });
      return;
    }
    if (baseScore === null) {
      rejected.push({ name: name, why: 'оценки базовой конфигурации в данных нет' });
      return;
    }
    if (a.score_avg < baseScore) {
      rejected.push({ name: name, why: 'оценка ниже базовой (' + num(a.score_avg, 2)
        + ' против ' + num(baseScore, 2) + ')' });
      return;
    }
    const tps = isSuspect(name) ? null : (typeof a.tps === 'number' ? a.tps : null);
    if (baseTps === null || tps === null) {
      rejected.push({ name: name, why: 'выигрыш во времени по числам файла не подтверждён: '
        + (tps === null ? 'ток/с этой оси нет' : 'ток/с базовой конфигурации нет') });
      return;
    }
    if (tps <= baseTps) {
      rejected.push({ name: name, why: 'быстрее базы не стало (' + num(tps, 2)
        + ' против ' + num(baseTps, 2) + ' ток/с)' });
      return;
    }
    kept.push({ name: name, why: 'оценка не ниже базовой и ответ быстрее' });
  });
  const text = kept.length
    ? 'В «после» вошли ' + kept.length + ' ' + plural(kept.length, 'ось', 'оси', 'осей')
      + ': ' + kept.map((k) => '«' + k.name + '»').join(', ') + '.'
    : axes.length
      ? 'В «после» не вошла ни одна ось: «после» — повторный прогон базовой конфигурации, '
        + 'а не её улучшение.'
      : 'Осей в прогоне нет: выбирать не из чего.';
  return { kept: kept, rejected: rejected, text: text };
}

/* ── Вывод дня ──────────────────────────────────────────────────────────
   Три случая, и третий обязателен: метрики могут расходиться. Разница
   оценки меряется против порога шума 2/N, у времени порога шума нет, и это
   сказано словом, а не сглажено. */
function verdictText(data) {
  const b = (data && data.base) || {}, a = (data && data.after) || {};
  const haveB = typeof b.score_avg === 'number', haveA = typeof a.score_avg === 'number';
  if (!haveB || !haveA) {
    const have = haveB ? '«до»' : haveA ? '«после»' : null;
    return have
      ? 'Сравнивать нечего: измерена одна сторона из двух — ' + have + '. ' + PARTIAL_MSG
      : 'Сравнивать нечего: ни «до», ни «после» в прогоне нет. ' + PARTIAL_MSG;
  }
  const n = typeof b.answers === 'number' ? b.answers : 0;
  const nz = noise(n);
  const d = a.score_avg - b.score_avg;
  const t = typeof b.time_s_mean === 'number' && typeof a.time_s_mean === 'number'
    ? { d: a.time_s_mean - b.time_s_mean, p: pct(b.time_s_mean, a.time_s_mean) } : null;
  const basis = ' Считано по ' + n + ' ' + plural(n, 'вопросу', 'вопросам', 'вопросам')
    + ': ' + num(b.score_avg, 2) + ' против ' + num(a.score_avg, 2)
    + ' по рубрике 0/1/2, порог шума — два вопроса из ' + n
    + (typeof nz === 'number' ? ' (' + num(nz, 2) + ')' : '') + '.';
  const speed = t
    ? ' Полное время — ' + num(b.time_s_mean, 1) + ' с против ' + num(a.time_s_mean, 1)
      + ' с в среднем по разным вопросам (' + signed(t.p, 0) + ' %); порога шума у времени нет.'
    : ' Время сторон не сравнивается: в данных его нет.';
  /* Если правило не взяло ни одной оси, «до» и «после» — два прогона одной и
     той же конфигурации, и всякая разница между ними — цена повтора. Молчать
     об этом нельзя: иначе страница выдаёт повтор за результат оптимизации. */
  const rule = afterRule(data);
  const tail = rule.kept.length ? ''
    : ' Ни одна ось в «после» не вошла, поэтому это два прогона одной и той же '
      + 'конфигурации: разница между ними — цена повтора, а не выигрыш оптимизации.';
  let head;
  if (Math.abs(d) <= nz) {
    head = 'Оптимизация не изменила оценку: разница в пределах шума.';
  } else {
    /* Расхождение метрик — только когда время действительно разошлось:
       одинаковое время ни одной метрике не принадлежит. */
    const slower = t && t.d > 0;
    if (t && t.d !== 0 && ((d > 0 && slower) || (d < 0 && !slower))) {
      head = 'Метрики расходятся: оценка ' + (d > 0 ? 'выше' : 'ниже') + ' после, а время — '
        + (slower ? 'дольше' : 'короче') + '; одного ответа числа не дают.';
    } else {
      head = d < 0
        ? 'После оптимизации оценка ниже на ' + num(-d, 2) + '.'
        : 'После оптимизации оценка выше на ' + num(d, 2) + '.';
    }
  }
  return head + basis + speed + tail;
}

/* ── Таблица сжатия весов ───────────────────────────────────────────────
   Четыре строки, и у стороны без отказов верность может быть «нет данных»:
   её тексты не публикуются, и судья по ней мог не пройти вовсе. */
function quantRows(data) {
  const q = (data && data.quant) || {};
  const a = q.a || {}, b = q.b || {};
  const row = (name, key, digits, higher, lower) => {
    const x = a[key], y = b[key];
    const d = typeof x === 'number' && typeof y === 'number' ? y - x : null;
    return { name: name, digits: digits, a: x, b: y, d: d,
      word: diffWord(d, null, higher, lower) };
  };
  const rows = [
    row('До 1-го токена, с', 'ttft_s', 2, 'дольше у Q6_K', 'быстрее у Q6_K'),
    row('Ток/с', 'tps', 2, 'быстрее у Q6_K', 'медленнее у Q6_K'),
    row('Память, МиБ', 'mem_mib', 0, 'больше у Q6_K', 'меньше у Q6_K'),
  ];
  const of = typeof a.of === 'number' ? a.of : (typeof b.of === 'number' ? b.of : null);
  rows.push(row('Верных из ' + (of === null ? NO_DATA : of), 'correct', 0,
    'больше у Q6_K', 'меньше у Q6_K'));
  return rows;
}
/* Имя сборки без отказов — из данных, рядом словом, что это за модель. */
function quantNames(data) {
  const q = (data && data.quant) || {};
  return [q.a, q.b].map((s, i) => ({
    label: word(s && s.label),
    model: word(s && s.model),
    note: i === 1 ? 'сборка без отказов' : 'модель базы и прода',
  }));
}

/* ── Стабильность ───────────────────────────────────────────────────────
   Секция не исчезает при отсутствии повторов: пустая секция читалась бы как
   недоделка, а «повторов не было» — это сведение о прогоне. Таблицы при
   этом нет вовсе: сетка с одними заголовками обещает числа, которых нет. */
function stability(data) {
  const ids = Array.isArray(data && data.stability_ids) ? data.stability_ids.filter(Boolean) : [];
  return ids.length
    ? 'Вопросы стабильности названы в данных (' + ids.join(', ')
      + '), и разброс по ним мерен в этом прогоне.'
    : 'Повторов в этом прогоне нет: ни один вопрос не прогнан дважды, и разброс '
      + 'осей этой страницей не измерен.';
}

/* Строка границы меры о разбросе: названные вопросы — из данных, а их
   отсутствие — тоже сведение, а не пустое место. */
function limitIdsLine(data) {
  const ids = Array.isArray(data && data.stability_ids) ? data.stability_ids.filter(Boolean) : [];
  return ids.length
    ? 'Разброс измерен только на ' + ids.length + ' ' + plural(ids.length, 'вопросе', 'вопросах', 'вопросах')
      + ': ' + ids.join(', ') + '.'
    : 'Разброс в этом прогоне не измерен: повторов нет ни у одного вопроса.';
}

globalThis.DAY29_VERDICT = { NO_DATA, PARTIAL_MSG, SPEED_SUSPECT, isSuspect, axisAnchor, plural, num,
  signed, pct, noise, diffWord, axisValue, axisRows, suspectLine, changedLine, gainRows,
  afterRule, verdictText, quantRows, quantNames, stability, limitIdsLine };
})();
