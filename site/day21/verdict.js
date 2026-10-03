// Вердикт страницы итогов дня 21 — чистые функции без DOM. Один файл на
// двоих, по образцу site/validate.js: страница подключает его обычным
// скриптом перед app.js, тест test/day21-verdict.test.js — импортом в Node.
// Вынесено, чтобы у вердикта был держатель: правило «страница не утверждает
// больше, чем считает» ломалось дважды, и оба раза ловилось ревью, а не CI.
//
// Обёртка — функция, а НЕ голый блок `{ … }`. В обычном нестрогом скрипте
// объявления функций внутри блока по Annex B утекают в глобальную область, и
// `const { plural, … } = globalThis.DAY21_VERDICT` в app.js падал с
// `SyntaxError: Identifier 'plural' has already been declared` — app.js не
// разбирался целиком, страница вечно «читала результаты» (находка design-review
// к #295). В Node, где тест берёт этот файл импортом, Annex B не действует,
// поэтому держит это test/day21-page-load.test.js, а не тест вердикта.
(function () {
/* Порядок на экране — fixed, затем structural (как в данных и в ADR). */
const SIDES = ['fixed', 'structural'];
const METRICS = [
  { row: 'recall', key: 'recall@5', name: 'Recall@5', basis: 'queries', kind: 'abs' },
  { row: 'mrr', key: 'mrr@10', name: 'MRR@10', basis: 'queries', kind: 'abs' },
  { row: 'phrase', key: 'phrase_in_first_chunk', name: 'фраза-ответ в первом чанке',
    basis: 'phrase_queries', kind: 'points' },
];

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
const quote = (label) => '«' + label.charAt(0).toLowerCase() + label.slice(1) + '»';

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
   queries[].<стратегия>.rank — тех же мест, из которых мера берёт MRR@10.
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
  if (!sameWay) {
    const parts = beyond.map((x, i) => x.m.name + (i === 0 ? ' выше у ' : ' — у ') +
      quote(data[x.d > 0 ? 'structural' : 'fixed'].label) + ' на ' + amount(x));
    return 'Метрики расходятся: ' + parts.join(', ') + '. Одной лучшей стратегии числа не дают.';
  }
  // «Направление», а не «лучше»: превышение порога шума говорит, что разница
  // не нулевая, но не что она доказана (design-review, первый круг #295).
  const winSide = beyond[0].d > 0 ? 'structural' : 'fixed';
  const loseSide = winSide === 'structural' ? 'fixed' : 'structural';
  const parts = beyond.map((x, i) => x.m.name + (i === 0 ? ' выше на ' : ' — на ') + amount(x));
  const head = 'Направление за ' + quote(data[winSide].label) + ': ' + parts.join(', ') + '.';
  const h = headToHead(data);
  if (!h) return head + ' По отдельным вопросам этот прогон не разбирался.';
  const w = h[winSide], l = h[loseSide], diverged = w + l;
  if (diverged === 0) {
    return head + ' По отдельным вопросам стратегии не разошлись ни разу — все ' + h.n +
      ' вопросов дали одинаковое место; перевес не доказан.';
  }
  // Счёт по вопросам обязан смотреть ТУДА ЖЕ, куда средние. Знаковый тест
  // двусторонний: он мал при сильном перекосе в ЛЮБУЮ сторону, и без этой
  // проверки страница объявляла «Перевес доказан» за сторону, проигравшую
  // по вопросам 10 : 30 (находка reviewer к #295). Средние и счёт расходятся
  // штатно: крупные победы на немногих вопросах против мелких на многих.
  if (w <= l) {
    // Ровный счёт не смотрит в другую сторону — он не смотрит никуда; «в разные
    // стороны» верно только при w < l (нит reviewer к #295).
    if (w < l) {
      return head + ' Но по отдельным вопросам впереди ' + quote(data[loseSide].label) + ': ' + l +
        ' из ' + diverged + ' разошедшихся против ' + w + ', ничьих ' + h.tie +
        '. Средние и счёт по вопросам смотрят в разные стороны — перевес не доказан ни за одну стратегию.';
    }
    return head + ' Но по отдельным вопросам счёт ровный: ' + w + ' : ' + l + ', ничьих ' + h.tie +
      '. Счёт направление средних не подтверждает — перевес не доказан.';
  }
  const p = signTestP(w, l);
  const score = 'по отдельным вопросам ' + quote(data[winSide].label) + ' впереди в ' + w + ' из ' +
    diverged + ' разошедшихся, ' + quote(data[loseSide].label) + ' — в ' + l + ', ничьих ' + h.tie;
  return p < 0.05
    ? head + ' Перевес доказан: ' + score + ' (знаковый тест, p = ' + p.toFixed(2) + ').'
    : head + ' Перевес не доказан: ' + score + '. Случайно такой или более сильный расклад ' +
      'получается с вероятностью ' + p.toFixed(2) + ' (знаковый тест).';
}

/* Сколько вопросов не нашла ни одна стратегия — часть ответа «насколько
   уверенно», а не подробность для фильтра (design-review). */
function noneText(data) {
  const h = headToHead(data);
  return h && h.none
    ? ' У ' + h.none + ' ' + plural(h.none, 'вопроса', 'вопросов', 'вопросов') + ' из ' + h.n +
      ' ни одна стратегия не нашла верный документ в первой десятке.'
    : '';
}

globalThis.DAY21_VERDICT = { SIDES, METRICS, plural, fmt, quote, deltas, headToHead,
  signTestP, verdictText, noneText };
})();
