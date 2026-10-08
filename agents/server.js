// Точка входа сервиса агентов (ADR 2026-09-09-0854). Битая конфигурация
// или отсутствующий секрет валят процесс здесь — до открытия порта.

import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgents } from './src/agents-map.js'
import { createControlLog } from './src/control/log.js'
import {
  controlHealth,
  createControlService,
  startControlListener,
} from './src/control/service.js'
import { parseEnv } from './src/env.js'
import { createInvariants } from './src/invariants.js'
import { createJobs, loadJobs } from './src/jobs/index.js'
import { createJobStore } from './src/jobs/store.js'
import { createJobRunner } from './src/mcp/agent.js'
import { assertAgentServers, loadServers } from './src/mcp/servers.js'
import { createModelKeys, parseModelKeys } from './src/model-keys.js'
import { createProfilePrompts, registryPrompts } from './src/prompts.js'
import { loadRegistry } from './src/registry.js'
import { createRuns } from './src/runs.js'
import { createService } from './src/service.js'
import { createSessions } from './src/sessions.js'
import { createStageLog } from './src/stage-log.js'
import { createArchiveTool } from './src/tools/archive/index.js'

const here = dirname(fileURLToPath(import.meta.url))

const { env, errors, notes } = parseEnv()
if (errors.length > 0) {
  for (const message of errors) console.error(`конфигурация: ${message}`)
  process.exit(1)
}

const log = (entry) => console.log(typeof entry === 'string' ? entry : JSON.stringify(entry))
// Замечания конфигурации, которые старт не валят: молча их не бывает.
for (const note of notes) log(note)
const registry = loadRegistry(JSON.parse(readFileSync(join(here, 'config', 'agents.json'), 'utf8')))
const archive = createArchiveTool({ env, log })
const runs = createRuns({ ttlMs: env.RUN_TTL_MINUTES * 60_000 })
// Диалоги переживают перезапуск: они на томе, а не в памяти процесса.
// Битый файл базы не должен ронять сервис: в нём живут ещё и запуски дня 6,
// которому память диалога не нужна вовсе. Без базы сервис работает как
// день 6, а день 7 получает честный отказ (`503 no_sessions`).
let sessions = null
let sweptOnStart = 0
try {
  sessions = createSessions({
    file: env.SESSIONS_FILE,
    ttlMs: env.SESSION_TTL_HOURS * 3600_000,
    // Профили дня 11: свой срок и свои потолки (ADR 2026-09-15-2024, п. 2).
    // Числа идут из окружения сюда, а не берутся умолчанием хранилища:
    // иначе `/healthz` и отказы страницы обещали бы одно, а база держала
    // другое.
    profileTtlMs: env.PROFILE_TTL_DAYS * 24 * 3600_000,
    profileCap: env.PROFILE_CAP,
    sessionCap: env.PROFILE_SESSION_CAP,
    log,
  })
  // Уборка на старте — заодно проверка, что база читается целиком: файл
  // может открыться заголовком и рассыпаться на странице данных. Отказ
  // здесь означает, что 30-часовой срок хранения соблюдать нечем, и
  // притворяться работающей памятью нельзя.
  sweptOnStart = sessions.sweep()
} catch (error) {
  try {
    sessions?.close()
  } catch {}
  sessions = null
  log({ event: 'sessions_off', file: env.SESSIONS_FILE, reason: error.message })
}

// Журнал этапов дня 13 — файл на томе агентов. Отказ записи запуск не валит:
// он живёт в `stage-log.js` и отвечает `false`.
const stageLog = createStageLog({ file: env.STAGE_LOG_FILE, log })

// Шов дня 14: один объект на сервис. Ключ билетов создаётся при старте и
// нигде не хранится (ADR 2026-09-22-0827, п. 3).
const invariants = sessions ? createInvariants({ sessions }) : null

// Шов дня 15: промпты профиля из таблицы. Без хранилища — умолчание реестра;
// запуск у такого агента всё равно не начнётся («Память профилей недоступна»),
// но и падать на чтении промптов ему незачем.
const profilePrompts = sessions ? createProfilePrompts({ sessions }) : registryPrompts

// Реестр серверов MCP (ADR 2026-09-28-0736, п. 1). Сервер без адреса в
// окружении в реестр не попадает — и это называется в журнале, иначе день 20
// молча остался бы без половины инструментов.
const { servers: mcpServers, skipped: mcpSkipped, known: mcpKnown } = loadServers(
  JSON.parse(readFileSync(join(here, 'config', 'mcp-servers.json'), 'utf8')),
)
for (const miss of mcpSkipped) log({ event: 'mcp_server_skipped', server: miss.name, reason: miss.reason })
// Отбор серверов по агенту (ADR 2026-09-29-0236, п. 6): реестр ОДИН и уезжает
// в точки входа целиком, а сужает его до списка агента каждая сама — там, где
// её держат тесты. Здесь остаётся сводка двух файлов конфигурации: имя
// сервера, которого нет в реестре серверов, валит процесс до открытия порта, а
// не оборачивается «инструментов нет» в проде.
assertAgentServers(registry, mcpKnown)

const agents = createAgents({
  registry,
  archive,
  runs,
  sessions,
  stageLog,
  invariants,
  prompts: profilePrompts,
  servers: mcpServers,
  env,
  log,
})

// Планировщик дня 18. Три условия, каждое называется в `/healthz` порознь:
// файл работ, том и ключ приложения `scheduler`. Исполнитель запуска —
// цикл с моделью — подключается отдельно; пока его нет, работа не стартует, и
// ручка это говорит прямо (503 `no_executor`), а не отвечает успехом.
let jobs = null
const jobsFile = join(here, 'config', 'jobs.json')
if (existsSync(jobsFile)) {
  let jobStore = null
  try {
    jobStore = createJobStore({ file: env.JOBS_FILE })
    // Запуск, оборванный выкаткой, иначе висел бы `running` вечно и держал
    // бы «работа идёт» (ADR 2026-09-28-0736, разбор вопроса 2).
    const interrupted = jobStore.markInterruptedOnStart()
    if (interrupted > 0) log({ event: 'jobs_interrupted_on_start', runs: interrupted })
  } catch (error) {
    console.error(`запуски планировщика: ${error.message}`)
  }
  try {
    jobs = createJobs({
      jobs: loadJobs(JSON.parse(readFileSync(jobsFile, 'utf8'))),
      store: jobStore,
      schedulerKey: env.ROUTER_APP_KEY_SCHEDULER,
      // Исполнитель запуска. Ключ приложения он выбирает сам — `scheduler`,
      // а не `agents` (`src/mcp/agent.js`, `createJobRunner`).
      runJob: createJobRunner({ registry, servers: mcpServers, runs, env, log }),
      log,
    })
  } catch (error) {
    // Битый файл работ — отказ планировщика, а не отказ сервиса: дни 6–15
    // к нему отношения не имеют.
    console.error(`реестр работ: ${error.message}`)
  }
}

// Готовые запуски удаляются по TTL; незавершённые живут до терминального события.
setInterval(() => runs.sweep(), 60_000).unref()
// Срок хранения диалогов проверяется реже: он измеряется часами.
if (sessions) {
  setInterval(() => {
    try {
      const removed = sessions.sweep()
      if (removed > 0) log({ event: 'sessions_swept', removed })
      // Срок хранения журнала этапов — тот же, что у переписки (ADR
      // 2026-09-21-1747, п. 7): строки снимает та же уборка.
      const rows = stageLog.prune(
        new Date(Date.now() - env.SESSION_TTL_HOURS * 3600_000).toISOString(),
      )
      if (rows > 0) log({ event: 'stage_log_pruned', rows })
    } catch (error) {
      console.error(`уборка диалогов: ${error.message}`)
    }
  }, 10 * 60_000).unref()
}

// Поверхность управления инструментами агентов — ВТОРОЙ слушатель этого
// процесса (ADR 2026-09-28-1820, п. 1). Свой порт, свой ключ, свой перечень
// операций, свой режим отказа. Операции зовут те же функции хранилища и
// агента изнутри процесса, а не ручки `/v1` по HTTP.
//
// Журнал обращений держит ТЕКСТЫ сообщений посетителей (решение владельца при
// приёмке ADR), поэтому его отказ — не мелочь: без журнала поверхность
// работает, но обязанность «кто и что делал» не исполняется, и это
// называется в журнале процесса.
let controlLog = null
try {
  controlLog = createControlLog({ file: env.CONTROL_LOG_FILE, keepDays: env.CONTROL_LOG_DAYS })
} catch (error) {
  log({ event: 'control_log_off', file: env.CONTROL_LOG_FILE, reason: error.message })
}

// Именные ключи модели без встроенных отказов (ADR 2026-10-07-1349, п. 2).
// Негодные записи отбрасываются с замечанием в журнал: опечатка в ключе
// одного человека не должна уносить сервис, в котором живут дни 6–25.
// Пустая переменная — возможности нет вовсе, и это нормальное состояние:
// ключи заводит владелец руками (п. 6), агенту их копировать некуда.
const parsedModelKeys = parseModelKeys(env.MODEL_KEYS)
for (const note of parsedModelKeys.notes) log(note)
const modelKeys = createModelKeys({ entries: parsedModelKeys.entries })
log({ event: 'model_keys', names: modelKeys.size(), enabled: modelKeys.enabled })

const handler = createService({
  agents,
  archive,
  runs,
  sessions,
  stageLog,
  invariants,
  jobs,
  modelKeys,
  env,
  log,
  controlState: () => controlHealth(env, notes),
})
startControlListener({
  handler: createControlService({
    sessions,
    invariants,
    agents,
    runs,
    controlLog,
    env,
    log,
  }),
  port: env.CONTROL_PORT,
  log,
  onReady: () =>
    log({ event: 'control_start', port: env.CONTROL_PORT, control: controlHealth(env, notes) }),
})

// Уборка журнала обращений: 30 суток (решение владельца при приёмке ADR).
// Держатель срока — эта строка и тест уборки: тексты посетителей не остаются
// на поверхности дольше названного срока.
if (controlLog) {
  const sweepControl = () => {
    try {
      const rows = controlLog.prune()
      if (rows > 0) log({ event: 'control_log_pruned', rows })
    } catch (error) {
      console.error(`уборка журнала поверхности: ${error.message}`)
    }
  }
  sweepControl()
  setInterval(sweepControl, 6 * 3600_000).unref()
}

http.createServer(handler).listen(env.PORT, () => {
  log({
    event: 'start',
    port: env.PORT,
    agents: [...agents.values()].map((a) => `${a.id}@${a.version}`),
    store: env.STORE_FILE,
    archive: archive.size(),
    skipped: archive.skippedOnLoad(),
    sessions: sessions
      ? { ...sessions.stats(), ttlHours: env.SESSION_TTL_HOURS, sweptOnStart }
      : 'выключены: хранилище недоступно',
  })
})
