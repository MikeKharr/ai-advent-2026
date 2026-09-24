// Закрытый список серверных команд существует в двух копиях по природе:
// текст решения — /day-cycle, фаза 9 (источник по ADR 2026-09-11-1230),
// механизм — allowlist `.claude/settings.json`. Свести их в одну нельзя,
// поэтому сверка механическая (ADR 2026-09-24-1230, A6).
//
// Тест закрыто падает в обе стороны: запись `Bash(ssh …)` в settings.json без
// дословной строки в блоке `closed-list` скилла — и строка блока, которой нет
// в allowlist. Второе важнее: строка в документе без записи в allowlist — это
// команда, которую агент считает разрешённой, а харнесс не пропустит.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SETTINGS = '.claude/settings.json'
const SKILL = '.agents/skills/day-cycle/SKILL.md'
const BEGIN = '<!-- closed-list:begin -->'
const END = '<!-- closed-list:end -->'

/** Команды из записей `Bash(ssh …)` allowlist. Пустой набор — провал. */
function fromSettings(text) {
  const allow = JSON.parse(text).permissions?.allow
  assert.ok(Array.isArray(allow), `${SETTINGS}: нет permissions.allow`)
  const out = allow
    .filter((e) => e.startsWith('Bash(ssh '))
    .map((e) => {
      assert.ok(e.endsWith(')'), `${SETTINGS}: запись «${e}» не закрыта скобкой`)
      return e.slice('Bash('.length, -1)
    })
  assert.notEqual(out.length, 0, `${SETTINGS}: записей Bash(ssh …) нет — сверять нечего`)
  return out
}

/** Строки блока `closed-list` скилла. Нет маркеров или пусто — провал. */
function fromSkill(text) {
  const from = text.indexOf(BEGIN)
  const to = text.indexOf(END)
  assert.ok(from !== -1 && to > from, `${SKILL}: нет маркеров ${BEGIN} … ${END}`)
  const out = text
    .slice(from + BEGIN.length, to)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'))
  assert.notEqual(out.length, 0, `${SKILL}: блок закрытого списка пуст`)
  return out
}

const settings = fromSettings(readFileSync(join(ROOT, SETTINGS), 'utf8'))
const skill = fromSkill(readFileSync(join(ROOT, SKILL), 'utf8'))

test('каждая запись Bash(ssh …) из settings.json дословно есть в /day-cycle', () => {
  for (const cmd of settings) {
    assert.ok(skill.includes(cmd), `${SETTINGS}: «${cmd}» не найдена дословно в блоке closed-list ${SKILL}`)
  }
})

test('каждая строка закрытого списка /day-cycle дословно есть в settings.json', () => {
  for (const cmd of skill) {
    assert.ok(settings.includes(cmd), `${SKILL}: «${cmd}» нет среди Bash(ssh …) в ${SETTINGS} — харнесс её не пропустит`)
  }
})

test('копии совпадают и по количеству — ни одной лишней строки', () => {
  assert.deepEqual([...skill].sort(), [...settings].sort())
})
