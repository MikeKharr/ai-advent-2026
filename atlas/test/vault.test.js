import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { isDistDir, readProvenance, run, underDir } from '../build.js'
import { readSources } from '../lib/sources.js'
import { buildVault } from '../lib/vault.js'
import { ROOT } from './helpers.js'

// Vault — производное: источник не правится ни при каких условиях, ссылки
// внутри копии обязаны вести в существующие заметки, а повторная сборка
// обязана давать тот же результат (ADR 2026-09-13-2000, критерии этапа 2).

const built = run({})
const VAULT = built.vaultDir
const graph = { nodes: built.nodes, edges: built.edges }

/** Все заметки vault с относительными путями. */
function notes(dir = VAULT, prefix = '') {
  const found = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...notes(full, `${prefix}${name}/`))
    else if (name.endsWith('.md')) found.push({ path: `${prefix}${name}`, text: readFileSync(full, 'utf8') })
  }
  return found
}

const all = notes()
// macOS отдаёт имена файлов в NFD, а строки в коде — в NFC: без нормализации
// кириллические имена фаз не сойдутся сами с собой.
const nfc = (s) => s.normalize('NFC')
const existing = new Set(all.map((n) => nfc(n.path)))
const edges = (kind) => graph.edges.filter((e) => e.kind === kind)
/** Заметки-сборки строятся из графа: тексты документов для них не нужны. */
const EMPTY_SOURCES = { adr: [], history: [], design: [], guides: [], invariants: '' }

/** Слепок содержимого всех входов: сборка не имеет права его изменить. */
function snapshotSources() {
  const src = readSources(ROOT)
  const parts = [src.invariants, src.composeText, src.caddyText, src.landingText, src.overlayText]
  for (const group of [src.adr, src.history, src.design, src.guides, src.roles, src.skills]) {
    for (const entry of group) parts.push(`${entry.path}\u0000${entry.text}`)
  }
  return createHash('sha256').update(parts.join('\u0001')).digest('hex')
}

test('сборка не трогает источник: ни один вход не изменился', () => {
  const before = snapshotSources()
  run({})
  assert.equal(snapshotSources(), before, 'сборка изменила файлы в agent_docs — это запрещено решением')
})

test('vault пишется только внутрь atlas/dist', () => {
  for (const file of built.vault) {
    const full = join(VAULT, file.path)
    assert.equal(relative(join(ROOT, 'atlas/dist'), full).startsWith('..'), false, full)
  }
})

/**
 * Текст без блоков кода и вставок в обратных кавычках: Obsidian ссылок там
 * не делает, а документы проекта показывают `[[wikilinks]]` как пример.
 */
const withoutCode = (text) => text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '')

test('ни одна заметка не содержит нерешённой [[ ]]', () => {
  const broken = []
  for (const note of all) {
    for (const m of withoutCode(note.text).matchAll(/\[\[([^\]|#]+)/g)) {
      const target = `${nfc(m[1].trim())}.md`
      if (!existing.has(target)) broken.push(`${note.path} → ${m[1]}`)
    }
  }
  assert.deepEqual(broken, [], 'ссылка ведёт туда, где файла нет')
  // Проверка обязана что-то проверять: ссылок в vault тысячи.
  const links = all.flatMap((n) => [...withoutCode(n.text).matchAll(/\[\[/g)]).length
  assert.ok(links > 500, `ссылок нашлось всего ${links}`)
})

test('образцы в блоках кода и в обратных кавычках копия не переписывает', () => {
  const spec = readFileSync(join(VAULT, 'design/2026-09-13-2000-project-atlas.md'), 'utf8')
  assert.ok(spec.includes('├── adr/<id>.md'), 'дерево каталогов в блоке кода изменилось')
  assert.equal(spec.includes('[[invariants/[['), false, 'замена прошла по уже готовой ссылке')
})

test('у каждой заметки есть фронтматтер и блок происхождения', () => {
  const provenance = readProvenance(ROOT)
  for (const note of all) {
    assert.ok(note.text.startsWith('---\n'), `${note.path}: фронтматтер не первым блоком`)
    assert.match(note.text, /^type: "/m, note.path)
    assert.ok(note.text.includes('ИСТОЧНИК: '), note.path)
    assert.ok(note.text.includes(`КОММИТ: ${provenance.sha}`), note.path)
    assert.ok(note.text.includes('ВНИМАНИЕ: копия только для чтения. Правки вносить в репозиторий.'), note.path)
  }
})

test('каталоги vault — те, что описаны в проекте решения', () => {
  const dirs = new Set(all.filter((n) => n.path.includes('/')).map((n) => n.path.slice(0, n.path.indexOf('/'))))
  assert.deepEqual(
    [...dirs].sort(),
    ['adr', 'classes', 'days', 'design', 'guides', 'history', 'invariants', 'phases', 'roles', 'services', 'skills'],
  )
  // Число заметок каждого вида — по графу, а не константой.
  const count = (dir) => all.filter((n) => n.path.startsWith(`${dir}/`)).length
  const nodes = (type) => graph.nodes.filter((n) => n.type === type).length
  assert.equal(count('adr'), nodes('adr'))
  assert.equal(count('history'), nodes('history'))
  assert.equal(count('roles'), nodes('role'))
  assert.equal(count('invariants'), nodes('invariant'))
  assert.equal(count('phases'), nodes('phase'))
  // Гайды плюс отдельная заметка с полным текстом invariants.md.
  assert.equal(count('guides'), nodes('guide') + 1)
})

test('.obsidian не генерируется', () => {
  assert.equal(existsSync(join(VAULT, '.obsidian')), false)
})

test('раздел «Следы в записях» — ровно рёбра fired, отдельно от упоминаний', () => {
  const text = readFileSync(join(VAULT, 'roles/compliance.md'), 'utf8')
  const section = (name) => text.slice(text.indexOf(`## ${name}`)).split('\n## ')[0]

  const fired = edges('fired').filter((e) => e.from === 'role/compliance')
  const records = new Set(fired.map((e) => e.to))
  const where = section('Следы в записях')

  // Числа берутся из графа: следующая запись истории их изменит.
  assert.match(where, new RegExp(`Следов: ${fired.length} в ${records.size} записях`))
  const rows = where.split('\n').filter((l) => l.startsWith('- [['))
  assert.equal(rows.length, fired.length)
  for (const e of fired) {
    const id = e.to.slice(e.to.indexOf('/') + 1)
    assert.ok(
      rows.some((r) => r.startsWith(`- [[history/${id}]], строка ${e.line}: «`)),
      `нет строки для ${e.to}:${e.line}`,
    )
  }

  // Три разные вещи: следы, упоминания и обратные ссылки Obsidian.
  const mentions = edges('mentions').filter((e) => e.to === 'role/compliance')
  const said = section('Упоминания')
  assert.match(said, new RegExp(`Документов: ${mentions.length}`))
  assert.equal(said.split('\n').filter((l) => l.startsWith('- [[')).length, mentions.length)
  assert.notEqual(fired.length, 0)

  // Заголовок и подпись называют отношение, а не вывод: среди следов есть
  // строки, где гейт не срабатывал.
  assert.match(where, /Имя роли рядом с признаком гейта/)
  for (const banned of [/сработал/i, /вынес/i]) {
    assert.equal(banned.test(where.split('\n').slice(0, 5).join(' ')), false, `в шапке раздела форма ${banned}`)
  }
})

test('выдержка следа — целая фраза или строка таблицы', () => {
  const withTraces = new Set(edges('fired').map((e) => e.from.slice(e.from.indexOf('/') + 1)))
  assert.ok(withTraces.size >= 3, 'следы должны быть у нескольких ролей')

  let checked = 0
  let clipped = 0
  for (const role of withTraces) {
    const text = readFileSync(join(VAULT, `roles/${role}.md`), 'utf8')
    const rows = text
      .slice(text.indexOf('## Следы в записях'))
      .split('\n## ')[0]
      .split('\n')
      .filter((l) => l.startsWith('- [['))

    for (const row of rows) {
      const quote = row.slice(row.indexOf('«') + 1, row.lastIndexOf('»'))
      checked += 1
      if (quote.startsWith('|')) continue
      if (quote.endsWith('…')) {
        // Честная обрезка по пределу, а не обрыв по переносу: длина упёрлась.
        clipped += 1
        assert.ok(quote.length >= 140, `многоточие не от предела: ${quote}`)
        continue
      }
      // Фраза кончается знаком конца предложения либо концом пункта списка;
      // висячая запятая или двоеточие — признак обрыва по переносу.
      assert.doesNotMatch(quote, /[,:;(+—-]$/, `обрывок фразы: ${quote}`)
      // Выделение не должно оставаться непарным: ведущее `**` — не маркер.
      assert.equal((quote.match(/\*\*/g) ?? []).length % 2, 0, `непарное выделение: ${quote}`)
    }
  }

  assert.equal(checked, edges('fired').length)
  assert.ok(clipped <= 6, `обрезанных по пределу выдержек ${clipped} — предел стоит пересмотреть`)
})

test('обратные ссылки инварианта — все документы, где он упомянут', () => {
  const dirOf = { adr: 'adr', history: 'history', design: 'design', guide: 'guides', role: 'roles' }
  const expected = new Set(
    edges('relies')
      .filter((e) => e.to === 'invariant/I-4')
      .map((e) => `${dirOf[e.from.slice(0, e.from.indexOf('/'))]}/${e.from.slice(e.from.indexOf('/') + 1)}.md`),
  )
  // Полный текст invariants.md ссылается на каждый инвариант по построению;
  // узлом графа он не является, поэтому в рёбрах его нет.
  expected.add('guides/invariants.md')

  const actual = new Set(all.filter((n) => n.text.includes('[[invariants/I-4]]')).map((n) => n.path))
  assert.deepEqual([...actual].sort(), [...expected].sort())
})

test('повторная сборка даёт побайтово тот же результат', () => {
  const second = run({})
  assert.equal(second.vault.length, built.vault.length)
  for (const [i, file] of second.vault.entries()) {
    assert.equal(file.path, built.vault[i].path)
    assert.equal(file.text, built.vault[i].text, file.path)
  }
  // И на диске тоже: время в блоке происхождения — время коммита, не «сейчас».
  for (const note of notes()) {
    assert.equal(note.text, all.find((n) => n.path === note.path)?.text, note.path)
  }
})

test('всё, что сборка пишет и удаляет, лежит под каталогом выхода', () => {
  const dist = join(ROOT, 'atlas/dist')
  assert.equal(underDir(dist, join(dist, 'vault/adr/x.md')), true)
  assert.equal(underDir(dist, dist), true)
  // Совпадения подстроки недостаточно: и выход вверх, и соседний каталог.
  assert.equal(underDir(dist, join(dist, '../../../.ssh/id_ed25519')), false)
  assert.equal(underDir(dist, `${dist}-2/graph.json`), false)

  for (const file of built.vault) assert.equal(underDir(built.vaultDir, join(built.vaultDir, file.path)), true, file.path)
})

test('каталог выхода обязан быть atlas/dist внутри пакета', () => {
  // `underDir` от `dirname(out)` сам по себе всегда истинен — он сравнивает
  // корень сам с собой. Каталог выхода проверяется отдельно, иначе
  // рекурсивное удаление имён вроде `days` и `roles` уезжает в чужое дерево.
  assert.equal(isDistDir(join(ROOT, 'atlas/dist')), true)
  assert.equal(isDistDir(join(ROOT, 'temp/atlas-fixture/atlas/dist')), true, 'копия входов в temp/ — допустимый выход')
  for (const bad of ['/tmp/escape', join(ROOT, 'atlas/dist/../..'), '/tmp/atlas/dist', join(ROOT, 'atlas/dist-2')]) {
    assert.equal(isDistDir(bad), false, bad)
  }

  for (const out of [
    '/tmp/escape/graph.json',
    join(ROOT, 'atlas/dist/../../escape.json'),
    '/tmp/atlas/dist/graph.json',
    join(ROOT, 'atlas/dist-2/graph.json'),
  ]) {
    assert.throws(() => run({ out }), /каталог выхода не atlas\/dist/, out)
  }
  assert.equal(existsSync(join(ROOT, 'escape.json')), false)
  assert.equal(existsSync(join(ROOT, 'atlas/dist-2')), false)
  assert.equal(existsSync('/tmp/escape'), false)
})

test('--check ничего не пишет и не зовёт git', () => {
  const out = join(ROOT, 'temp/atlas-check/graph.json')
  const result = run({ check: true, out })
  assert.deepEqual(result.vault, [])
  assert.equal(existsSync(out), false)
  assert.equal(existsSync(join(ROOT, 'temp/atlas-check')), false)
})

test('блок происхождения не скрывает несохранённых правок', () => {
  const clean = { sha: 'abc', time: 'на коммит от 2026-09-10 14:10 +07' }
  const [note] = buildVault({ graph, sources: EMPTY_SOURCES, provenance: clean })
  assert.ok(note.text.includes('КОММИТ: abc'))
  assert.ok(note.text.includes('СИНХРОНИЗИРОВАНО: на коммит от '), 'ярлык не должен читаться как «сейчас»')

  // На грязном дереве копия собрана не из коммита, и блок обязан это сказать.
  const provenance = readProvenance(ROOT)
  const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  assert.equal(/несохранённые правки рабочего дерева/.test(provenance.sha), dirty)
})

test('без git происхождение честно говорит, что коммит неизвестен', () => {
  const provenance = readProvenance('/')
  assert.equal(provenance.sha, 'вне git')
  const files = buildVault({ graph, sources: EMPTY_SOURCES, provenance })
  assert.ok(files.every((f) => f.text.includes('КОММИТ: вне git')))
})
