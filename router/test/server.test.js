// Стартовая запись журнала — единственное доказательство действующих потолков
// в проде (ADR 2026-09-16-0540): читается командой `docker compose logs`, без
// ключа администратора. Поэтому проверяется живым процессом: в записи есть
// числа лимитов и нет ничего из окружения.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const read = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'))
const providers = read('providers.json')
const apps = read('apps.json')

// Ключи фиктивные и различимые: если значение переменной окружения утечёт
// в запись, оно найдётся поиском по строке.
const SECRET_VALUE = 'ci-dummy-secret-value'
const secretNames = [
  ...providers.map((p) => p.secretEnv),
  apps.admin.secretEnv,
  ...apps.apps.map((a) => a.secretEnv),
].filter(Boolean)

/** Первая строка stdout настоящего `node server.js`, разобранная как JSON. */
async function startEvent() {
  const data = await mkdtemp(join(tmpdir(), 'router-start-'))
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      PORT: '0',
      ROUTER_LEDGER_FILE: join(data, 'ledger.jsonl'),
      ...Object.fromEntries(secretNames.map((name) => [name, SECRET_VALUE])),
    },
  })
  try {
    let out = ''
    for await (const chunk of child.stdout) {
      out += chunk
      const end = out.indexOf('\n')
      if (end !== -1) return { line: out.slice(0, end), entry: JSON.parse(out.slice(0, end)) }
    }
    throw new Error(`процесс не напечатал стартовую запись: ${out}`)
  } finally {
    child.kill()
  }
}

test('стартовая запись называет действующие лимиты приложений', async () => {
  const { entry } = await startEvent()
  assert.equal(entry.event, 'start')
  assert.deepEqual(
    entry.limits,
    Object.fromEntries(apps.apps.map((a) => [a.id, a.limits])),
  )
})

test('в стартовой записи нет ни имён переменных секретов, ни их значений', async () => {
  const { line } = await startEvent()
  assert.ok(!line.includes(SECRET_VALUE), 'значение переменной окружения попало в журнал')
  for (const name of secretNames)
    assert.ok(!line.includes(name), `имя переменной секрета ${name} попало в журнал`)
})
