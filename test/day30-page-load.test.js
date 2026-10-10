// Страница дня 30 грузит один обычный скрипт — site/day30/app.js. Тест
// повторяет именно это: vm.Script в контексте без DOM, нестрогий режим снаружи,
// — а не импорт модуля.
//
// Ради чего: у дня 21 голый блок в первом скрипте выпускал функции в глобальную
// область, и второй падал с SyntaxError — страница вечно «читала результаты»
// (находка design-review к #295). У дня 30 скрипт один, но та же ловушка живёт
// в любой опечатке верхнего уровня: без этого теста падение видно только в
// браузере, потому что site/ не единица CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

function loadPage() {
  // Минимум окружения: на верхнем уровне app.js объявляет функции, размечает
  // прокручиваемые области и зовёт fetch. fetch не завершается — рендер здесь
  // не проверяется, проверяется загрузка.
  const ctx = vm.createContext({
    fetch: () => new Promise(() => {}),
    console,
    document: { querySelectorAll: () => [] },
    window: { addEventListener: () => {} },
  })
  new vm.Script(read('../site/day30/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return ctx
}

test('app.js дня 30 грузится без ошибки', () => {
  assert.doesNotThrow(loadPage)
})

// Подложный DOM: ровно столько, сколько трогает app.js. Объявления функций
// обычного скрипта попадают в глобальную область контекста vm, поэтому render
// и verdictText здесь вызываются напрямую.
function fakeDom() {
  const nodes = new Map()
  const mk = (name) => ({
    name, hidden: false, textContent: '', className: '', scope: '',
    children: [], scrollWidth: 0, clientWidth: 0,
    appendChild(n) { this.children.push(n); return n },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelector() { return null }, focus() {},
    get childElementCount() { return this.children.length },
  })
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, mk(id))
      return nodes.get(id)
    },
    createElement: (t) => mk(t),
    querySelectorAll: () => [],
  }
  const ctx = vm.createContext({
    fetch: () => new Promise(() => {}), console, document,
    window: { addEventListener: () => {} },
  })
  new vm.Script(read('../site/day30/app.js'), { filename: 'app.js' }).runInContext(ctx)
  return { ctx, get: (id) => document.getElementById(id) }
}

const DATA = () => JSON.parse(read('../site/day30/results.json'))

// Ради чего: пустая таблица с одними заголовками обещает числа, которых нет
// (находка design-review к #339 на соседней странице недели).
for (const [name, mutate] of [
  ['файла нет или он негоден', () => ({})],
  ['чужой день в файле', () => ({ ...DATA(), day: 29 })],
  ['прогона ещё не было', () => ({ ...DATA(), burst: [], limits: [] })],
  ['проб с несколькими запросами в прогоне нет', () => ({ ...DATA(), burst: [] })],
]) {
  test('таблица параллельных запросов не остаётся пустой сеткой: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    assert.equal(dom.get('burst-tbl').hidden, true, 'таблица осталась на экране без строк')
    assert.equal(dom.get('burst-body').children.length, 0, 'в таблице появились строки')
    // Причина названа, и ровно один раз: либо в главном статусе (файла нет,
    // чужой день, пусто — экран снимается разом), либо на месте самой
    // таблицы (частный случай «проб нет»). Повтор полного текста в обоих
    // местах — дефект; отсылку из других секций проверяет тест ниже.
    const said = ['verdict', 'burst-status']
      .map((id) => dom.get(id))
      .filter((n) => !n.hidden && n.textContent.trim().length > 0)
      .map((n) => n.textContent.trim())
    assert.ok(said.length > 0, 'причины на месте таблицы нет')
    assert.equal(new Set(said).size, said.length,
      'одно и то же сообщение напечатано дважды: ' + JSON.stringify(said))
  })
}

test('негодный файл: таблица ограничений и блок доступа тоже сняты', () => {
  const dom = fakeDom()
  dom.ctx.render({})
  assert.equal(dom.get('lim-tbl').hidden, true)
  assert.equal(dom.get('acc-box').hidden, true)
  assert.ok(dom.get('verdict').textContent.includes('results.json'),
    'состояние «ошибка» не названо')
})

// Одно сообщение на экран, а не четыре одинаковых в четырёх role="status":
// отсутствие файла — одна причина, и читать её четырежды незачем
// (находка design-review к #344).
for (const [name, mutate] of [
  ['негодный файл', () => ({})],
  ['чужой день', () => ({ ...DATA(), day: 29 })],
  ['прогона ещё не было', () => ({ ...DATA(), burst: [], limits: [] })],
]) {
  test('полное сообщение состояния печатается один раз: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    const full = dom.get('verdict').textContent.trim()
    assert.ok(full.length > 0, 'главный статус пуст')
    const copies = ['verdict', 'burst-status', 'acc-status', 'lim-status']
      .map((id) => dom.get(id))
      .filter((n) => !n.hidden && n.textContent.trim() === full)
    assert.equal(copies.length, 1,
      'полный текст напечатан ' + copies.length + ' раз, а должен один')
    assert.equal(copies[0].name, 'verdict', 'полный текст стоит не в главном статусе')
    // Блок оговорок прогона в этих состояниях пуст, и подпись с числом
    // снятых не должна висеть над пустотой.
    for (const id of ['run-notes-cap', 'run-notes', 'run-notes-dup']) {
      assert.equal(dom.get(id).hidden, true, id + ' остался на экране без данных')
    }
  })

  // Секция, у которой остались только заголовок и абзац, обещает содержимое,
  // а причина уехала на полтора экрана вверх. Короткая строка на месте
  // пустого блока связывает их (находка design-review к #344).
  test('пустые секции несут короткую отсылку к причине: ' + name, () => {
    const dom = fakeDom()
    dom.ctx.render(mutate())
    const full = dom.get('verdict').textContent.trim()
    for (const id of ['acc-status', 'lim-status']) {
      const n = dom.get(id)
      assert.equal(n.hidden, false, id + ' скрыт — секция осталась пустой без объяснения')
      assert.ok(n.textContent.trim().length > 0, id + ' пуст')
      assert.notEqual(n.textContent.trim(), full,
        id + ' повторяет полное сообщение целиком, а должен отсылать к нему')
      assert.ok(/«Итоге дня»/.test(n.textContent),
        'строка не говорит, где искать причину: ' + n.textContent)
    }
    assert.equal(dom.get('acc-box').hidden, true, 'пустой dl доступа остался на экране')
    assert.equal(dom.get('lim-tbl').hidden, true, 'пустая таблица ограничений осталась на экране')
  })
}

// Главное место, где страница может соврать молча: при выключенной частной
// сети пробы через прод дают один и тот же ответ и гипотез не различают.
// Вывод дня в этом случае не считается.
test('частная сеть выключена: вывод дня не считается', () => {
  const d = DATA()
  const prod = d.burst.find((r) => /публичн/i.test(r.path))
  prod.served = 0
  prod.refused = prod.requests
  const dom = fakeDom()
  dom.ctx.render(d)
  const text = dom.get('verdict').textContent
  assert.ok(text.includes('Вывод будет после полного прогона'),
    'вывод посчитан по пробам, которые гипотез не различают: ' + text)
  assert.ok(!/Сервис доступен снаружи/.test(text), 'страница объявила сервис доступным')
})

test('на полных данных вывод дня, таблицы и подвал показаны', () => {
  const dom = fakeDom()
  const d = DATA()
  dom.ctx.render(d)
  assert.equal(dom.get('burst-tbl').hidden, false)
  assert.equal(dom.get('lim-tbl').hidden, false)
  assert.equal(dom.get('acc-box').hidden, false)
  assert.ok(dom.get('burst-body').children.length === d.burst.length, 'строк проб нет')
  // Строк в таблице не меньше, чем записей в данных: одна запись прогона
  // несёт два ограничения, и второе получает свою строку (см. ниже).
  assert.ok(dom.get('lim-body').children.length >= d.limits.length,
    'строк ограничений меньше, чем записей в данных')
  assert.ok(dom.get('verdict').textContent.includes('Сервис доступен снаружи'),
    'вывод дня не посчитан: ' + dom.get('verdict').textContent)
  assert.ok(dom.get('run-line').textContent.includes(d.commit), 'строки прогона нет')
  // Публичный путь первой строкой: им ведёт вывод дня.
  assert.ok(/публичн/i.test(dom.get('burst-body').children[0].children[0].textContent),
    'первой строкой стоит не публичный путь')
})

// Причина отказа — дословно из записи прогона. Своей формулировкой страница
// утверждала бы причину, которой отказавший путь не называл: запись говорит
// «все провайдеры класса недоступны или отказали», а не «ёмкость занята»
// (находка design-review к #344).
test('причина отказа в выводе дня взята из данных, а не написана страницей', () => {
  const dom = fakeDom()
  const d = DATA()
  const refused = d.burst.find((r) => r.refused > 0)
  dom.ctx.render(d)
  assert.ok(dom.get('verdict').textContent.includes(refused.reason),
    'дословной причины в выводе нет: ' + dom.get('verdict').textContent)
})

test('причины нет в записи — страница говорит это, а не придумывает', () => {
  const dom = fakeDom()
  const d = DATA()
  const refused = d.burst.find((r) => r.refused > 0)
  const was = refused.reason
  refused.reason = null
  dom.ctx.render(d)
  const text = dom.get('verdict').textContent
  assert.ok(text.includes('причины в записи прогона нет'),
    'отсутствие причины не названо: ' + text)
  assert.ok(!text.includes(was), 'причина взялась неизвестно откуда')
})

// Непроверенное ограничение — «не проверялось», а не «нет» и не пустая ячейка:
// защита без отрицательной пробы не проверена (I-14 по духу).
test('непроверенное ограничение помечено словом, а не пустой ячейкой', () => {
  const dom = fakeDom()
  const d = DATA()
  d.limits = [{ name: 'потолок размера запроса у роутера', value: '6000', fired: null, client_saw: '' }]
  dom.ctx.render(d)
  const cells = dom.get('lim-body').children[0].children.map((c) => c.textContent)
  assert.ok(cells.includes('не проверялось'), 'третий случай не показан: ' + cells.join(' | '))
  assert.ok(dom.get('lim-sum').textContent.includes('не проверено') ||
    dom.get('lim-sum').textContent.includes('не проверялось'),
  'сводка не говорит, что проверки не было: ' + dom.get('lim-sum').textContent)
})

test('index.html дня 30 грузит app.js и не грузит ничего с CDN', () => {
  const html = read('../site/day30/index.html')
  assert.ok(html.includes('src="app.js"'), 'app.js не подключён')
  // Проверяются именно загружаемые ресурсы, а не всякий внешний адрес:
  // ссылки на файлы кода в репозитории (…/limits.js, …/health.js) ведут на
  // GitHub и запросом страницы не являются.
  assert.ok(!/<(?:script|link)\b[^>]*(?:src|href)="https?:\/\//.test(html),
    'есть запрос к сторонним скриптам или стилям')
})

// Форма файла данных: страница встаёт в «ошибка» при чужом day, и это ловится
// только здесь — site/ не единица CI, валидатора results.json нет (Р-3).
test('results.json дня 30 несёт свой день, повторы, пробы и ограничения', () => {
  const d = DATA()
  assert.equal(d.day, 30)
  assert.equal(typeof d.repeats, 'number')
  assert.ok(Array.isArray(d.burst) && d.burst.length > 0, 'проб нет')
  assert.ok(Array.isArray(d.limits) && d.limits.length > 0, 'ограничений нет')
  for (const r of d.burst) {
    assert.equal(typeof r.path, 'string')
    for (const k of ['requests', 'served', 'refused', 'total_s']) {
      assert.equal(typeof r[k], 'number', k + ' у пути ' + r.path + ' не число')
    }
    assert.equal(r.served + r.refused, r.requests, 'обслужено и отказано не сходятся с числом запросов у ' + r.path)
  }
  for (const l of d.limits) {
    assert.equal(typeof l.name, 'string')
    assert.ok(l.fired === true || l.fired === false || l.fired === null,
      'fired не true/false/null у ограничения ' + l.name)
  }
})

// ADR недели, п. 6.4 и вето compliance: на страницу дня 30 идут только времена
// и коды. Текста ответа модели нет ни в данных, ни в разметке.
test('в данных дня 30 нет ни одного текста ответа модели', () => {
  const d = DATA()
  const seen = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (['answer', 'text', 'prompt', 'judge_note', 'answers', 'completion'].includes(k)) seen.push(k)
      walk(v)
    }
  }
  walk(d)
  assert.deepEqual(seen, [], 'в данных есть поля с текстом: ' + seen.join(', '))
})

// I-1, I-3, I-10: страница публичная. Адрес частной сети, имя машины в ней и
// значение ключа в данных и в разметке — дефект, а не недосмотр.
test('ни в данных, ни в разметке дня 30 нет адресов частной сети и имён машин', () => {
  const texts = [read('../site/day30/results.json'), read('../site/day30/index.html'),
    read('../site/day30/app.js')]
  for (const t of texts) {
    assert.ok(!/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/.test(t),
      'адрес частной сети Tailscale в тексте страницы')
    assert.ok(!/[A-Za-z0-9-]+\.ts\.net/.test(t), 'имя машины в частной сети в тексте страницы')
    assert.ok(!/s[k]-ant-|EVAL_KEY=\S/.test(t), 'похожее на значение ключа в тексте страницы')
  }
})

// ── Оговорки прогона (находка design-review к #344) ─────────────────────────
// Все три оговорки прогона дня 30 повторяют то, что страница говорит своими
// словами рядом. Список снятых — названный, и он устаёт: формулировка в
// to_page.py меняется — и метка перестаёт на что-либо указывать. Мёртвая
// метка ничего не ломает (фильтр открытый), но утверждает, будто страница
// это уже говорит, а проверить нечем. Сверяется по данным, лежащим рядом.
test('в ALREADY_SAID нет мёртвых меток: каждая находит оговорку в данных', () => {
  const app = read('../site/day30/app.js')
  const list = app.slice(app.indexOf('const ALREADY_SAID'), app.indexOf('const saidOnPage'))
  const marks = [...list.matchAll(/\['([^']+)',/g)].map((m) => m[1])
  assert.ok(marks.length > 0, 'список снятых оговорок не разобрался')
  const notes = DATA().notes
  for (const mark of marks) {
    assert.ok(notes.some((n) => n.startsWith(mark)),
      'метка «' + mark + '» не находит ни одной оговорки прогона — список устарел')
  }
})

test('незнакомая оговорка прогона остаётся на экране', () => {
  const dom = fakeDom()
  const d = DATA()
  d.notes = ['Совершенно новая оговорка, которой страница не знает.']
  dom.ctx.render(d)
  assert.deepEqual(dom.get('run-notes').children.map((li) => li.textContent), d.notes)
  assert.equal(dom.get('run-notes').hidden, false, 'новая оговорка спрятана')
  assert.equal(dom.get('run-notes-cap').hidden, false, 'подписи у списка нет')
  assert.equal(dom.get('run-notes-dup').hidden, true, 'снятым названо то, что не снималось')
})

test('все оговорки повторяют сказанное: список прячется, число остаётся', () => {
  const dom = fakeDom()
  const d = DATA()
  assert.equal(d.notes.length, 3, 'проверка потеряла смысл: оговорок в данных не три')
  dom.ctx.render(d)
  assert.equal(dom.get('run-notes').hidden, true, 'продублированные оговорки на экране')
  assert.equal(dom.get('run-notes-cap').hidden, true, 'подпись осталась без списка')
  assert.equal(dom.get('run-notes-dup').hidden, false, 'снятое с экрана не названо числом')
  assert.ok(/Ещё 3 оговорки прогона повторяют/.test(dom.get('run-notes-dup').textContent),
    'число снятых названо неверно: ' + dom.get('run-notes-dup').textContent)
})

// ── «retry-after None» (находка design-review к #344) ───────────────────────
// Литерал Python в записи прогона: день 5 заголовка retry-after не отдаёт, и
// посетитель такого не видел. На странице его быть не должно.
test('литерал «retry-after None» на страницу не попадает', () => {
  const dom = fakeDom()
  const d = DATA()
  const raw = d.limits.find((l) => /retry-after None/.test(l.client_saw || ''))
  assert.ok(raw, 'проверка потеряла смысл: такой записи в данных нет')
  dom.ctx.render(d)
  const cells = dom.get('lim-body').children.flatMap((tr) => tr.children.map((c) => c.textContent))
  assert.ok(!cells.some((c) => /retry-after None/.test(c)),
    'литерал Python напечатан: ' + cells.filter((c) => /retry-after/.test(c)).join(' | '))
  // Остальная часть строки — то, что клиент действительно увидел, — на месте.
  assert.ok(cells.some((c) => c.includes('Слишком часто')),
    'вместе с заголовком потерялся и текст, который клиент видел')
})

test('незнакомый текст «что увидел клиент» доходит до экрана как есть', () => {
  const dom = fakeDom()
  const d = DATA()
  d.limits = [{ name: 'своё ограничение', value: '1', fired: true, client_saw: '418, None shall pass' }]
  dom.ctx.render(d)
  const cells = dom.get('lim-body').children[0].children.map((c) => c.textContent)
  assert.ok(cells.includes('418, None shall pass'),
    'убрано больше, чем один известный фрагмент: ' + cells.join(' | '))
})

// ── Расщепление записи ограничения (находка design-review к #344) ───────────
// Одна запись прогона несёт два ограничения: потолок дня 5 (проба была) и
// потолок роутера в скобках (пробы не было). Границы меры обещают пометку
// «не проверялось» — без отдельной строки это обещание ничем не закрыто.
test('потолок роутера стоит отдельной строкой со «не проверялось»', () => {
  const dom = fakeDom()
  dom.ctx.render(DATA())
  const rows = dom.get('lim-body').children.map((tr) => tr.children.map((c) => c.textContent))
  const router = rows.find((r) => /maxRequestTokens/.test(r[0]))
  assert.ok(router, 'строки про потолок роутера нет: ' + rows.map((r) => r[0]).join(' | '))
  assert.equal(router[2], 'не проверялось', 'потолок роутера помечен как проверенный')
  assert.ok(router[3].length > 0, 'причина, по которой пробы не было, не названа')
  assert.ok(/не проверялось/.test(dom.get('lim-sum').textContent),
    'сводка не называет непроверенное ограничение: ' + dom.get('lim-sum').textContent)
})

// Имя строки не повторяет колонку «Значение»: иначе число стоит на экране
// дважды и колонка перестаёт что-либо добавлять.
test('имя ограничения не повторяет его значение', () => {
  const dom = fakeDom()
  dom.ctx.render(DATA())
  for (const tr of dom.get('lim-body').children) {
    const [name, value] = tr.children.map((c) => c.textContent)
    if (!/^[0-9]+$/.test(value)) continue
    assert.ok(!name.includes(value),
      'имя «' + name + '» повторяет значение ' + value)
  }
})

// Числа дополнительных строк не литералы страницы: каждое стоит внутри того
// же имени из results.json, по которому строка и подобрана (I-8).
test('числа расщеплённых строк взяты из имени записи в results.json', () => {
  const app = read('../site/day30/app.js')
  const list = app.slice(app.indexOf('const LIMIT_ROWS'), app.indexOf('function limitRows'))
  const keys = [...list.matchAll(/^ {2}\['([^']+)',$/gm)].map((m) => m[1])
  assert.ok(keys.length > 0, 'список строк ограничений не разобрался')
  const names = DATA().limits.map((l) => l.name)
  for (const key of keys) {
    assert.ok(names.includes(key), 'ключ «' + key + '» не находит записи прогона — список устарел')
  }
  // Значение, которое страница подставляет сама, обязано стоять в данных.
  const values = [...list.matchAll(/value: '([0-9]+)'/g)].map((m) => m[1])
  assert.ok(values.length > 0, 'проверка потеряла смысл: своих значений в списке нет')
  for (const v of values) {
    assert.ok(names.some((n) => n.includes(v)),
      'значение ' + v + ' не встречается ни в одном имени из results.json — это литерал страницы')
  }
})

test('незнакомое ограничение проходит в таблицу без изменений', () => {
  const dom = fakeDom()
  const d = DATA()
  d.limits = [{ name: 'ограничение, которого страница не знает', value: '7', fired: false, client_saw: '200' }]
  dom.ctx.render(d)
  const rows = dom.get('lim-body').children.map((tr) => tr.children.map((c) => c.textContent))
  assert.deepEqual(rows, [['ограничение, которого страница не знает', '7', 'нет', '200']])
})
