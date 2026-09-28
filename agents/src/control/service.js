// Диспетчер поверхности управления (ADR 2026-09-28-1820, п. 1 и 2).
//
// Это ВТОРОЙ слушатель процесса `agents`, а не путь внутри `/v1`. Довод —
// режим отказа: у `/v1` разрешение по умолчанию «всё под `AGENT_KEY`», здесь
// запрет по умолчанию «только перечень под `CONTROL_KEY`», и одна поверхность
// не может иметь двух режимов отказа.
//
// Ссылки на обработчик `/v1` у этого модуля нет вовсе: пробросить запрос
// туда ему нечем. Это не проверка, которую можно снять, а отсутствие пути.
//
// Порядок проверок сверху вниз — это порядок исполнения, и он же инвариант
// I-4: окно отказов → ключ → перечень → аргументы → суточный потолок платных
// → работа. Платная операция не начинается раньше, чем занят слот потолка.
//
// Данные под поверхностью — те же функции хранилища и агента изнутри
// процесса, а не ручки `/v1` по HTTP: иначе `CONTROL_KEY` пришлось бы
// дополнять `AGENT_KEY`.

import { createControlKey } from './key.js'
import { OPS } from './ops.js'

/** Тело запроса — тот же потолок, что у `/v1`. */
const MAX_BODY = 64 * 1024

/** Имя операции в журнале до того, как путь разобран: имени ещё нет. */
const NO_OP = '-'

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('тело больше 64 КБ'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Адрес соединения. Это ИМЕННО адрес сокета, а не первый элемент
 * `X-Forwarded-For`: маршрута через прокси у поверхности нет, а доверие
 * заголовку было бы дефектом дня 5 второй раз.
 *
 * Почему у этой строки есть держатель, а не только комментарий: `remote`
 * лежит в `control_log` В ОДНОЙ СТРОКЕ с текстом сообщения посетителя и
 * живёт там 30 суток. Подставной адрес в такой строке — это не путаница в
 * учёте, а ложная привязка чужого текста к чужому адресу; и он же ломает
 * окно отказов, потому что каждая попытка залпа получала бы своё ведро.
 *
 * Условие прихода `X-Forwarded-For` названо живым в самом ADR («путь наружу
 * — две строки `Caddyfile`, и страж их не запретит»), а каждый маршрут дня
 * ставит `header_up X-Forwarded-For {client_ip}`. То есть отказ достижим без
 * единой правки этого файла — значит комментарием он не держится (находка
 * compliance, PR #254).
 */
const remoteOf = (req) => req.socket?.remoteAddress ?? null

export function createControlService({
  sessions = null,
  invariants = null,
  agents,
  runs,
  controlLog,
  env,
  log,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const key = createControlKey({
    key: env.CONTROL_KEY,
    failsPerMin: env.CONTROL_FAILS_PER_MIN,
    now,
  })

  const deps = { sessions, invariants, agents, runs, env, fetchImpl, log }

  /** Строка журнала обращений и строка журнала процесса — на каждый вызов. */
  const record = ({ op, outcome, started, paid, profileId, remote, texts }) => {
    const ms = now() - started
    try {
      controlLog?.write({ at: now(), op, outcome, ms, paid, profileId, remote, texts })
    } catch (error) {
      // Отказ записи не должен отменять ответ, но и молчать о нём нельзя:
      // журнал обращений — обязанность, а не удобство.
      log({ event: 'control_log_failed', op, reason: error.message })
    }
    log({ event: 'control', op, outcome, ms, paid, remote })
  }

  return async function handler(req, res) {
    const started = now()
    const remote = remoteOf(req)
    try {
      let url
      try {
        url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
      } catch {
        record({ op: NO_OP, outcome: 'bad_request', started, paid: false, remote })
        return send(res, 400, { ok: false, code: 'bad_request' })
      }

      // 1. Окно отказов и ключ. Внутри — сначала окно, затем сравнение.
      const entry = key.check({ req, url, remote })
      if (!entry.ok) {
        // Отказ пишется ТОЙ ЖЕ строкой, что успех. Предъявленного значения
        // в ней нет: `record` его не принимает.
        record({ op: NO_OP, outcome: entry.outcome, started, paid: false, remote })
        return send(res, entry.status, { ok: false, code: entry.code }, entry.headers ?? {})
      }

      // 2. Перечень. Путь, метод или имя вне таблицы — один 404, и ничего
      //    кроме: ни подсказки, ни проброса.
      const op = OPS.find((candidate) => candidate.pattern.test(url.pathname))
      if (!op || op.method !== req.method) {
        record({ op: NO_OP, outcome: 'not_found', started, paid: false, remote })
        return send(res, 404, { ok: false, code: 'not_found' })
      }

      // Хранилище — общее у всех операций перечня: без него отвечать нечем.
      if (!sessions) {
        record({ op: op.name, outcome: 'no_sessions', started, paid: op.paid, remote })
        return send(res, 503, { ok: false, code: 'no_sessions' })
      }

      const values = op.pattern.exec(url.pathname).slice(1)
      const params = Object.fromEntries(op.params.map((name, i) => [name, values[i]]))

      // 3. Аргументы — своя проверка на границе. Сервер MCP не доверенная
      //    сторона, и «уже проверено выше» здесь не бывает.
      let body = {}
      let parsed = { ok: true }
      if (op.kind === 'tool') {
        try {
          body = JSON.parse(await readBody(req))
        } catch (error) {
          record({ op: op.name, outcome: 'bad_json', started, paid: op.paid, remote })
          return send(res, 400, {
            ok: false,
            code: 'bad_json',
            message: error.message === 'тело больше 64 КБ' ? error.message : 'тело не JSON',
          })
        }
        parsed = op.parse(body)
        if (!parsed.ok) {
          record({
            op: op.name,
            outcome: parsed.code ?? 'bad_input',
            started,
            paid: op.paid,
            remote,
            profileId: typeof body?.profileId === 'string' ? body.profileId : null,
          })
          return send(res, parsed.status ?? 400, {
            ok: false,
            code: parsed.code ?? 'bad_input',
            ...(parsed.message ? { message: parsed.message } : {}),
          })
        }
      }

      // 4. Суточный потолок платных операций — ДО работы, и слот занимается
      //    ДО вызова модели, а не после (I-4). Слот не возвращается при
      //    отказе поставщика: ход мог быть оплачен, и «не получилось» не
      //    делает его бесплатным.
      if (op.paid) {
        // Нет журнала — нет и счётчика: это ОДИН объект. Поэтому платная
        // операция без журнала не выполняется вовсе, а не выполняется без
        // потолка. Иначе отказ базы на томе МОЛЧА снимал бы денежную защиту —
        // ровно в той поломке, о которой узнать нечем.
        if (!controlLog) {
          record({ op: op.name, outcome: 'no_control_log', started, paid: true, remote })
          return send(res, 503, {
            ok: false,
            code: 'no_control_log',
            message: 'Журнал поверхности недоступен: платные операции выключены',
          })
        }
        if (controlLog.paidToday() >= env.CONTROL_MAX_DAILY_CALLS) {
          record({
            op: op.name,
            outcome: 'daily_cap',
            started,
            paid: true,
            remote,
            profileId: parsed.profileId ?? null,
          })
          return send(res, 429, {
            ok: false,
            code: 'daily_cap',
            message: `Платных операций поверхности за сутки не больше ${env.CONTROL_MAX_DAILY_CALLS}`,
          })
        }
        controlLog.takePaidSlot()
      }

      // 5. Работа. Ниже этой строки платного вызова без занятого слота нет.
      const result = await op.run(deps, { params, body, parsed })
      const outcome = result.ok === false ? (result.code ?? 'error') : 'ok'
      record({
        op: op.name,
        outcome,
        started,
        paid: op.paid,
        remote,
        profileId: result.profileId ?? parsed.profileId ?? params.profileId ?? null,
        // Тексты аргументов — по решению владельца при приёмке ADR. Их
        // объявляет сама операция; ключа среди них нет ни у одной.
        texts: op.texts ? op.texts(body) : null,
      })
      if (result.ok === false) {
        return send(res, result.status, {
          ok: false,
          code: result.code,
          ...(result.message ? { message: result.message } : {}),
          ...(result.paid === true ? { paid: true } : {}),
        })
      }
      return send(res, result.status, result.body)
    } catch (error) {
      record({ op: NO_OP, outcome: 'internal', started, paid: false, remote })
      log({ event: 'control_error', reason: error.message })
      if (!res.headersSent) send(res, 500, { ok: false, code: 'internal' })
      else res.end()
    }
  }
}

/**
 * Состояние поверхности для `/healthz` основного слушателя. Выключенная
 * поверхность называет ПРИЧИНУ словами той записи, которую разбор окружения
 * положил в замечания: оператор идёт сюда именно за тем, чинить ли ему строку
 * в `agents.env` или ключ клиента.
 */
export function controlHealth(env, notes = []) {
  if (env.CONTROL_KEY === null) {
    const note = notes.find((n) => String(n.event).startsWith('control_key_'))
    return `выключена: ${note ? note.message : 'CONTROL_KEY не задан'}`
  }
  return { port: env.CONTROL_PORT, ops: OPS.length, failsPerMin: env.CONTROL_FAILS_PER_MIN }
}
