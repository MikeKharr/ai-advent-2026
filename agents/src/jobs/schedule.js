// Следующий срок работы — из `scheduleUtc` работы, и ниоткуда больше.
//
// Отдельная константа каденции здесь была бы второй копией расписания:
// каденция живёт в одном месте — `scheduleUtc` работы в `jobs.json`, — и
// таблицу `crond` собирает из него же `deploy/cron/crontab.sh` на старте
// контейнера времени. Копия в коде не сверялась бы ни с чем, и страница
// обещала бы посетителю срок, которого не будет, не покраснев нигде.
//
// Поддержано ровно то, что встречается в наших работах: `*`, `*/N` и списки
// через запятую в минутах и часах, `*` в остальных трёх полях. Всё прочее —
// ошибка загрузки, а не молчаливое «раз в час»: обещать срок по не понятому
// расписанию хуже, чем не запуститься.
//
// Эта функция — ЕДИНСТВЕННЫЙ разборщик грамматики расписания в проекте.
// Сборщик таблицы проверяет только то, что нужно ему самому (пять полей,
// белый список знаков, `*` в трёх последних полях), и грамматику здесь не
// повторяет. Что настоящий `jobs.json` проходит именно через неё, держит
// `test/cron-schedule.test.js` — он вызывает настоящий `loadJobs`.

const FIELDS = ['минуты', 'часы', 'день месяца', 'месяц', 'день недели']

/** Значения поля: `*` — весь диапазон, `*\/N` — шаг, список — перечисление. */
function values(spec, min, max, what) {
  if (spec === '*') return range(min, max)
  const step = /^\*\/(\d+)$/.exec(spec)
  if (step) {
    const n = Number(step[1])
    if (!Number.isInteger(n) || n <= 0 || n > max - min + 1)
      throw new Error(`расписание: шаг ${spec} в поле «${what}» вне диапазона`)
    return range(min, max).filter((v) => (v - min) % n === 0)
  }
  if (/^\d+(,\d+)*$/.test(spec)) {
    const list = spec.split(',').map(Number)
    for (const v of list)
      if (v < min || v > max) throw new Error(`расписание: ${v} в поле «${what}» вне диапазона`)
    return [...new Set(list)].sort((a, b) => a - b)
  }
  throw new Error(`расписание: поле «${what}» не поддержано: ${spec}`)
}

const range = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => min + i)

/** Разбор расписания. Непонятое расписание — ошибка здесь, на загрузке. */
export function parseSchedule(text) {
  if (typeof text !== 'string') throw new Error('расписание: ожидалась строка')
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`расписание: ожидалось пять полей, получено ${parts.length}`)
  const [minute, hour, dom, mon, dow] = parts
  for (const [i, spec] of [dom, mon, dow].entries())
    if (spec !== '*')
      throw new Error(`расписание: поле «${FIELDS[i + 2]}» поддержано только как «*»`)
  return { minutes: values(minute, 0, 59, FIELDS[0]), hours: values(hour, 0, 23, FIELDS[1]) }
}

/**
 * Ближайший срок строго после `from`, в UTC. Часы и минуты берутся по UTC, а
 * не по поясу процесса: сутки счётчика стартов и сутки расписания обязаны
 * быть одними и теми же: таблицу сроков контейнер времени собирает из этого
 * же `agents/config/jobs.json` сборщиком `deploy/cron/crontab.sh`, второй
 * копии каденции нет.
 */
export function nextRunAt(schedule, from) {
  const { minutes, hours } = schedule
  // Минута срока начинается на нулевой секунде: ищем от следующей минуты.
  const start = new Date(Math.floor(from / 60_000) * 60_000 + 60_000)
  // Двое суток с запасом: при любом поддержанном расписании срок есть в
  // пределах суток, запас — на переход через полночь.
  for (let step = 0; step <= 2 * 24 * 60; step += 1) {
    const at = new Date(start.getTime() + step * 60_000)
    if (hours.includes(at.getUTCHours()) && minutes.includes(at.getUTCMinutes()))
      return at.toISOString()
  }
  // Недостижимо при разобранном расписании: пустых полей `parseSchedule` не
  // отдаёт. Отдельная ветка — чтобы «нет срока» не выглядело как «сейчас».
  return null
}

/** Сколько сроков в сутках — для проверки, что потолок стартов остаётся запасом. */
export function slotsPerDay(schedule) {
  return schedule.hours.length * schedule.minutes.length
}

/**
 * Последний наступивший срок — зеркало `nextRunAt`: тот же ряд сроков, только
 * назад и включая текущую минуту. Это КЛЮЧ СЛОТА `409 slot_taken`
 * (ADR 2026-09-28-1323, п. 2): «один старт на срок» читается так при любой
 * каденции, и второй настройки рядом с `scheduleUtc` не заводится.
 *
 * Зеркальность обязана быть настоящей: слот и обещанный экрану срок берутся
 * из одного ряда, и разойдись они — слот занимал бы не тот срок, а покраснеть
 * было бы нечему. Поэтому обе функции считают по UTC и ищут поминутно одним и
 * тем же условием; держит равенство рядов тест
 * «lastDueAt и nextRunAt дают один и тот же ряд сроков» в `agents/test/jobs.test.js`.
 */
export function lastDueAt(schedule, at) {
  const { minutes, hours } = schedule
  // Минута срока начинается на нулевой секунде: текущая минута уже наступила.
  const start = Math.floor(at / 60_000) * 60_000
  for (let step = 0; step <= 2 * 24 * 60; step += 1) {
    const d = new Date(start - step * 60_000)
    if (hours.includes(d.getUTCHours()) && minutes.includes(d.getUTCMinutes())) return d.toISOString()
  }
  // Недостижимо при разобранном расписании — см. `nextRunAt`.
  return null
}
