// Вердикт страницы дня 28 — чистые функции без DOM. Один файл на двоих, по
// образцу site/day21/verdict.js: страница подключает его обычным скриптом
// перед app.js, тест test/day28-verdict.test.js — импортом в Node.
// Вынесено, чтобы у счёта был держатель: вывод дня, порог шума, слова колонки
// «Разница», отбор вопросов с совпавшим поиском и строка стабильности
// считаются здесь, а не читаются из данных (спецификация дней 26–30,
// «Что страница считает сама и чего в файле нет»).
//
// Обёртка — функция, а НЕ голый блок `{ … }`: в нестрогом скрипте объявления
// функций внутри блока по Annex B утекают в глобальную область, и
// `const { plural, … } = globalThis.DAY28_VERDICT` в app.js падает с
// SyntaxError — страница тогда вечно «читает результаты» (находка
// design-review к #295). В Node Annex B не действует, поэтому это держит
// test/day28-page-load.test.js, а не тест вердикта.
(function () {
const NO_DATA = 'нет данных';
const PARTIAL_MSG = 'Вывод будет после полного прогона.';
const SIDE_NAME = { local: 'локальной', cloud: 'облачной' };

/* Склонение после числа: 1 вопрос, 2 вопроса, 5 вопросов. */
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

/* Вопросы, на которых верный документ нашли обе стороны: только по ним
   считается вывод дня. Индексы прода и ноутбука разные, и сравнение честно
   лишь там, где поиск совпал (ADR недели, «Последствия»). */
function matched(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.filter((q) => q && q.retrieved_match === true &&
    q.local && q.cloud &&
    typeof q.local.score === 'number' && typeof q.cloud.score === 'number');
}
/* Из чего состоит набор: совпал, не совпал, верного документа нет вовсе.
   Третий случай — общие вопросы: совпадать нечему, и «нет» про них соврало бы. */
function counts(questions) {
  const all = Array.isArray(questions) ? questions.filter(Boolean) : [];
  return {
    total: all.length,
    matched: all.filter((q) => q.retrieved_match === true).length,
    missed: all.filter((q) => q.retrieved_match === false).length,
    nodoc: all.filter((q) => q.retrieved_match === null || q.retrieved_match === undefined).length,
  };
}
function scoreAvg(qs, side) {
  if (!qs.length) return null;
  return qs.reduce((s, q) => s + q[side].score, 0) / qs.length;
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

/* Сравнимо ли время: у облачной стороны его может не быть вовсе — прогон дня
   22 времени не записывает, а сданный день не правится. */
function timePair(data) {
  const s = data && data.summary;
  const l = s && s.local ? s.local.time_s_mean : null;
  const c = s && s.cloud ? s.cloud.time_s_mean : null;
  const ok = typeof l === 'number' && Number.isFinite(l) &&
    typeof c === 'number' && Number.isFinite(c);
  return { local: l, cloud: c, comparable: ok, faster: ok && l !== c ? (l < c ? 'local' : 'cloud') : null };
}

/* Строки таблицы «Итог сравнения»: значения берутся из данных, знак и слово
   считаются здесь. Порог шума у оценки — 2/n по вопросам с совпавшим поиском;
   у счётчиков ответов — два ответа из набора. */
function summaryRows(data) {
  const s = (data && data.summary) || {};
  const l = s.local || {}, c = s.cloud || {};
  const qs = matched(data && data.questions);
  const nz = noise(qs.length);
  const pair = (key) => {
    const a = l[key], b = c[key];
    const d = typeof a === 'number' && typeof b === 'number' ? a - b : null;
    return { a: a, b: b, d: d };
  };
  const rows = [];
  const score = { a: scoreAvg(qs, 'local'), b: scoreAvg(qs, 'cloud') };
  score.d = typeof score.a === 'number' && typeof score.b === 'number' ? score.a - score.b : null;
  rows.push({
    name: 'Оценка судьи по совпавшему поиску, 0–2', digits: 2,
    a: score.a, b: score.b, d: score.d,
    word: diffWord(score.d, nz, 'выше у локальной', 'выше у облачной'),
  });
  const whole = pair('score_avg');
  rows.push({
    name: 'Оценка судьи по всем вопросам, 0–2', digits: 2,
    a: whole.a, b: whole.b, d: whole.d,
    word: diffWord(whole.d, noise(l.answers), 'выше у локальной', 'выше у облачной'),
  });
  [['retrieved', 'Ответов с найденным верным документом'],
    ['cited', 'Ответов со ссылкой на источник'],
    ['refused', 'Отказов отвечать']].forEach(([key, name]) => {
    const p = pair(key);
    rows.push({
      name: name, digits: 0, a: p.a, b: p.b, d: p.d,
      word: diffWord(p.d, 2, 'больше у локальной', 'больше у облачной'),
    });
  });
  const t = pair('time_s_mean');
  rows.push({
    name: 'Полное время ответа, с (среднее по разным вопросам)', digits: 1,
    a: t.a, b: t.b, d: t.d,
    word: diffWord(t.d, null, 'дольше у локальной', 'дольше у облачной'),
  });
  return rows;
}

/* Вывод дня. Считается только по вопросам с совпавшим поиском, и их число
   стоит в той же фразе — иначе разница поиска выдавалась бы за разницу
   моделей. Три случая, и третий обязателен: метрики могут расходиться. */
function verdictText(data) {
  const s = (data && data.summary) || {};
  if (!s.local || !s.cloud || typeof s.local.score_avg !== 'number' ||
      typeof s.cloud.score_avg !== 'number') {
    const have = s.local && typeof s.local.score_avg === 'number' ? 'локальная'
      : s.cloud && typeof s.cloud.score_avg === 'number' ? 'облачная' : null;
    return have
      ? 'Сравнивать нечего: измерена одна сторона из двух — ' + have + '. ' + PARTIAL_MSG
      : 'Сравнивать нечего: ни одной стороны в прогоне нет. ' + PARTIAL_MSG;
  }
  const qs = matched(data.questions);
  const c = counts(data.questions);
  if (!qs.length) {
    return 'Сравнивать нечего: верный документ не нашли обе стороны ни на одном из ' +
      c.total + ' ' + plural(c.total, 'вопроса', 'вопросов', 'вопросов') + '. ' + PARTIAL_MSG;
  }
  const a = scoreAvg(qs, 'local'), b = scoreAvg(qs, 'cloud');
  const d = a - b, nz = noise(qs.length);
  const t = timePair(data);
  const basis = ' Считано по ' + qs.length + ' ' +
    plural(qs.length, 'вопросу', 'вопросам', 'вопросам') + ' с совпавшим поиском из ' +
    c.total + ': ' + num(a, 2) + ' против ' + num(b, 2) +
    ' по рубрике 0/1/2, порог шума — два вопроса из ' + qs.length + ' (' + num(nz, 2) + ').';
  const speed = t.comparable
    ? ' Полное время — ' + num(t.local, 1) + ' с против ' + num(t.cloud, 1) +
      ' с в среднем по разным вопросам.'
    : ' Скорость сторон не сравнивается: времени облачной стороны прогон не записал.';
  if (Math.abs(d) <= nz) {
    return 'Локальная модель отвечает не хуже облачной в пределах шума.' + basis + speed;
  }
  const scoreSide = d > 0 ? 'local' : 'cloud';
  if (t.faster && t.faster !== scoreSide) {
    return 'Метрики расходятся: оценка выше у ' + SIDE_NAME[scoreSide] + ', скорость — у ' +
      SIDE_NAME[t.faster] + '; одного ответа числа не дают.' + basis + speed;
  }
  return (d < 0
    ? 'Локальная модель хуже облачной по оценке на ' + num(-d, 2) + '.'
    : 'Локальная модель выше облачной по оценке на ' + num(d, 2) + '.') + basis + speed;
}

/* Строка «индексы разные» — на виду, а не оговоркой: сколько вопросов вошло в
   вывод и что происходит с остальными. */
function matchLine(data) {
  const c = counts(data && data.questions);
  if (!c.total) return '';
  const parts = ['Поиск совпал на ' + c.matched + ' ' +
    plural(c.matched, 'вопросе', 'вопросах', 'вопросах') + ' из ' + c.total];
  if (c.missed) {
    parts.push('на ' + c.missed + ' ' + plural(c.missed, 'вопросе', 'вопросах', 'вопросах') +
      ' не совпал, и там сравнивались бы ответы по разным фрагментам');
  }
  if (c.nodoc) {
    parts.push('у ' + c.nodoc + ' ' + plural(c.nodoc, 'вопроса', 'вопросов', 'вопросов') +
      ' верного документа в проекте нет вовсе, и совпадать нечему');
  }
  return parts.join('; ') + '. Вывод дня посчитан только по совпавшим.';
}

/* Обрывы в колонке стабильности: нуль ставится только когда причина остановки
   записана. Незаписанная причина — «нет данных», а не нуль (I-8). */
function cutsCell(runs) {
  if (!Array.isArray(runs) || !runs.length) return NO_DATA;
  const known = runs.filter((r) => r && typeof r.done_reason === 'string' && r.done_reason);
  if (!known.length) return NO_DATA;
  return String(known.filter((r) => r.done_reason === 'length').length);
}

/* Стабильность: три вопроса, три ответа каждый. Пустой секции не бывает — при
   сошедшихся вердиктах она говорит это словами. */
function stability(data) {
  const all = Array.isArray(data && data.questions) ? data.questions.filter(Boolean) : [];
  const rows = all
    .filter((q) => q.local && Array.isArray(q.local.runs) && q.local.runs.length)
    .map((q) => {
      const runs = q.local.runs;
      const verdicts = runs.map((r) => (r && typeof r.verdict === 'string' && r.verdict) || NO_DATA);
      return {
        id: q.id,
        runs: runs,
        verdicts: verdicts,
        times: runs.map((r) => num(r && r.time_s, 2)),
        cuts: cutsCell(runs),
        diverged: new Set(verdicts).size > 1,
        short: runs.length < 3,
      };
    });
  if (!rows.length) {
    return { rows: rows, text: 'Повторов в этом прогоне нет: разброс не измерен ни на одном вопросе.' };
  }
  const once = all.length - rows.length;
  const parts = ['Прогнаны по три раза ' + rows.length + ' ' +
    plural(rows.length, 'вопрос', 'вопроса', 'вопросов') + ' — ' +
    rows.map((r) => r.id).join(', ') + '; остальные ' + once + ' — однажды'];
  const short = rows.filter((r) => r.short);
  if (short.length) {
    parts.push('у ' + short.map((r) => r.id).join(', ') + ' пришло меньше трёх ответов, и разброс по ним неполон');
  }
  const div = rows.filter((r) => r.diverged);
  parts.push(div.length
    ? 'вердикты разошлись на ' + div.map((r) => r.id + ' (' + r.verdicts.join(', ') + ')').join(', ')
    : 'вердикты не расходились');
  const cuts = rows.reduce((n, r) => n + (r.cuts === NO_DATA ? 0 : Number(r.cuts)), 0);
  const unknown = rows.filter((r) => r.cuts === NO_DATA);
  parts.push(unknown.length === rows.length
    ? 'причину остановки прогон не записал, и про обрывы по этим числам сказать нечего'
    : cuts ? 'обрывов ' + cuts : 'обрывов не было');
  return { rows: rows, text: parts.join('; ') + '.' };
}

globalThis.DAY28_VERDICT = { NO_DATA, PARTIAL_MSG, SIDE_NAME, plural, num, signed,
  matched, counts, scoreAvg, noise, diffWord, timePair, summaryRows, verdictText,
  matchLine, cutsCell, stability };
})();
