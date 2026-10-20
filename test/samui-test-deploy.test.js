// Forced command ключа выкатки стенда samui-villas (ADR
// 2026-10-20-1621-samui-test-forced-command). Держит две вещи:
//
// 1. Снаружи принимается только digest. Любая другая строка
//    SSH_ORIGINAL_COMMAND, пустой stdin вместо токена и отсутствие `.env`
//    стенда — отказ с кодом 64 до первого вызова docker. Проверяется прогоном
//    скрипта: до docker он в этих случаях не доходит, поэтому Docker тесту не
//    нужен.
// 2. Каждый вызов docker — в чистом окружении (`env -i` с фиксированными PATH
//    и HOME): иначе Compose взял бы переменную из окружения `advent` раньше,
//    чем из `.env` стенда. Проверяется текстом скрипта: прогон с настоящим
//    docker и чужим окружением требовал бы образа стенда и его `.env`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'deploy/samui-test-deploy.sh')
const TEXT = readFileSync(SCRIPT, 'utf8')
const HEX = 'a'.repeat(64)
const TOKEN = 'ghs_placeholder0123456789\n'

/** Прогон скрипта в пустом HOME; `env` — только то, что прислал бы sshd. */
function run({ command, stdin = TOKEN, withEnvFile = false }) {
  const home = mkdtempSync(join(tmpdir(), 'samui-test-deploy-'))
  try {
    if (withEnvFile) {
      mkdirSync(join(home, 'samui-villas/deploy/test'), { recursive: true })
      writeFileSync(join(home, 'samui-villas/deploy/test/.env'), '')
    }
    const env = { HOME: home, PATH: process.env.PATH }
    if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command
    return spawnSync('bash', [SCRIPT], { env, input: stdin, encoding: 'utf8', timeout: 10_000 })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('ssh-команда — только sha256:<64 hex>, всё прочее — отказ до docker', () => {
  const bad = [
    undefined,
    '',
    'sha256:',
    `sha256:${HEX.slice(1)}`,
    `sha256:${HEX}a`,
    `sha256:${HEX.toUpperCase()}`,
    `sha512:${HEX}`,
    `${HEX}`,
    ` sha256:${HEX}`,
    `sha256:${HEX} `,
    `sha256:${HEX} up`,
    `sha256:${HEX};id`,
    `sha256:${HEX}\nid`,
    `id\nsha256:${HEX}`,
    `ghcr.io/mikekharr/samui-villas@sha256:${HEX}`,
    `-p samui sha256:${HEX}`,
  ]
  for (const command of bad) {
    const r = run({ command, withEnvFile: true })
    assert.equal(r.status, 64, `«${command}»: код ${r.status}, ожидался отказ 64; stderr: ${r.stderr}`)
    assert.match(r.stderr, /отказ: ожидается ровно sha256/, `«${command}»: не тот отказ: ${r.stderr}`)
  }
})

test('без токена первой строкой stdin — отказ до docker', () => {
  for (const stdin of ['', '\n', 'не токен\n', 'ghs_x y\n']) {
    const r = run({ command: `sha256:${HEX}`, stdin, withEnvFile: true })
    assert.equal(r.status, 64, `stdin ${JSON.stringify(stdin)}: код ${r.status}; stderr: ${r.stderr}`)
    assert.match(r.stderr, /нет токена GHCR/)
  }
})

test('без .env стенда — отказ до docker', () => {
  const r = run({ command: `sha256:${HEX}` })
  assert.equal(r.status, 64, `код ${r.status}; stderr: ${r.stderr}`)
  assert.match(r.stderr, /samui-villas\/deploy\/test\/\.env/)
})

/** Строки кода без комментариев: имя команды в пояснении не считается. */
const CODE = TEXT.split('\n')
  .map((line) => line.replace(/^\s*#.*$/, ''))
  .join('\n')

test('clean — это env -i с фиксированными PATH и HOME', () => {
  assert.match(CODE, /^clean\(\) \{\n {2}env -i PATH="\$CLEAN_PATH" HOME="\$HOME" "\$@"\n\}$/m)
  const path = CODE.match(/^readonly CLEAN_PATH=(\S+)$/m)
  assert.ok(path, 'нет readonly CLEAN_PATH=…')
  assert.match(path[1], /^\/[\w/:]+$/, `CLEAN_PATH «${path[1]}» не из одних абсолютных путей`)
})

test('каждый вызов docker идёт через clean', () => {
  const calls = [...CODE.matchAll(/(.{0,40})\bdocker\b/g)]
  assert.ok(calls.length > 0, 'вызовов docker в скрипте не найдено — сверять нечего')
  for (const [, before] of calls) {
    assert.match(
      before,
      /(^\s*|[|(]\s*|\$\()clean (APP_IMAGE="\$IMAGE" )?$/,
      `docker без clean: «${before}docker»`,
    )
  }
})

test('проект, каталог и файл compose заданы скриптом, а не присланы', () => {
  assert.match(CODE, /^readonly PROJECT=samui-test$/m)
  assert.match(CODE, /^readonly DIR="\$HOME\/samui-villas\/deploy\/test"$/m)
  assert.match(CODE, /docker compose -p "\$PROJECT" --project-directory "\$DIR" -f "\$DIR\/compose\.yml" "\$@"/)
})
