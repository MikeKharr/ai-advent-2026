// Память агента по стратегиям дня 10 (ADR 2026-09-14-0447, п. 2).
// Одна функция на стратегию, все возвращают одно и то же:
// `{ summaryText, factsText, transcript, recentTalk, summarized, context }` —
// блок памяти, реплики для `<dialog>`, слова для отбора статей и числа
// счётчика. Вынесено из `execute`, чтобы ветвления памяти не росли внутри
// запуска.

import { fitDialog } from './llm.js'

/**
 * Дни 7–8 и запуск без стратегии: хвост переписки в окно контекста.
 * Поведение прежнее, байт в байт (критерий приёмки 1).
 */
export function tailMemory({ sessions, sessionId, effective, requested }) {
  const tail = sessions.tail(sessionId, effective)
  return {
    summaryText: null,
    factsText: null,
    transcript: tail.messages,
    recentTalk: null,
    summarized: null,
    context: {
      used: tail.tokens,
      effective,
      requested,
      messages: tail.messages.length,
      dropped: tail.dropped,
    },
  }
}

/**
 * Стратегия 2 — скользящее окно: последние M реплик пути целиком, без окна
 * в токенах. `contextTokens` не читается вовсе: «без ограничения по
 * токенам» из задания (ADR, п. 6). От предела входа модели защищает
 * существующая проверка перед вызовом.
 */
export function windowMemory({ sessions, sessionId, windowSize, requested, from }) {
  const messages = sessions.lastOnPath(sessionId, windowSize, from)
  const used = messages.reduce((sum, m) => sum + m.tokens, 0)
  return {
    summaryText: null,
    factsText: null,
    transcript: messages,
    recentTalk: null,
    summarized: null,
    context: {
      used,
      // Окна в токенах у этой стратегии нет — не показываем чужое число.
      effective: null,
      requested,
      messages: messages.length,
      dropped: 0,
      windowSize,
    },
  }
}

/**
 * Стратегия 4 — ветки: путь от корня до головы, хвостом в окно
 * `contextTokens` (как день 8, но по пути). Реплики других веток модели не
 * видны — в этом и есть сравнение (ADR, п. 8.3).
 */
export function branchMemory({ sessions, sessionId, effective, requested, from }) {
  const path = sessions.path(sessionId, from)
  const tail = fitDialog(path, effective)
  return {
    summaryText: null,
    factsText: null,
    transcript: tail.messages,
    recentTalk: null,
    summarized: null,
    context: {
      used: tail.tokens,
      effective,
      requested,
      messages: tail.messages.length,
      dropped: tail.dropped,
      pathMessages: path.length,
    },
  }
}

/**
 * Стратегия 3 — факты: блок фактов плюс последние M реплик пути целиком.
 * Предыдущие реплики модели не идут — их заменяет выжимка. Как и у окна,
 * порога в токенах здесь нет: `contextTokens` не читается (ADR, п. 2).
 *
 * Якорь фактов вне пути значит, что их писали в другой ветке: факты
 * считаются отсутствующими, и стратегия стартует заново (ADR, п. 8.4).
 * Обновляет факты не эта функция, а запуск: вызов модели живёт там, где
 * считается его цена.
 */
export function factsMemory({ sessions, sessionId, windowSize, requested, from }) {
  const messages = sessions.lastOnPath(sessionId, windowSize, from)
  const stored = sessions.facts(sessionId)
  const onPath = stored ? sessions.factsSource(sessionId, stored.throughId, from).onPath : false
  // Пустой текст остаётся после обрезанного первого вызова: строка живёт
  // ради счётчика обрезаний, а блока памяти из неё нет.
  const factsText = onPath && stored.text !== '' ? stored.text : null
  const factsTokens = factsText === null ? 0 : stored.tokens
  const fresh = messages.reduce((sum, m) => sum + m.tokens, 0)
  return {
    summaryText: null,
    factsText,
    transcript: messages,
    recentTalk: null,
    summarized: null,
    context: {
      used: factsTokens + fresh,
      // Окна в токенах у фактов нет — не показываем чужое число.
      effective: null,
      requested,
      messages: messages.length,
      dropped: 0,
      windowSize,
      factsTokens,
    },
  }
}

/**
 * Стратегия 1 — сводка дня 9 (ADR 2026-09-11-1608). Сжатие делает `compress`
 * из запуска: вызов модели остаётся там, где считается его цена.
 */
export async function summaryMemory({
  sessions,
  sessionId,
  effective,
  requested,
  summarizeAt,
  compress,
  emit,
  strategy = null,
  from,
}) {
  let stored = sessions.summary(sessionId)
  let fresh
  if (strategy === null) {
    // Дни 7–9: переписка линейна, дерева нет — источник по номерам.
    fresh = sessions.since(sessionId, stored?.throughId ?? 0)
  } else {
    // День 10: источник — только путь текущей ветки. Якорь вне пути значит,
    // что сводку писали в другой ветке: она считается отсутствующей, и
    // стратегия стартует заново с пути (ADR 2026-09-14-0447, п. 8.4).
    const source = sessions.summarySource(sessionId, stored?.throughId ?? 0, from)
    if (!source.onPath) stored = null
    fresh = source.fresh
  }
  // Слова для отбора — из реплик до сжатия: после него хвост пуст,
  // а тема разговора жива в последних сообщениях пользователя.
  const recentTalk = fresh
  let summarized = null
  const freshTokens = fresh.reduce((sum, m) => sum + m.tokens, 0)
  if (freshTokens >= summarizeAt) {
    const done = await compress(stored, fresh)
    if (done) {
      stored = { text: done.text, tokens: done.tokens }
      fresh = []
      // Текст сводки — в её строке и в GET сессии; здесь только числа.
      summarized = {
        sourceTokens: done.sourceTokens,
        tokens: done.tokens,
        ratio: done.ratio,
        totalTokens: done.totalTokens,
      }
    }
  }
  // Окно — страховка: сводка, не поместившаяся в него целиком, не идёт,
  // а свежим репликам остаётся то, что сводка не заняла.
  const summaryText = stored && stored.tokens <= effective ? stored.text : null
  const summaryTokens = summaryText === null ? 0 : stored.tokens
  if (stored && summaryText === null) {
    // Не подрезаем: обрезанный пересказ молча терял бы конец в памяти
    // модели, а блок на странице показывал бы его целиком.
    emit({
      stage: 'warning',
      level: 'warn',
      title: 'Сводка не поместилась в окно модели',
      detail: `сводка ${stored.tokens} токенов, окно ${effective}; модель получит только реплики после неё`,
      data: { summaryTokens: stored.tokens, effective },
    })
  }
  const tail = fitDialog(fresh, effective - summaryTokens)
  return {
    summaryText,
    factsText: null,
    transcript: tail.messages,
    recentTalk,
    summarized,
    context: {
      used: summaryTokens + tail.tokens,
      effective,
      requested,
      messages: tail.messages.length,
      dropped: tail.dropped,
      summaryTokens,
      freshTokens: tail.tokens,
      summarized,
    },
  }
}

/**
 * Что вспомнить в этом запуске. Без памяти (нет сессии) или с нулевым окном
 * там, где оно значимо, — пусто: вход равен входу дня 6 байт в байт.
 */
export async function recall(deps) {
  const { strategy, memory, effective, requested } = deps
  const empty = {
    summaryText: null,
    factsText: null,
    transcript: [],
    recentTalk: null,
    summarized: null,
    context: { used: 0, effective, requested, messages: 0, dropped: 0 },
  }
  if (!memory) return empty
  // У окна своего предела в токенах нет, поэтому нулевой `contextTokens`
  // его не выключает: пользователь этим полем в режиме окна не управляет.
  if (strategy === 'window') return windowMemory(deps)
  // У фактов своего предела в токенах тоже нет: нулевой `contextTokens`
  // их не выключает, этим полем пользователь в режиме фактов не управляет.
  if (strategy === 'facts') return factsMemory(deps)
  if (effective <= 0) return empty
  if (strategy === 'branches') return branchMemory(deps)
  if (deps.summarizeAt !== null) return summaryMemory(deps)
  // День 10 без порога сводки: хвост тоже берётся по пути — «последние по
  // номеру» смешали бы соседние ветки. Дни 6–9 идут прежним путём.
  return strategy === null ? tailMemory(deps) : branchMemory(deps)
}
