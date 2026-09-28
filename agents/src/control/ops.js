// Закрытый перечень операций поверхности управления
// (ADR 2026-09-28-1820, п. 8).
//
// Список ЗАКРЫТЫЙ. Операция не появляется здесь потому, что она есть в
// `/v1`: новая операция — строка в ADR и PR класса A. Всё, чего в таблице
// нет, диспетчер отвечает одним 404 без проброса куда бы то ни было.
//
// Каждая строка несёт: имя, вид (ресурс — чтение, инструмент — запись),
// признак «платная», разбор аргументов на границе и то, что под ней. Сервер
// MCP — НЕ доверенная сторона: аргументы разбираются здесь теми же
// разборщиками домена, что у `/v1`, и проверка принадлежности диалога
// профилю идёт до хранилища.
//
// Своего ответа это тоже касается: тела `/v1` наружу не отдаются, каждое
// поле названо здесь поимённо (образец — ADR 2026-09-23-1227, п. 5). Ключей
// и адресов в ответах нет.

import {
  isProfileId,
  isSessionId,
  parsePrompt,
  PROFILE_PROMPT_IDS,
  REVIEW_ROUNDS,
} from '../params.js'
import { PROMPT_AGENT_ID } from '../staged.js'

/**
 * Промпты, правимые через поверхность. Это `PROFILE_PROMPT_IDS` МИНУС
 * `stage.verify.invariants` — решение владельца при приёмке ADR: этот промпт
 * задаёт единственную проверку ответа над моделью, и правка через API её
 * выключала бы. На экране дня 15 правка остаётся.
 *
 * Вычитание, а не свой список: новый идентификатор в `params.js` иначе молча
 * не появился бы здесь, и расхождение двух списков заметить было бы нечем.
 */
export const CONTROL_UNEDITABLE_PROMPT_ID = 'stage.verify.invariants'
export const CONTROL_PROMPT_IDS = PROFILE_PROMPT_IDS.filter(
  (id) => id !== CONTROL_UNEDITABLE_PROMPT_ID,
)

const bad = (message) => ({ ok: false, status: 400, code: 'bad_input', message })
const notFound = (code) => ({ ok: false, status: 404, code })

/** Аргументы инструмента: объект и ничего кроме объявленных ключей. */
function fields(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bad('Аргументы должны быть объектом')
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return bad(`Неизвестный аргумент: ${key}`)
  }
  return { ok: true }
}

/** `profileId` в аргументах инструмента. Форма — тем же разборщиком, что у `/v1`. */
function profileArg(body) {
  if (!isProfileId(body?.profileId)) return bad('Аргумент profileId — идентификатор профиля')
  return { ok: true, profileId: body.profileId }
}

/** Профиль, живой на самом деле. Читается ДО любой платной работы. */
function liveProfile(sessions, profileId) {
  return sessions.profile(profileId) ?? null
}

// --- Виды ответов: поля названы поимённо, тела `/v1` наружу не идут --------

const profileRow = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: new Date(row.createdAt).toISOString(),
  lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  sessions: row.sessions,
})

const sessionRow = (row) => ({
  id: row.id,
  createdAt: new Date(row.createdAt).toISOString(),
  lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  topic: row.topicId ? { id: row.topicId, title: row.topicTitle } : null,
  messages: row.messages,
})

const messageRow = (row) => ({
  id: row.id,
  role: row.role,
  text: row.text,
  tokens: row.tokens,
  at: row.at,
  parentId: row.parentId,
})

const modelRow = (m) => ({ id: m.id, name: m.name, taskClass: m.taskClass, available: m.available })

/** Агент дня 15: под поверхностью работает он и только он. */
const promptAgent = (agents) => agents.get(PROMPT_AGENT_ID) ?? null

/**
 * Настройки профиля в том виде, в каком их присылает и принимает агент:
 * свой потолок ответа день 15 хранит под отдельным ключом, а принимает
 * обычным `maxTokens` (ADR 2026-09-23-0646, п. 5). Читать столбец мимо этого
 * вида — значит отдать разборщику ключ, которого он не знает.
 */
const settingsView = (agent, profile) =>
  agent.viewSettings ? agent.viewSettings(profile.stagedSettings) : { ...profile.stagedSettings }

/**
 * Поля настроек профиля, с которыми идёт запуск поверхности. Список ЗАКРЫТЫЙ
 * и явный: спред всего столбца протащил бы в запуск `system`, который агент
 * дня 15 не принимает вовсе (промпт ответа принадлежит профилю, а не входу).
 */
const RUN_SETTINGS = [
  'model',
  'reviewModel',
  'reviewRounds',
  'maxTokens',
  'temperature',
  'contextTokens',
  'summarizeAt',
  'strategy',
  'window',
  'factsTokens',
]

/**
 * Перечень. Порядок строк — порядок таблицы п. 8 ADR: пять ресурсов
 * (чтение) и семь инструментов (запись) — одиннадцать строк таблицы, из
 * которых одна несёт два имени (`prompt.set` и `prompt.reset`).
 */
export const OPS = [
  {
    name: 'profiles',
    kind: 'resource',
    paid: false,
    method: 'GET',
    pattern: /^\/control\/profiles$/,
    params: [],
    async run({ sessions }) {
      return { status: 200, body: { ok: true, profiles: sessions.profiles().map(profileRow) } }
    },
  },
  {
    name: 'profile',
    kind: 'resource',
    paid: false,
    method: 'GET',
    pattern: /^\/control\/profile\/([^/]+)$/,
    params: ['profileId'],
    async run({ sessions }, { params }) {
      if (!isProfileId(params.profileId)) return notFound('unknown_profile')
      const profile = liveProfile(sessions, params.profileId)
      if (!profile) return notFound('unknown_profile')
      return {
        status: 200,
        profileId: profile.id,
        body: {
          ok: true,
          profile: {
            id: profile.id,
            name: profile.name,
            // Настройки дня 15 — свой столбец профиля; общий блок дня 11
            // поверхности не принадлежит и наружу не идёт.
            settings: {
              model: profile.stagedSettings?.model ?? null,
              reviewModel: profile.stagedSettings?.reviewModel ?? null,
            },
            // `Пn` профиля. Инварианты продукта `I-n` — это другое слово:
            // они живут в git и в ADR, и API к ним не проектируется никому.
            invariants: profile.invariants.map((inv) => ({ num: inv.num, text: inv.text })),
            // Только переписанные промпты: чего здесь нет, то берётся из
            // умолчания реестра, и его отдаёт ресурс `prompts`.
            prompts: profile.prompts,
            // Живые диалоги: без их идентификаторов ни `history`, ни
            // `message.send` назвать диалог нечем, а создание диалога в
            // перечень не входит.
            sessions: profile.sessions.map(sessionRow),
          },
        },
      }
    },
  },
  {
    name: 'history',
    kind: 'resource',
    paid: false,
    method: 'GET',
    pattern: /^\/control\/history\/([^/]+)\/([^/]+)$/,
    params: ['profileId', 'sessionId'],
    async run({ sessions }, { params }) {
      const { profileId, sessionId } = params
      if (!isProfileId(profileId)) return notFound('unknown_profile')
      if (!isSessionId(sessionId)) return notFound('unknown_session')
      // Принадлежность — ДО чтения: номера в общей базе сквозные, и «не ваш
      // диалог» не должно отличаться от «нет такого» (ADR 2026-09-15-2024,
      // п. 3). Проверка здесь, а не в хранилище: хранилище отдаёт переписку
      // по одному идентификатору и профиля не спрашивает.
      if (sessions.sessionProfile(sessionId) !== profileId) return notFound('unknown_session')
      return {
        status: 200,
        profileId,
        body: {
          ok: true,
          sessionId,
          messages: sessions.history(sessionId).map(messageRow),
          head: sessions.head(sessionId),
        },
      }
    },
  },
  {
    name: 'models',
    kind: 'resource',
    paid: false,
    method: 'GET',
    pattern: /^\/control\/models$/,
    params: [],
    async run({ agents }) {
      const agent = promptAgent(agents)
      if (!agent) return notFound('no_agent')
      const described = await agent.describe()
      return { status: 200, body: { ok: true, models: described.models.map(modelRow) } }
    },
  },
  {
    name: 'prompts',
    kind: 'resource',
    paid: false,
    method: 'GET',
    pattern: /^\/control\/prompts\/([^/]+)$/,
    params: ['profileId'],
    async run({ sessions, agents }, { params }) {
      if (!isProfileId(params.profileId)) return notFound('unknown_profile')
      const profile = liveProfile(sessions, params.profileId)
      if (!profile) return notFound('unknown_profile')
      const agent = promptAgent(agents)
      if (!agent) return notFound('no_agent')
      const described = await agent.describe()
      // Умолчание реестра ⊕ профиль: у каждого промпта названо, откуда взят
      // действующий текст, — иначе правку нельзя отличить от умолчания.
      const defaults = new Map()
      for (const stage of described.stages) {
        if (stage.promptId) defaults.set(stage.promptId, stage.prompt)
      }
      if (described.invariants) defaults.set('invariant.draft', described.invariants.prompt)
      const list = PROFILE_PROMPT_IDS.filter((id) => defaults.has(id)).map((id) => ({
        promptId: id,
        text: profile.prompts[id] ?? defaults.get(id),
        source: profile.prompts[id] === undefined ? 'registry' : 'profile',
        // Промпт проверяющего шага виден, но не правится: решение владельца.
        editable: CONTROL_PROMPT_IDS.includes(id),
      }))
      return { status: 200, profileId: profile.id, body: { ok: true, prompts: list } }
    },
  },

  // --- Инструменты (запись) ------------------------------------------------

  {
    name: 'message.send',
    kind: 'tool',
    paid: true,
    method: 'POST',
    pattern: /^\/control\/message\.send$/,
    params: [],
    // Текст сообщения посетителя. Он идёт в журнал по решению владельца при
    // приёмке ADR — и потому журнал так же чувствителен, как переписка.
    texts: (body) => ({ text: body.text }),
    parse(body) {
      const known = fields(body, ['profileId', 'sessionId', 'text', 'parentId'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      if (!isSessionId(body.sessionId)) return bad('Аргумент sessionId — идентификатор диалога')
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        return bad('Аргумент text — непустая строка')
      }
      return { ok: true, profileId: body.profileId }
    },
    /**
     * Всё, что видно ДО денег: живой профиль, настройки, принадлежность
     * диалога, занятость, потолки входа. Диспетчер зовёт это ПЕРЕД тем, как
     * занять слот суточного потолка, — иначе десять клиентских опечаток
     * выбирали бы потолок при нулевом расходе и выключали поверхность до
     * конца суток (находка reviewer, PR #254).
     *
     * I-4 при этом цел: здесь нет ни `runs.create`, ни `agent.execute` —
     * только разбор. Деньги начинаются в `run`, ниже слота.
     */
    precheck({ sessions, agents }, { body }) {
      const agent = promptAgent(agents)
      if (!agent) return notFound('no_agent')
      const profile = liveProfile(sessions, body.profileId)
      if (!profile) return notFound('unknown_profile')
      // Запуск идёт по настройкам ПРОФИЛЯ, а не по умолчаниям реестра: иначе
      // `models.set` ничего бы не значил — поверхность ставила бы модель, а
      // отвечала бы другой. Кругов проверки в столбце может не быть (профиль
      // заведён до дня 13): тогда берётся умолчание, и оно же — число слотов.
      const settings = settingsView(agent, profile)
      const fromProfile = {}
      for (const key of RUN_SETTINGS) {
        if (settings[key] !== undefined && settings[key] !== null) fromProfile[key] = settings[key]
      }
      fromProfile.reviewRounds = fromProfile.reviewRounds ?? REVIEW_ROUNDS.default
      // Разбор входа запуска — тот же, что у `/v1`: принадлежность диалога
      // профилю, занятость диалога и все потолки проверяет он.
      const parsed = agent.parseInput({
        ...fromProfile,
        profileId: body.profileId,
        sessionId: body.sessionId,
        prompt: body.text,
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
      })
      if (!parsed.ok) return { ok: false, status: 400, code: 'bad_input', message: parsed.message }
      return { ok: true, input: parsed.input }
    },

    async run({ agents, runs, log }, { precheck }) {
      const agent = promptAgent(agents)
      // Слот суточного потолка уже занят диспетчером: всё ниже — деньги.
      const run = runs.create({ agent, input: precheck.input })
      agent.hold(precheck.input.sessionId)
      const ended = new Promise((resolve) => {
        const off = runs.subscribe(run.id, (message) => {
          if (message.type !== 'end') return
          off()
          resolve(message)
        })
      })
      agent.execute(run).catch((error) => log(`поверхность: запуск ${run.id}: ${error.message}`))
      const end = await ended
      if (end.status !== 'succeeded') {
        return {
          ok: false,
          status: 502,
          code: 'run_failed',
          message: end.error?.message ?? 'Запуск не удался',
        }
      }
      return {
        status: 200,
        body: {
          ok: true,
          runId: run.id,
          // Ответ с названным нарушением инварианта не отдаётся никому —
          // ни экрану дня 15, ни поверхности (решение владельца дня 14).
          answer: end.result?.answer ?? null,
          withheld: end.result?.withheld
            ? { invariants: end.result.withheld.invariants, round: end.result.withheld.round }
            : null,
        },
      }
    },
  },
  {
    name: 'prompt.set',
    kind: 'tool',
    paid: false,
    method: 'POST',
    pattern: /^\/control\/prompt\.set$/,
    params: [],
    texts: (body) => ({ text: body.text }),
    parse(body) {
      const known = fields(body, ['profileId', 'promptId', 'text'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      // Закрытый список БЕЗ промпта проверяющего шага. Отказ — 404
      // `unknown_prompt`, тот же, что у неизвестного идентификатора: «нельзя»
      // и «нет такого» здесь одно и то же для клиента.
      if (!CONTROL_PROMPT_IDS.includes(body.promptId)) {
        return { ok: false, status: 404, code: 'unknown_prompt' }
      }
      const text = parsePrompt(body.text)
      if (!text.ok) return bad(text.message)
      return { ok: true, profileId: body.profileId, text: text.text }
    },
    async run({ sessions }, { body, parsed }) {
      const saved = sessions.savePrompt({
        profileId: body.profileId,
        promptId: body.promptId,
        text: parsed.text,
      })
      if (!saved.ok) return notFound('unknown_profile')
      return {
        status: 200,
        profileId: body.profileId,
        body: { ok: true, promptId: body.promptId },
      }
    },
  },
  {
    name: 'prompt.reset',
    kind: 'tool',
    paid: false,
    method: 'POST',
    pattern: /^\/control\/prompt\.reset$/,
    params: [],
    parse(body) {
      const known = fields(body, ['profileId', 'promptId'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      if (!CONTROL_PROMPT_IDS.includes(body.promptId)) {
        return { ok: false, status: 404, code: 'unknown_prompt' }
      }
      return { ok: true, profileId: body.profileId }
    },
    async run({ sessions }, { body }) {
      const dropped = sessions.deletePrompt({ profileId: body.profileId, promptId: body.promptId })
      if (!dropped.ok) return notFound('unknown_profile')
      return {
        status: 200,
        profileId: body.profileId,
        body: { ok: true, promptId: body.promptId, removed: dropped.removed },
      }
    },
  },
  {
    name: 'invariant.draft',
    kind: 'tool',
    paid: true,
    method: 'POST',
    pattern: /^\/control\/invariant\.draft$/,
    params: [],
    texts: (body) => ({ text: body.text }),
    parse(body) {
      const known = fields(body, ['profileId', 'text'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        return bad('Аргумент text — непустая строка')
      }
      return { ok: true, profileId: body.profileId }
    },
    /**
     * Те же проверки, что делает сам формулировщик перед вызовом модели, —
     * и это буквально его функция, а не копия: `preflightDraft` вынесен из
     * `draft` и им же зовётся первой строкой. Разойтись им нечем.
     */
    precheck({ invariants }, { body }) {
      if (!invariants) return notFound('no_invariants')
      const pre = invariants.preflightDraft({ profileId: body.profileId, text: body.text })
      if (!pre.ok) {
        return { ok: false, status: pre.status, code: pre.code, message: pre.message }
      }
      return { ok: true }
    },

    async run({ invariants, env, fetchImpl }, { body }) {
      // Слот суточного потолка уже занят диспетчером: ниже начинаются деньги.
      const result = await invariants.draft({
        profileId: body.profileId,
        text: body.text,
        env,
        fetchImpl,
      })
      if (!result.ok) {
        return {
          ok: false,
          status: result.status,
          code: result.code,
          message: result.message,
          // Оплачен ли ход — говорится честно и здесь тоже.
          paid: result.paid === true,
        }
      }
      return { status: 200, profileId: body.profileId, body: { ok: true, draft: result.draft } }
    },
  },
  {
    name: 'invariant.accept',
    kind: 'tool',
    paid: false,
    method: 'POST',
    pattern: /^\/control\/invariant\.accept$/,
    params: [],
    texts: (body) => ({ text: body.text }),
    parse(body) {
      // Билет НЕ обходится: он проверяется тем же `checkTicket` внутри
      // `invariants.accept`, и ключ билетов живёт только в памяти процесса.
      const known = fields(body, ['profileId', 'text', 'ticket'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      if (typeof body.text !== 'string') return bad('Аргумент text — строка')
      if (typeof body.ticket !== 'string' || body.ticket === '') {
        return bad('Аргумент ticket — строка билета формулировщика')
      }
      return { ok: true, profileId: body.profileId }
    },
    async run({ invariants }, { body }) {
      if (!invariants) return notFound('no_invariants')
      const result = invariants.accept({
        profileId: body.profileId,
        text: body.text,
        ticket: body.ticket,
      })
      if (!result.ok) {
        return { ok: false, status: result.status, code: result.code, message: result.message }
      }
      return {
        status: 200,
        profileId: body.profileId,
        body: {
          ok: true,
          invariant: { num: result.invariant.num, text: result.invariant.text },
        },
      }
    },
  },
  {
    name: 'invariant.delete',
    kind: 'tool',
    paid: false,
    method: 'POST',
    pattern: /^\/control\/invariant\.delete$/,
    params: [],
    parse(body) {
      const known = fields(body, ['profileId', 'num'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      if (!Number.isInteger(body.num) || body.num <= 0 || body.num > 999_999_999) {
        return bad('Аргумент num — номер инварианта')
      }
      return { ok: true, profileId: body.profileId }
    },
    async run({ sessions }, { body }) {
      if (!sessions.deleteInvariant({ profileId: body.profileId, num: body.num })) {
        return notFound('unknown_invariant')
      }
      return { status: 200, profileId: body.profileId, body: { ok: true, num: body.num } }
    },
  },
  {
    name: 'models.set',
    kind: 'tool',
    paid: false,
    method: 'POST',
    pattern: /^\/control\/models\.set$/,
    params: [],
    parse(body) {
      const known = fields(body, ['profileId', 'model', 'reviewModel'])
      if (!known.ok) return known
      const profile = profileArg(body)
      if (!profile.ok) return profile
      if (body.model === undefined && body.reviewModel === undefined) {
        return bad('Нечего менять: нужен model или reviewModel')
      }
      return { ok: true, profileId: body.profileId }
    },
    async run({ sessions, agents }, { body }) {
      const agent = promptAgent(agents)
      if (!agent) return notFound('no_agent')
      const profile = liveProfile(sessions, body.profileId)
      if (!profile) return notFound('unknown_profile')
      // Слияние с тем, что уже стоит: поверхность правит ДВЕ настройки, и
      // запись только их стёрла бы остальной столбец профиля молча.
      const merged = settingsView(agent, profile)
      if (body.model !== undefined) merged.model = body.model
      if (body.reviewModel !== undefined) merged.reviewModel = body.reviewModel
      // Разбор — тот же, что у `/v1`: модель, годная в настройках, обязана
      // быть годной в запуске. Явный провайдер сюда не проходит — список
      // моделей закрыт ярусами класса у роутера.
      const settings = agent.parseSettings(merged)
      if (!settings.ok) {
        return { ok: false, status: 400, code: 'bad_input', message: settings.message }
      }
      if (!sessions.saveStagedSettings({ profileId: body.profileId, settings: settings.settings })) {
        return notFound('unknown_profile')
      }
      return {
        status: 200,
        profileId: body.profileId,
        body: {
          ok: true,
          settings: {
            model: settings.settings.model ?? null,
            reviewModel: settings.settings.reviewModel ?? null,
          },
        },
      }
    },
  },
]

/** Имена перечня — для теста равенства и для сервера MCP захода 2. */
export const OP_NAMES = OPS.map((op) => op.name)
