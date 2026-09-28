// Раскладка не новая: style.css — ДОСЛОВНЫЙ срез блока <style> дня 16.
//
// Это проверка структурная и предмет у неё текстовый: утверждение «своего
// визуального языка день не изобретает» — утверждение о байтах файла, и
// байтами оно и проверяется. Поведение отсюда не следует и здесь не
// доказывается.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const mine = readFileSync(join(here, '..', 'public', 'style.css'), 'utf8')
const day16 = readFileSync(join(here, '..', '..', 'day16', 'public', 'index.html'), 'utf8')

test('style.css равен блоку <style> дня 16 знак в знак', () => {
  const a = day16.indexOf('<style>') + '<style>\n'.length
  const b = day16.indexOf('</style>')
  assert.ok(a > 8 && b > a, 'блок <style> в дне 16 не найден — проверка не проверила ничего')
  assert.equal(mine, day16.slice(a, b))
})

test('в копии есть токены корпуса и нет жёлтого', () => {
  // Если срез однажды возьмут не из того места, эти две строки покраснеют
  // раньше, чем расхождение доедет до экрана.
  assert.ok(mine.includes('--acc:#2f6f4f'), 'акцентный токен корпуса на месте')
  // Ищется ОБЪЯВЛЕНИЕ токена, а не слово: у дня 16 в комментарии написано,
  // что жёлтого токена здесь нет, и поиск по слову покраснел бы на верном коде.
  assert.ok(!/--attn\s*:/.test(mine), 'жёлтого токена в дни 18–20 корпус не даёт')
})

test('страница подключает именно этот файл и не несёт своих токенов', () => {
  const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')
  assert.ok(page.includes('<link rel="stylesheet" href="style.css">'))
  const own = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  assert.ok(!own.includes(':root'), 'своих токенов у страницы нет — только копия дня 16')
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(own), `свой цвет мимо корпуса: ${own.match(/#[0-9a-fA-F]{3,6}/)?.[0]}`)
})
