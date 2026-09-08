// Точка входа сервиса роутера. Битая конфигурация или отсутствующий
// секрет валят процесс здесь — до открытия порта.

import { readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './src/config.js'
import { createLedger } from './src/ledger.js'
import { createStaticRegistry } from './src/registry.js'
import { createRouter } from './src/router.js'
import { createService } from './src/service.js'

const here = dirname(fileURLToPath(import.meta.url))
const configDir = join(here, 'config')
const readJson = (name) => JSON.parse(readFileSync(join(configDir, name), 'utf8'))

const env = process.env
const config = loadConfig({
  // Локально можно подставить конфигурацию с ноутбучным провайдером,
  // не трогая продовую: ROUTER_PROVIDERS=providers.local.json.
  providers: readJson(env.ROUTER_PROVIDERS ?? 'providers.json'),
  classes: readJson('classes.json'),
  apps: readJson('apps.json'),
  env,
})

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))
const router = createRouter({
  config,
  registry: createStaticRegistry(config.providers),
  log,
  env,
})
const ledger = createLedger({
  file: env.ROUTER_LEDGER_FILE ?? join(here, 'data', 'ledger.jsonl'),
})
const handler = createService({ config, router, ledger, env, log })

const port = Number(env.PORT ?? 8081)
http.createServer(handler).listen(port, () => {
  log({
    event: 'start',
    port,
    providers: config.providers.map((p) => `${p.id}#${p.revision ?? 1} (${p.kind}, ${p.tier})`),
    apps: config.apps.apps.map((a) => a.id),
    ledgerSkippedLines: ledger.skippedLines(),
  })
})
