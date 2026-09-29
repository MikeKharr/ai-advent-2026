// Сборка исполнителей по реестру агентов. Раньше этот цикл жил в `server.js`
// и не исполнялся ни одним тестом: агент, попавший в реестр без метода,
// который зовёт сервис, ломал ручку `/v1/agents` только в проде — так девять
// дней (6–11, 13–15) остались без экрана состояния с PR #237 и до PR #269.
// Здесь он ровно тот же, но вызываемый из теста: держатель — тест «у каждого
// агента реестра есть describe(), и он отвечает» (`test/agents-map.test.js`).

import { createNewsAnalyst } from './agent.js'
import { createLayeredAgent, LAYERED_AGENT_ID } from './layered.js'
import { createMcpAgent, MCP_AGENT_ID } from './mcp/agent.js'
import { createPipelineAgent, PIPELINE_AGENT_ID } from './mcp/pipeline-agent.js'
import { STAGED15_MAX_TOKENS } from './params.js'
import {
  createStagedAgent,
  INVARIANT_AGENT_ID,
  PREPARE_STAGES,
  PROMPT_AGENT_ID,
  STAGED_AGENT_ID,
} from './staged.js'

/**
 * Реестр агентов → исполнители: аналитик новостей, слои памяти, машина
 * состояний, она же с инвариантами профиля, цикл с инструментами MCP и
 * цепочка без модели.
 */
export function createAgents({
  registry,
  archive,
  runs,
  sessions,
  stageLog,
  invariants,
  prompts,
  servers,
  env,
  log = () => {},
}) {
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
      agent = createPipelineAgent({ agent: entry, servers, runs, log })
    else if (entry.modelless) {
      log({ event: 'agent_skipped', agent: entry.id, reason: 'исполнителя для агента без модели нет' })
      continue
    } else if (entry.id === MCP_AGENT_ID)
      agent = createMcpAgent({ agent: entry, servers, runs, sessions, env, log })
    else if (entry.id === LAYERED_AGENT_ID)
      agent = createLayeredAgent({ agent: entry, runs, sessions, env, log })
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
        prompts,
        stages: PREPARE_STAGES,
        maxOutputTokens: STAGED15_MAX_TOKENS,
      })
    else agent = createNewsAnalyst({ agent: entry, archive, runs, sessions, env, log })
    agents.set(entry.id, agent)
  }
  return agents
}
