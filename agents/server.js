// Точка входа сервиса агентов (ADR 2026-09-09-0854). Битая конфигурация
// или отсутствующий секрет валят процесс здесь — до открытия порта.

import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNewsAnalyst } from './src/agent.js'
import { parseEnv } from './src/env.js'
import { createInvariants } from './src/invariants.js'
import { createJobs, loadJobs } from './src/jobs/index.js'
import { createJobStore } from './src/jobs/store.js'
import { createLayeredAgent, LAYERED_AGENT_ID } from './src/layered.js'
import { createJobRunner, createMcpAgent, MCP_AGENT_ID } from './src/mcp/agent.js'
import { createPipelineAgent, PIPELINE_AGENT_ID } from './src/mcp/pipeline-agent.js'
import { loadServers } from './src/mcp/servers.js'
import { STAGED15_MAX_TOKENS } from './src/params.js'
import { createProfilePrompts, registryPrompts } from './src/prompts.js'
import { loadRegistry } from './src/registry.js'
import { createRuns } from './src/runs.js'
import { createService } from './src/service.js'
import { createSessions } from './src/sessions.js'
import { createStageLog } from './src/stage-log.js'
import {
  createStagedAgent,
  INVARIANT_AGENT_ID,
  PREPARE_STAGES,
  PROMPT_AGENT_ID,
  STAGED_AGENT_ID,
} from './src/staged.js'
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
const { servers: mcpServers, skipped: mcpSkipped } = loadServers(
  JSON.parse(readFileSync(join(here, 'config', 'mcp-servers.json'), 'utf8')),
)
for (const miss of mcpSkipped) log({ event: 'mcp_server_skipped', server: miss.name, reason: miss.reason })

/**
 * Реестр агентов → исполнители: аналитик новостей, слои памяти, машина
 * состояний, она же с инвариантами профиля, цикл с инструментами MCP и
 * цепочка без модели.
 */
const agents = new Map()
for (const entry of registry.values()) {
  let agent
  // Агент без модели (день 19) исполнителя здесь пока не имеет: цепочка
  // подключается отдельно. Развилка `else` ниже отдала бы его исполнителю
  // дня 6, и тот пошёл бы в роутер с `taskClass: null` и без системного
  // промпта — то есть запись в реестре без исполнителя становится не
  // «ничем», а чужим агентом, доходящим до платного вызова (находка гейта,
  // PR #233). Поэтому такой агент не регистрируется вовсе и в выдаче
  // `/v1/agents` не появляется, а строка в журнале называет причину.
  if (entry.id === PIPELINE_AGENT_ID)
    agent = createPipelineAgent({ agent: entry, servers: mcpServers, runs, log })
  else if (entry.modelless) {
    log({ event: 'agent_skipped', agent: entry.id, reason: 'исполнителя для агента без модели нет' })
    continue
  } else if (entry.id === MCP_AGENT_ID)
    agent = createMcpAgent({ agent: entry, servers: mcpServers, runs, env, log })
  else if (entry.id === LAYERED_AGENT_ID) agent = createLayeredAgent({ agent: entry, runs, sessions, env, log })
  else if (entry.id === STAGED_AGENT_ID)
    agent = createStagedAgent({ agent: entry, runs, sessions, stageLog, env, log })
  else if (entry.id === INVARIANT_AGENT_ID)
    agent = createStagedAgent({ agent: entry, runs, sessions, stageLog, env, log, invariants })
  // День 15 — та же машина с двумя опциями и своим потолком ответа
  // (ADR 2026-09-23-0646, пп. 2, 4 и 5).
  else if (entry.id === PROMPT_AGENT_ID)
    agent = createStagedAgent({
      agent: entry,
      runs,
      sessions,
      stageLog,
      env,
      log,
      invariants,
      prompts: profilePrompts,
      stages: PREPARE_STAGES,
      maxOutputTokens: STAGED15_MAX_TOKENS,
    })
  else agent = createNewsAnalyst({ agent: entry, archive, runs, sessions, env, log })
  agents.set(entry.id, agent)
}

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

const handler = createService({
  agents,
  archive,
  runs,
  sessions,
  stageLog,
  invariants,
  jobs,
  env,
  log,
})
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
