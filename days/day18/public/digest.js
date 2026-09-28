// Единственное место дня 18, где названы ИМЕНА ПОЛЕЙ сводки планировщика.
//
// НЕУТВЕРЖДЁННЫЙ КОНТРАКТ: ADR 2026-09-28-0736, п. 7 называет данные (план,
// старт, финиш, статус, текст сводки, трейс, токены, остаток бюджета), но не
// называет ручку и не называет имена полей — ручку делает единица `agents`.
// Пока она не названа, все догадки собраны здесь, в одной функции: когда
// контракт утвердят, правится этот файл и больше ничего.
//
// Правило на все значения одно: ЧЕГО НЕ ПРИШЛО — ТОГО НЕТ. Отсутствующее
// число не становится нулём, отсутствующее время — «сейчас», отсутствующий
// статус — «успешно». Нуль вместо неизвестного здесь опаснее пустоты: «стартов
// 0 из 6» читается как «планировщик жив и сегодня не стартовал», хотя на деле
// это «мы не знаем».

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v !== '' ? v : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const int = (v) => (Number.isInteger(v) ? v : null)

/** Разбор ответа ручки сводок в то, что рисует страница. */
export function shapeDigest(json) {
  const d = isObject(json) ? json : {}
  const job = isObject(d.job) ? d.job : {}
  return {
    enabled: typeof job.enabled === 'boolean' ? job.enabled : null,
    agent: str(job.agent),
    schedule: str(job.schedule),
    prompt: str(job.prompt),
    maxRunsPerDay: int(job.maxRunsPerDay),
    nextRunAt: str(d.nextRunAt),
    startsToday: int(d.startsToday),
    budgetLeftUsd: num(d.budgetLeftUsd),
    dailyCostUsd: num(d.dailyCostUsd),
    runningRunId: str(isObject(d.running) ? d.running.runId : null),
    runs: Array.isArray(d.runs) ? d.runs.map(shapeRun) : [],
  }
}

/** Одна сводка ленты. Трейс — массив событий стадии `rpc` как есть. */
export function shapeRun(raw) {
  const r = isObject(raw) ? raw : {}
  return {
    id: str(r.id),
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
    status: str(r.status),
    summary: str(r.summary),
    tokens: int(r.tokens),
    budgetLeftUsd: num(r.budgetLeftUsd),
    trace: Array.isArray(r.trace) ? r.trace : [],
  }
}

/** Отсутствие значения на экране — всегда одно и то же слово, не прочерк. */
export const UNKNOWN = 'неизвестно'

/** Время — UTC и с буквой Z: сроки планировщика считаются по UTC, не по браузеру. */
export function formatWhen(iso) {
  if (iso === null) return UNKNOWN
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return UNKNOWN
  const pad = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`
}

/**
 * Срок планировщика — по времени Бангкока, и пояс назван в самой строке.
 *
 * Перевод ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ, ради показа. Сервер, расписание и все потолки
 * остаются на UTC: суточный счётчик стартов считается по суткам UTC, и это
 * держит сервер, а не страница. Строка без названия пояса была бы хуже
 * отсутствия: через месяц «19:00» не отличить от UTC.
 *
 * Пояс берётся у `Intl` по имени `Asia/Bangkok`, а не сложением семи часов:
 * смещение — свойство пояса, а не наше знание о нём.
 */
export function formatBangkok(iso) {
  if (iso === null) return UNKNOWN
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return UNKNOWN
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(t)
  const at = (type) => parts.find((p) => p.type === type).value
  return `${at('year')}-${at('month')}-${at('day')} ${at('hour')}:${at('minute')} Бангкок`
}

/** Деньги — два знака и знак доллара; отсутствующий остаток словом. */
export function formatUsd(value) {
  return value === null ? UNKNOWN : `$${value.toFixed(2)}`
}

/**
 * «Стартов сегодня из потолка». Обе половины обязаны быть известны: «3 из
 * неизвестно» не говорит ничего, и такая строка не собирается вовсе.
 */
export function startsLine({ startsToday, maxRunsPerDay }) {
  if (startsToday === null || maxRunsPerDay === null) return UNKNOWN
  return `${startsToday} из ${maxRunsPerDay}`
}

/**
 * Текст запроса работы — как он пришёл, без сокращения. Не пришёл — так и
 * сказано словом: пустая рамка на экране читалась бы как «запроса нет», хотя
 * запрос есть и работа по нему идёт, просто ручка его не отдала.
 */
export function promptLine(prompt) {
  if (prompt === null) return UNKNOWN
  return prompt
}

/** Состояние планировщика словом. Третьего случая «наверное включён» нет. */
export function enabledLine(enabled) {
  if (enabled === null) return UNKNOWN
  return enabled ? 'включён' : 'выключен'
}

/** Подпись сводки: время старта, статус, токены. Чего не знаем — того нет. */
export function runMeta(run) {
  const parts = [formatWhen(run.startedAt), run.status ?? UNKNOWN]
  if (run.tokens !== null) parts.push(`${run.tokens} токенов`)
  if (run.budgetLeftUsd !== null) parts.push(`остаток ${formatUsd(run.budgetLeftUsd)}`)
  return parts.join(' · ')
}
