// Раскладка не новая: style.css — ДОСЛОВНЫЙ срез блока <style> дня 16
// (раскладка 2026-10-04-1003, п. 1).
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
  assert.ok(!/--attn\s*:/.test(mine), 'жёлтого токена день 22 корпусом не получает')
})

test('страница подключает именно этот файл и не несёт своих токенов', () => {
  const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')
  assert.ok(page.includes('<link rel="stylesheet" href="style.css">'))
  const own = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  assert.ok(!own.includes(':root'), 'своих токенов у страницы нет — только копия дня 16')
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(own), `свой цвет мимо корпуса: ${own.match(/#[0-9a-fA-F]{3,6}/)?.[0]}`)
  assert.ok(!own.includes('--attn'), 'жёлтого в блоке страницы нет')
})

// Чужое мёртвое в копии трогать нельзя (AGENTS.md, «Точечные изменения»), но
// и переиспользовать под другим смыслом тоже: правила `.chip`, `.indent` и
// `.palette` относятся к палитре команд и флажку отступов дня 16, которых на
// этом экране нет вовсе (раскладка, п. 1 и чек-лист п. 20).
test('чужие правила копии страница не переиспользует под другой смысл', () => {
  const page = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8')
  const app = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8')
  for (const name of ['palette', 'chips', 'chip', 'indent']) {
    assert.ok(!new RegExp(`class="[^"]*\\b${name}\\b`).test(page), `.${name} в разметке дня 22`)
    assert.ok(!new RegExp(`'${name}'`).test(app), `.${name} выставляется из app.js`)
  }
})
