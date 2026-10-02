// Ключ хоста сервера закреплён, а не выспрашивается у него (ADR
// 2026-10-02-0921). До этого выкатка делала `ssh-keyscan >> known_hosts` на
// каждом прогоне и принимала любой предъявленный ключ: смену ключа 2026-10-02
// она не заметила, подмену не заметила бы так же.
//
// Проверка стоит на ЧЕТЫРЁХ частях защиты, потому что снятие любой из них
// возвращает прежнее поведение, а три оставшиеся при этом выглядят целыми.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8')
const PIN = readFileSync(join(ROOT, 'deploy/known_hosts'), 'utf8')

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

test('имя хоста в закреплённом файле не раскрыто', () => {
  // SSH_HOST — секрет проекта. Хеширование (`ssh-keygen -H`) оставляет поиск
  // по имени рабочим, но само имя в файл не кладёт; незахешированная запись
  // раскрыла бы его в публичном репозитории.
  assert.ok(!/zpq|challenge|\.ai\b/.test(PIN), 'в deploy/known_hosts видно имя хоста')
})
