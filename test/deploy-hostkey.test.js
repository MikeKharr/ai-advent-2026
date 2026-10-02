// Ключ хоста сервера закреплён, а не выспрашивается у него (ADR
// 2026-10-02-0921). До этого выкатка делала `ssh-keyscan >> known_hosts` на
// каждом прогоне и принимала любой предъявленный ключ: смену ключа 2026-10-02
// она не заметила, подмену не заметила бы так же.
//
// Проверка стоит на СЕМИ частях (перечень — в ADR 2026-10-02-0921, раздел
// «Держатель»), потому что снятие любой возвращает прежнее поведение, а
// остальные при этом выглядят целыми.
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
  // Ищем ВНУТРИ вызова ssh, а не по всему файлу: иначе упоминание опции в
  // комментарии где угодно сходило бы за включённую сверку (нит reviewer).
  const call = CODE.slice(CODE.indexOf('ssh -p "$SSH_PORT"'))
  assert.ok(call, 'в deploy.yml не найден вызов ssh')
  assert.match(
    call.slice(0, 400),
    /-o StrictHostKeyChecking=yes/,
    'без явной сверки защита держалась бы на отсутствии терминала, а не на решении',
  )
})

test('у job, читающего закреплённый файл, репозиторий есть на диске', () => {
  // Держатель на находке, которая едва не положила прод: в job `deploy`
  // не было ни одного `actions/checkout` — `ssh-keyscan` файлов репозитория
  // не требовал. Шаг читает $GITHUB_WORKSPACE/deploy/known_hosts, и без
  // checkout выкатка умирает на `install` с `No such file or directory`,
  // не дойдя ни до проверки пина, ни до названного ::error::.
  //
  // Проверка смотрит на ПОРЯДОК внутри того же job, а не на наличие слова
  // `checkout` в файле: в соседних job он есть, и проверка «есть в файле»
  // была бы зелёной при пустом `deploy`.
  // Срез берётся из CODE, а не из сырого WORKFLOW: иначе закомментированный
  // `- uses: actions/checkout@v4` оставлял прогон зелёным при job без шага —
  // проверка ловила удаление строки и не ловила её комментирование. Файл сам
  // завёл CODE против этой дыры двадцатью строками выше, а здесь я его не
  // применил (находка reviewer, I-14: мутация «убрать строку» не должна
  // оставлять прогон зелёным ни в какой форме).
  const start = CODE.indexOf('\n  deploy:')
  assert.ok(start > 0, 'в deploy.yml не найден job deploy')
  const rest = CODE.slice(start + 1)
  const nextJob = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/)
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob)

  const checkout = job.indexOf('uses: actions/checkout')
  const reads = job.indexOf('$GITHUB_WORKSPACE/deploy/known_hosts')
  assert.ok(reads !== -1, 'job deploy больше не читает закреплённый файл — проверка устарела')
  assert.ok(checkout !== -1, 'в job deploy нет actions/checkout — выкатка упадёт на install')
  assert.ok(checkout < reads, 'checkout стоит ПОСЛЕ чтения закреплённого файла')
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
  // Явная проверка до разбора: на пустом файле `find` даёт undefined, и тест
  // падал бы TypeError вместо внятного утверждения (нит compliance).
  assert.ok(line, 'deploy/known_hosts пуст — закреплять нечего')
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
