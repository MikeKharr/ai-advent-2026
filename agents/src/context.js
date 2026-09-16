// Точка политики агента дня 11 (ADR 2026-09-15-2024, п. 5.1): единственное
// место, где решаются два вопроса — что из трёх слоёв уходит в запрос
// (`assemble`) и когда и чем слои пополняются после ответа (`replenish`).
// Запуск (`layered.js`) зовёт только эти две функции.
//
// Разделение обязанностей: `sessions.js` отдаёт данные слоёв, `llm.js` —
// транспорт и рендеринг блоков (метки, `safe*`, запрос пополнения, разбор
// дельты), порядок и состав блоков и правило пополнения — только здесь.
//
// Правила внутри — решение владельца, отдельное от записи (решение 6). Ниже
// рабочее умолчание, с которым стартует реализация: замена его на правила
// владельца — правка этого модуля и его тестов, пока политика потребляет те
// же данные.

import {
  askSummary,
  buildReplenishRequest,
  dialogBlock,
  estimateTokens,
  factsBlock,
  fitDialog,
  parseDelta,
  personalizationBlock,
  REPLENISH_ANSWER_TOKENS,
  requestBlock,
  summaryBlock,
  SUMMARY_CLASS,
  SUMMARY_PROVIDER,
  topicBlock,
} from './llm.js'
import { LAYERED_MAX_TOKENS, MODELS, PARAM_LIMITS } from './params.js'
import { explainRouterError, paidNothing, seconds } from './shared.js'

/** Потолки блоков запроса ответа — в токенах (ADR, п. 5.1). */
export const ASSEMBLE_CAPS = {
  rulesTokens: 300,
  topicFacts: 30,
  topicTokens: 1000,
}

/**
 * Потолки частей входа вызова пополнения (ADR, п. 5.2). Потолки в штуках
 * сами по себе расход не держат: 40 правил по 300 знаков — это ~6 800
 * токенов, и открытый профиль давал бы постороннему поднимать цену каждого
 * хода всем, кто этот профиль выберет. Поэтому у каждой части два рубежа —
 * строки и токены, и вход целиком не больше `inputTokens`.
 */
export const REPLENISH_CAPS = {
  topicRows: 30,
  topicsTokens: 300,
  topicFacts: 20,
  topicTokens: 600,
  ruleRows: 40,
  rulesTokens: 300,
  pendingFacts: 24,
  pendingTokens: 400,
  // Формула `factsSourceCap` дня 10 с потолком класса вместо MAX_OUTPUT_TOKENS.
  pairTokens: LAYERED_MAX_TOKENS + Math.ceil(PARAM_LIMITS.promptChars / 2),
  inputTokens: 5000,
}

/**
 * Строки под потолок в токенах. Списки приходят от свежих к старым, поэтому
 * лишнее отбрасывается с хвоста — старшее по `updated_at`.
 */
function fitLines(lines, capTokens) {
  const kept = []
  let tokens = 0
  for (const line of lines) {
    const size = estimateTokens(line) + 1
    if (tokens + size > capTokens) break
    tokens += size
    kept.push(line)
  }
  return { lines: kept, tokens, dropped: lines.length - kept.length }
}

/**
 * Пара реплик под потолок — по отрисованному тексту, а не по числу токенов
 * из ответа роутера. `usage.outputTokens` приходит от провайдера, и
 * заниженное число открывало бы вход вызова на любой размер: ответ в 200 тыс.
 * знаков с `outputTokens: 5` уходил бы целиком (находка ревьюера, PR #153).
 *
 * Одна реплика больше потолка целиком не выбрасывается, а режется: без пары
 * вызов бессмыслен, а без границы он стоит денег.
 */
function fitPair(pair, capTokens) {
  const measured = pair.map((m) => ({ ...m, tokens: estimateTokens(m.text) }))
  const fitted = fitDialog(measured, capTokens)
  if (fitted.messages.length > 0) {
    return { messages: fitted.messages, dropped: fitted.dropped, trimmedChars: 0 }
  }
  const last = measured.at(-1)
  if (!last) return { messages: [], dropped: 0, trimmedChars: 0 }
  const text = trimToTokens(last.text, capTokens)
  return {
    messages: [{ ...last, text, tokens: estimateTokens(text) }],
    dropped: measured.length - 1,
    trimmedChars: last.text.length - text.length,
  }
}

/** Текст под потолок в токенах: длина подбирается сверху вниз по оценке. */
function trimToTokens(text, capTokens) {
  let out = text
  for (let i = 0; i < 12 && out.length > 0 && estimateTokens(out) > capTokens; i++) {
    const ratio = capTokens / estimateTokens(out)
    out = out.slice(0, Math.max(1, Math.floor(out.length * ratio * 0.95)))
  }
  return estimateTokens(out) > capTokens ? '' : out
}

/**
 * Что уйдёт модели в запросе ответа. Умолчание порядка (ADR, п. 5.1):
 * `<personalization>` → `<topic>` → блок стратегии рабочей памяти →
 * `<dialog>` → `<request>`. Блока `<candidates>` нет — данных у агента нет.
 * Системный промпт уходит отдельным полем запроса к роутеру, как в днях
 * 6–10, и в модели стоит перед всем этим.
 *
 * Темы, кроме активной, модели не видны.
 */
export function assemble({
  rules = [],
  topic = null,
  summaryText = null,
  factsText = null,
  transcript = [],
  prompt,
}) {
  const warnings = []
  const blocks = []
  const stats = { rules: 0, rulesTokens: 0, topicFacts: 0, topicTokens: 0 }

  const fittedRules = fitLines(
    rules.map((rule) => `${rule.key} — ${rule.value}`),
    ASSEMBLE_CAPS.rulesTokens,
  )
  if (fittedRules.dropped > 0) {
    warnings.push({
      code: 'rules_trimmed',
      dropped: fittedRules.dropped,
      capTokens: ASSEMBLE_CAPS.rulesTokens,
    })
  }
  if (fittedRules.lines.length > 0) {
    blocks.push(personalizationBlock(fittedRules.lines))
    stats.rules = fittedRules.lines.length
    stats.rulesTokens = fittedRules.tokens
  }

  // Последние факты темы по дате: список приходит от старых к свежим, под
  // потолок в токенах отбрасываются старшие.
  // Блок идёт и у темы без фактов: иначе модель в вызове ответа не узнаёт
  // даже названия предмета, которым занят диалог (находка ревьюера, PR #153).
  if (topic) {
    const recent = topic.facts.slice(-ASSEMBLE_CAPS.topicFacts)
    const fitted = fitLines([...recent].reverse(), ASSEMBLE_CAPS.topicTokens)
    const lines = [...fitted.lines].reverse()
    blocks.push(topicBlock(topic.title, lines))
    stats.topicFacts = lines.length
    stats.topicTokens = fitted.tokens
    // Считаем только то, что снял потолок в токенах: факты сверх потолка в
    // штуках сняты другой причиной, и называть её этой было бы неправдой.
    const dropped = recent.length - lines.length
    if (dropped > 0) {
      warnings.push({ code: 'topic_trimmed', dropped, capTokens: ASSEMBLE_CAPS.topicTokens })
    }
  }

  // Блок стратегии рабочей памяти — тот же, что в дне 10: сводка или факты
  // стратегии. Что из них есть, решил `memory.js`.
  if (summaryText) blocks.push(summaryBlock(summaryText))
  else if (factsText) blocks.push(factsBlock(factsText))
  if (transcript.length > 0) blocks.push(dialogBlock(transcript))
  blocks.push(requestBlock(prompt))

  return { input: blocks.join('\n\n'), warnings, stats }
}

/** Заголовки предупреждений записи — тексты монитора (раскладка, п. 12). */
const WARNINGS = {
  topic_facts_full: (w) => ({
    title: `Факты не записаны: в теме ${w.cap} из ${w.cap}`,
    detail: `потолок фактов темы; не записано ${w.dropped}`,
  }),
  topics_full: (w) => ({
    title: `${w.cap + 1}-я тема не записана`,
    detail: `потолок ${w.cap} тем на профиль; «${w.title}» не открыта`,
  }),
  rules_full: (w) => ({
    title: 'Правила не уложились в потолок',
    detail: `${w.cap} из ${w.cap}: ${w.dropped} новых имён не записаны`,
  }),
  no_topic: (w) => ({
    title: 'Тема не выбрана — факты не записаны',
    detail: `${w.dropped} фактов отброшено; выберите тему в шапке диалога`,
  }),
  parked_full: (w) => ({
    title: 'Припаркованные факты не уместились',
    detail: `потолок ${w.cap} фактов у ожидающего предложения; ${w.dropped} отброшено`,
  }),
  facts_over_call: (w) => ({
    title: 'Лишние факты вызова отброшены',
    detail: `${w.dropped} сверх потолка разбора`,
  }),
  rules_over_call: (w) => ({
    title: 'Лишние правила вызова отброшены',
    detail: `${w.dropped} сверх потолка разбора`,
  }),
  rules_trimmed: (w) => ({
    title: 'Правила не поместились в запрос',
    detail: `${w.dropped} старших правил сверх ${w.capTokens} токенов не ушли модели`,
  }),
  topic_trimmed: (w) => ({
    title: 'Часть фактов темы не поместилась в запрос',
    detail: `${w.dropped} старших фактов сверх ${w.capTokens} токенов не ушли модели`,
  }),
}

/** Предупреждение слоёв — всегда `warn`: запуск отвечает (раскладка, п. 12). */
export function emitWarning(emit, warning) {
  const build = WARNINGS[warning.code]
  if (!build) return
  const { title, detail } = build(warning)
  emit({ stage: 'warning', level: 'warn', title, detail, data: { ...warning } })
}

/**
 * Пополнение слоёв после ответа: один вызов на три результата — решение о
 * теме, факты, правила (ADR, п. 5.2). Умолчание «когда»: после каждого
 * ответа и только если ответ получен; порога пар и «раз в N обменов» нет.
 *
 * Отказ вызова запуск не валит: `warning`, пара в память не попадёт, якоря
 * нет и добрать нельзя. Возвращает цену вызова, признак оплаты (для слота
 * лимитера дня) и отчёт записи — из него запуск строит карточку вопроса.
 */
export async function replenish({
  sessions,
  sessionId,
  profileId,
  answerId,
  pair,
  emit,
  env,
  fetchImpl = fetch,
  ask = askSummary,
  now = Date.now,
  log = () => {},
}) {
  const idle = { called: false, spent: 0, paid: false, report: null }
  // Вызова нет без ответа: платить за пополнение памяти отказавшего запуска
  // не за что — пары «вопрос — ответ» не было.
  if (answerId === null || !sessions) return idle

  const state = sessions.sessionState(sessionId)
  if (!state || state.profileId !== profileId) return idle

  // Каждая часть входа режется своим потолком — сперва в строках, потом в
  // токенах: посторонний, набивший профиль, не растит цену хода остальным.
  const topicRows = sessions.topicsOf(profileId).slice(0, REPLENISH_CAPS.topicRows)
  const topicsFitted = fitLines(
    topicRows.map((t) => `${t.id} · ${t.title} · ${t.facts} фактов`),
    REPLENISH_CAPS.topicsTokens,
  )
  const topics = topicRows.slice(0, topicsFitted.lines.length)

  let topic = null
  if (state.topicId) {
    const facts = sessions
      .topicFactsOf(state.topicId, REPLENISH_CAPS.topicFacts)
      .map((f) => f.text)
    const fitted = fitLines([...facts].reverse(), REPLENISH_CAPS.topicTokens)
    topic = { title: state.topicTitle, facts: [...fitted.lines].reverse() }
  }

  const rules = sessions.rulesOf(profileId).slice(0, REPLENISH_CAPS.ruleRows)
  const rulesFitted = fitLines(
    rules.map((rule) => `${rule.key} — ${rule.value}`),
    REPLENISH_CAPS.rulesTokens,
  )

  let pending = null
  if (state.pending) {
    const parked = state.pending.facts.slice(-REPLENISH_CAPS.pendingFacts)
    const fitted = fitLines([...parked].reverse(), REPLENISH_CAPS.pendingTokens)
    pending = { title: state.pending.title, facts: [...fitted.lines].reverse() }
  }

  // Вход целиком — жёсткая граница, а не сумма потолков частей: метки ролей,
  // обёртки блоков и их пояснения весят сверх содержимого, и «≈ 4 950» из
  // записи держалось бы арифметикой, а не кодом. Если сумма всё же перевалила
  // за потолок, части сбрасываются от наименее ценной к более ценной: список
  // тем, затем факты активной темы, затем — сама пара. Решение о теме и
  // правила остаются: без них вызов теряет смысл.
  let pairCap = REPLENISH_CAPS.pairTokens
  let fittedPair = fitPair(pair, pairCap)
  let topicsSent = topics
  let topicSent = topic
  const build = () =>
    buildReplenishRequest({
      topics: topicsSent,
      topic: topicSent,
      rules: rulesFitted.lines,
      pending,
      pair: fittedPair.messages,
    })
  const measure = (built) => estimateTokens(built.system) + estimateTokens(built.input)
  let request = build()
  let requestSize = measure(request)
  const shed = []
  for (const drop of [
    () => {
      topicsSent = []
      return 'список тем'
    },
    () => {
      topicSent = topicSent ? { ...topicSent, facts: [] } : null
      return 'факты активной темы'
    },
  ]) {
    if (requestSize <= REPLENISH_CAPS.inputTokens) break
    shed.push(drop())
    request = build()
    requestSize = measure(request)
  }
  // Пара — единственная часть, которая может быть сколь угодно большой:
  // её режем, пока вход не уложится, а не надеемся на её собственный потолок.
  for (let i = 0; i < 8 && requestSize > REPLENISH_CAPS.inputTokens; i++) {
    pairCap = Math.max(200, pairCap - (requestSize - REPLENISH_CAPS.inputTokens) - 32)
    fittedPair = fitPair(pair, pairCap)
    request = build()
    requestSize = measure(request)
    if (!shed.includes('часть пары реплик')) shed.push('часть пары реплик')
  }
  const withinCap = requestSize <= REPLENISH_CAPS.inputTokens
  if (shed.length > 0 || fittedPair.dropped > 0 || fittedPair.trimmedChars > 0) {
    // Предупреждение называет то, что ушло на самом деле: обещать потолок,
    // которого не удержали, — хуже, чем не обещать ничего.
    const what = [
      ...shed,
      ...(fittedPair.dropped > 0 ? [`${fittedPair.dropped} старших реплик`] : []),
      ...(fittedPair.trimmedChars > 0 ? [`${fittedPair.trimmedChars} знаков ответа`] : []),
    ]
    emit({
      stage: 'warning',
      level: 'warn',
      title: 'Вход пополнения подрезан',
      detail:
        `${what.join(', ')} не ушли модели; вход вызова — ${requestSize} токенов ` +
        (withinCap
          ? `при потолке ${REPLENISH_CAPS.inputTokens}`
          : `сверх потолка ${REPLENISH_CAPS.inputTokens}: подрезать больше нечего`),
      data: {
        shed,
        dropped: fittedPair.dropped,
        trimmedChars: fittedPair.trimmedChars,
        requestTokens: requestSize,
        capTokens: REPLENISH_CAPS.inputTokens,
        withinCap,
      },
    })
  }
  const label = MODELS.find((m) => m.id === SUMMARY_PROVIDER)?.label ?? SUMMARY_PROVIDER
  const started = now()
  emit({
    stage: 'llm_call',
    title: 'Пополняю память профиля',
    detail: `${label} — при любой модели чата; ${requestSize} токенов входа, дельта до ${request.answerTokens}`,
    data: {
      provider: SUMMARY_PROVIDER,
      taskClass: SUMMARY_CLASS,
      requestTokens: requestSize,
      answerTokens: request.answerTokens,
      topics: topics.length,
      rules: rulesFitted.lines.length,
      topicFacts: topic?.facts.length ?? 0,
      pendingFacts: pending?.facts.length ?? 0,
    },
  })

  let answer
  try {
    answer = await ask(request, env, { fetchImpl })
  } catch (error) {
    log(`пополнение памяти: ${error.code ?? ''} ${error.message}`)
    emit({
      stage: 'warning',
      level: 'warn',
      title: 'Память профиля не пополнена',
      detail: `${explainRouterError(error)}\nпрежние правила и факты целы`,
      data: { code: error.code ?? null, status: error.status ?? null },
      durationMs: now() - started,
    })
    return { called: true, spent: 0, paid: !paidNothing(error), report: null }
  }

  const ms = now() - started
  const outputTokens = answer.usage.outputTokens ?? estimateTokens(answer.text)
  const spent = (answer.usage.inputTokens ?? requestSize) + outputTokens
  const delta = parseDelta(answer.text)

  const report = sessions.rememberLayers({
    sessionId,
    profileId,
    aliveId: answerId,
    topic: delta.topic,
    facts: delta.facts,
    rules: delta.rules,
    spentTokens: spent,
  })

  if (!report.ok) {
    // Профиль или диалог удалили, пока шёл вызов: в память не попадает
    // ничего, и цена вызова строк не воскрешает (ADR, п. 5.2).
    emit({
      stage: 'warning',
      level: 'warn',
      title: 'Память профиля не пополнена',
      detail:
        report.code === 'profile_gone'
          ? 'профиль удалили во время вызова — записывать некуда'
          : 'диалог удалили во время вызова — записывать некуда',
      data: { code: report.code },
      durationMs: ms,
    })
    return { called: true, spent, paid: true, report: null }
  }

  emit({
    stage: 'llm_result',
    title: `Память профиля: +${report.factsWritten} факта, +${report.rulesWritten} правил`,
    detail: `${answer.provider?.model ?? SUMMARY_PROVIDER}, ${seconds(ms)}, ${answer.usage.inputTokens ?? '?'} → ${answer.usage.outputTokens ?? '?'} токенов`,
    data: {
      provider: answer.provider,
      usage: answer.usage,
      facts: report.factsWritten,
      rules: report.rulesWritten,
      parked: report.factsParked,
    },
    durationMs: ms,
  })

  if (report.switched) {
    const from = report.switched.from ? `«${report.switched.from}»` : 'без темы'
    const how = report.switched.by === 'answer' ? 'по вашему ответу' : 'перешёл сам'
    emit({
      stage: 'planning',
      title: `Тема: ${from} → «${report.switched.to}» (${how})`,
      detail: `факты этой пары записаны в «${report.switched.to}»`,
      data: { ...report.switched, topicId: report.topicId },
    })
  }
  if (report.proposal) {
    emit({
      stage: 'planning',
      title: `Предлагаю тему «${report.proposal.title}»`,
      detail: `${report.proposal.facts} фактов ждут вашего ответа`,
      data: { ...report.proposal },
    })
  }
  if (report.waiting) {
    emit({
      stage: 'planning',
      title: 'Тема не сменена: ждёт вашего ответа',
      detail: 'руль у вас, пока вы не ответили',
      data: { pending: report.pending },
    })
  }
  for (const warning of [...delta.warnings, ...report.warnings]) emitWarning(emit, warning)

  return { called: true, spent, paid: true, report }
}

/** Умолчание политики: его подменяет тест и заменят правила владельца. */
export const defaultPolicy = { assemble, replenish }
