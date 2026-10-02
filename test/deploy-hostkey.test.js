// Ключ хоста сервера закреплён, а не выспрашивается у него (ADR
// 2026-10-02-0921). До этого выкатка делала `ssh-keyscan >> known_hosts` на
// каждом прогоне и принимала любой предъявленный ключ: смену ключа 2026-10-02
// она не заметила, подмену не заметила бы так же.
//
// Проверка стоит на ЧЕТЫРЁХ частях защиты, потому что снятие любой из них
// возвращает прежнее поведение, а три оставшиеся при этом выглядят целыми.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8')
const PIN = readFileSync(join(ROOT, 'deploy/known_hosts'), 'utf8')
const ADR = readFileSync(join(ROOT, 'agent_docs/adr/2026-10-02-0921-ssh-host-key-pin.md'), 'utf8')

/** Строки шага без комментариев: иначе запрет на `ssh-keyscan` снимался бы
 *  тем, что имя команды осталось в пояснении, а не в коде. */
const CODE = WORKFLOW.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

test('выкатка не выспрашивает ключ хоста у сервера', () => {
  assert.ok(
    !/ssh-keyscan/.test(CODE),
    'в deploy.yml остался ssh-keyscan — ключ снова принимается какой дадут',
  )
})

test('ключ хоста берётся из закреплённого файла', () => {
  assert.match(
    CODE,
    /install -m 600 "\$GITHUB_WORKSPACE\/deploy\/known_hosts" ~\/\.ssh\/known_hosts/,
    'шаг не кладёт закреплённый файл на место known_hosts',
  )
  assert.match(
    CODE,
    /ssh-keygen -F "\$name" -f ~\/\.ssh\/known_hosts/,
    'нет проверки, что запись для сервера в файле есть — промах пина выглядел бы сбоем сети',
  )
})

test('сверка ключа у ssh включена явно', () => {
  assert.match(
    CODE,
    /-o StrictHostKeyChecking=yes/,
    'без явной сверки защита держалась бы на отсутствии терминала, а не на решении',
  )
})

test('закреплённый файл непуст и это запись ключа', () => {
  const lines = PIN.split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  assert.equal(lines.length, 1, 'в deploy/known_hosts ожидается ровно одна запись')
  assert.match(lines[0], /^\|1\|[^ ]+ ssh-ed25519 [A-Za-z0-9+/=]+$/, 'запись не похожа на хешированный ключ')
})

test('закреплённый файл не добавляет ещё одной копии имени хоста', () => {
  // Это ГИГИЕНА, а не защита, и путать их нельзя. Имя `challenge.zpq.ai` и так
  // напечатано открытым текстом в README.md, .mcp.json, deploy.yml,
  // .claude/settings.json и десятке ADR этого публичного репозитория, а соль
  // хеша лежит в самом файле — проверка догадки стоит один HMAC-SHA1.
  // Первая редакция этого теста называлась «имя хоста не раскрыто» и продавала
  // несуществующий контроль (находка compliance к #289).
  assert.ok(!/zpq|challenge|\.ai\b/.test(PIN), 'в deploy/known_hosts появилась копия имени хоста')
})

test('закреплён именно тот ключ, отпечаток которого назван в ADR', () => {
  // Без этого держатель не держит САМ КЛЮЧ: любая другая хешированная
  // ed25519-запись проходила все проверки, то есть «починка» красной выкатки
  // свежим `ssh-keyscan` прошла бы гейт тестов молча (находка compliance).
  // Отпечаток считается здесь же, без ssh-keygen: SHA256 от двоичного ключа
  // в base64 — это и есть то, что печатает `ssh-keygen -lf`.
  const line = PIN.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  const blob = line.split(' ')[2]
  const got = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
  const want = ADR.match(/SHA256:([A-Za-z0-9+/]+)/)
  assert.ok(want, 'в ADR нет отпечатка, который владелец должен сверить')
  assert.equal(
    `SHA256:${got}`,
    `SHA256:${want[1]}`,
    'закреплённый ключ не тот, отпечаток которого назван в ADR и сверяется владельцем',
  )
})
