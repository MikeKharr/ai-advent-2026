// Страница прогресса: «Сейчас в работе», фильтр по потокам и журнал PR из
// data.js. Раскладка и тексты — agent_docs/design/2026-09-10-1553-progress-page.md.
// Правила строк — validate.js. Текст из данных — только через textContent.
{
  const REPO = 'https://github.com/MikeKharr/ai-advent-2026'
  const PULLS = `${REPO}/pulls?q=is%3Apr`
  const GATES = `${REPO}/blob/main/agent_docs/adr/2026-09-10-0426-framework-v2-model-routing.md`
  const KEY = 'progress-stream'
  const ALL = 'all'

  const $ = (id) => document.getElementById(id)
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function link(href, text, cls) {
    const a = el('a', cls, text)
    a.href = href
    return a
  }
  const plural = (n, one, few, many) => {
    const m = n % 10
    const h = n % 100
    if (m === 1 && h !== 11) return one
    return m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many
  }
  // Даты — по UTC, как mergedAt на GitHub.
  const dayName = (d) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  const dayOf = (iso) => dayName(new Date(`${iso}T00:00:00Z`))

  const data = globalThis.PROGRESS
  const check = globalThis.PROGRESS_CHECK
  // Признак ошибки один: после скриптов PROGRESS нет или это не объект.
  const loaded = isObj(data) && isObj(check)

  // ── Сейчас в работе ───────────────────────────────────────────────────
  function renderNow() {
    const box = $('now-body')
    if (!loaded) {
      box.replaceChildren(el('p', 'msg', 'Блок не загрузился: файл с данными недоступен.'))
      return
    }
    const now = isObj(data.now) ? data.now : {}
    const at = typeof now.updated === 'string' ? new Date(now.updated) : null
    if (at && !Number.isNaN(at.getTime())) {
      const t = el('time', null, `${dayName(at)}, ${at.toISOString().slice(11, 16)} UTC`)
      t.dateTime = now.updated
      $('now-updated').replaceChildren('обновлено ', t)
    }
    // Пункт без заголовка не рисуется; без этапа или текста — рисуется без них.
    const items = (Array.isArray(now.items) ? now.items : []).filter((it) => isObj(it) && check.isText(it.title, 100))
    if (items.length === 0) {
      box.replaceChildren(el('p', 'msg', 'Сейчас ничего не в работе.'))
      return
    }
    const ul = el('ul', 'now-list')
    for (const it of items) {
      const li = el('li')
      if (check.isText(it.stage, 24)) li.append(el('p', 'stage', it.stage))
      li.append(el('h3', null, it.title))
      if (check.isText(it.text, 300)) li.append(el('p', 'now-text', it.text))
      ul.append(li)
    }
    box.replaceChildren(ul)
  }

  // ── Журнал PR ─────────────────────────────────────────────────────────
  let rows = []
  let labels = new Map()
  let current = ALL
  const chips = new Map()

  function initLog() {
    const status = $('log-status')
    if (!loaded) {
      status.classList.add('msg')
      status.replaceChildren('Журнал не загрузился: файл с данными недоступен. Все PR — ', link(PULLS, 'на GitHub'), '.')
      return
    }
    const streams = (Array.isArray(data.streams) ? data.streams : []).filter(
      (s) => isObj(s) && check.isText(s.key, Infinity) && check.isText(s.label, Infinity),
    )
    labels = new Map(streams.map((s) => [s.key, s.label]))
    const all = Array.isArray(data.prs) ? data.prs : []
    rows = all.filter((pr) => check.prFieldProblems(pr, [...labels.keys()]).length === 0)

    const bad = all.length - rows.length
    if (bad > 0) {
      const p = $('log-partial')
      p.textContent = plural(
        bad,
        `${bad} строка журнала не показана: в ней не хватает полей.`,
        `${bad} строки журнала не показаны: в них не хватает полей.`,
        `${bad} строк журнала не показаны: в них не хватает полей.`,
      )
      p.hidden = false
    }

    if (rows.length === 0) {
      status.classList.add('msg')
      status.replaceChildren('В журнале пока нет строк. Все PR — ', link(PULLS, 'на GitHub'), '.')
      return
    }

    renderIntro()
    renderChips(streams)
    let saved = null
    try {
      saved = localStorage.getItem(KEY)
    } catch {}
    select(saved === ALL || labels.has(saved) ? saved : ALL, false)
  }

  function renderIntro() {
    const last = rows.reduce((a, b) => (b.n > a.n ? b : a))
    const first = rows.filter((r) => 'cls' in r).reduce((a, b) => (a && a.n < b.n ? a : b), null)
    const p1 = el('p')
    p1.append(
      `Свежие сверху, по дням мержа (UTC). Номер ведёт на PR в GitHub. Журнал доходит до PR #${last.n} от ${dayOf(last.merged)}; более поздние — в `,
      link(PULLS, 'списке PR на GitHub'),
      '.',
    )
    const p2 = el('p')
    p2.append(
      'Класс — ',
      link(GATES, 'гейт мержа'),
      ': A — деньги, данные, ключи и CI с секретами; B — обычный код; C — документы и лендинг.',
      first ? ` Классы присваиваются с PR #${first.n}.` : '',
    )
    $('log-intro').replaceChildren(p1, p2)
  }

  function renderChips(streams) {
    const box = $('chips')
    const chip = (key, label, n) => {
      const b = el('button', 'chip')
      b.type = 'button'
      b.append(el('span', null, label), el('span', 'num', String(n)))
      b.addEventListener('click', () => select(key, true))
      chips.set(key, b)
      return b
    }
    box.append(chip(ALL, 'Все', rows.length))
    for (const s of streams) box.append(chip(s.key, s.label, rows.filter((r) => r.stream === s.key).length))
    $('filter').hidden = false
  }

  function select(key, remember) {
    current = key
    for (const [k, b] of chips) b.setAttribute('aria-pressed', String(k === key))
    if (remember) {
      try {
        localStorage.setItem(KEY, key)
      } catch {}
    }
    renderGroups()
  }

  function renderGroups() {
    const shown = current === ALL ? rows : rows.filter((r) => r.stream === current)
    const label = labels.get(current)
    $('log-status').textContent =
      current === ALL
        ? `Показаны все ${rows.length} PR`
        : `Показано ${shown.length} из ${rows.length} PR — поток «${label}»`

    const box = $('groups')
    if (shown.length === 0) {
      const empty = el('div', 'empty')
      const btn = el('button', 'show-all', 'Показать все')
      btn.type = 'button'
      // Кнопка исчезает вместе с пустым состоянием: фокус — на чип «Все».
      btn.addEventListener('click', () => {
        select(ALL, true)
        chips.get(ALL).focus()
      })
      empty.append(el('p', 'msg', `В потоке «${label}» пока нет PR.`), btn)
      box.replaceChildren(empty)
      return
    }

    const byDay = new Map()
    for (const r of [...shown].sort((a, b) => b.merged.localeCompare(a.merged) || b.n - a.n)) {
      if (!byDay.has(r.merged)) byDay.set(r.merged, [])
      byDay.get(r.merged).push(r)
    }
    const groups = []
    for (const [day, list] of byDay) {
      const sec = el('section', 'group')
      const h = el('h3', null, dayOf(day))
      h.id = `day-${day}`
      sec.setAttribute('aria-labelledby', h.id)
      const head = el('div', 'group-head')
      head.append(h, el('span', 'count', `${list.length} PR`))
      const ul = el('ul', 'prs')
      for (const r of list) ul.append(prRow(r))
      sec.append(head, ul)
      groups.push(sec)
    }
    box.replaceChildren(...groups)
  }

  function prRow(r) {
    const li = el('li', 'pr')
    const id = el('div', 'pr-id')
    const a = link(`${REPO}/pull/${r.n}`, `#${r.n}`, 'pr-n')
    a.setAttribute('aria-label', `PR #${r.n} на GitHub`)
    id.append(a, el('span', 'pr-type', r.type))
    const body = el('div', 'pr-body')
    const stream = labels.get(r.stream)
    body.append(
      el('p', 'pr-result', r.result),
      el('p', 'pr-goal', `Цель: ${r.goal}`),
      el('p', 'pr-meta', 'cls' in r ? `${stream} · класс ${r.cls}` : stream),
    )
    li.append(id, body)
    return li
  }

  renderNow()
  initLog()
}
