// Построение графа проекта: узлы и рёбра по таблицам проекта решения
// `agent_docs/design/2026-09-13-2000-project-atlas.md`. Источник не меняется —
// граф извлекается из действующих соглашений цитирования (ADR 2026-09-13-2000).

import { parseCompose } from './compose.js'
import { firedTraces } from './fired.js'
import { layout } from './layout.js'
import {
  atomicId,
  clip,
  firstParagraph,
  heading,
  labeledParagraph,
  parseFrontmatter,
  replacementRefs,
  scanCitations,
  section,
} from './markdown.js'
import { inputExists } from './sources.js'

/** Корневые документы — закрытый список целей цитат (проект решения). */
const ROOT_DOCS = new Set(['architecture.md', 'index.md', 'glossary.md', 'AGENTS.md'])

export function buildGraph(sources) {
  const nodes = []
  const edges = []
  // Находки чтения входов идут первыми: без входа остальные находки — эхо.
  const findings = [...(sources.findings ?? [])]

  const add = (node) => {
    const twin = nodes.find((n) => n.id === node.id)
    if (twin) {
      const where = (n) => n.file ?? 'atlas/overlay.json'
      note(where(node), 1, `узел \`${node.id}\` строится дважды: из ${where(twin)} и из ${where(node)}`)
      return twin
    }
    nodes.push(node)
    return node
  }
  const link = (from, to, kind, extra = {}) => {
    edges.push({ from, to, kind, ...extra })
  }
  const has = (id) => nodes.some((n) => n.id === id)
  const note = (file, line, message) => findings.push({ file, line, message })

  // --- документы: adr, history, design, guide ---------------------------------

  const docNode = (type, entry, key) => {
    const text = entry.text
    const id = `${type}/${key}`
    const date = (key.match(/^(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null
    const excerptSource =
      section(text, 'Контекст') || section(text, 'Что сделано') || section(text, 'Задача') || text.replace(/^#.*\n/, '')
    const node = {
      id,
      type,
      key,
      title: heading(text) || key,
      file: entry.path,
      date,
      excerpt: clip(firstParagraph(excerptSource), 400),
    }
    if (type === 'adr') node.status = clip(firstParagraph(section(text, 'Статус')), 200)
    return add(node)
  }

  for (const entry of sources.adr) {
    const id = atomicId(entry.key)
    if (!id) {
      note(entry.path, 1, 'имя ADR без идентификатора YYYY-MM-DD-HHMM')
      continue
    }
    docNode('adr', entry, id)
  }
  for (const entry of sources.history) {
    const id = atomicId(entry.key)
    if (!id) {
      note(entry.path, 1, 'имя записи истории без идентификатора YYYY-MM-DD-HHMM')
      continue
    }
    docNode('history', entry, id)
  }
  for (const entry of sources.design) docNode('design', entry, entry.key)
  for (const entry of sources.guides) docNode('guide', entry, entry.key)

  // --- инварианты -------------------------------------------------------------

  for (const line of sources.invariants.split('\n')) {
    const m = line.match(/^- \*\*(I-\d+)\.\*\*\s*(.+)$/)
    if (m) add({ id: `invariant/${m[1]}`, type: 'invariant', key: m[1], title: m[1], text: m[2].trim(), file: 'agent_docs/invariants.md' })
  }
  // Допустимые номера — те, что разобраны из файла. Константы здесь быть не
  // может: добавленный инвариант иначе роняет обязательную проверку на всех PR.
  const invariantNumbers = nodes.filter((n) => n.type === 'invariant').map((n) => Number(n.key.slice(2)))
  const invariantRange =
    invariantNumbers.length > 0 ? `I-${Math.min(...invariantNumbers)}…I-${Math.max(...invariantNumbers)}` : 'ни одного'

  // --- роли и ярусы -----------------------------------------------------------

  const roleNames = new Set(sources.roles.map((r) => r.key))
  for (const entry of sources.roles) {
    const { data, body } = parseFrontmatter(entry.text)
    const owns = labeledParagraph(body, 'Владеет')
    const never = labeledParagraph(body, 'Никогда')
    const tierKey = `${data.model}-${data.effort}`
    add({
      id: `role/${entry.key}`,
      type: 'role',
      key: entry.key,
      title: heading(body) || entry.key,
      file: entry.path,
      model: data.model ?? null,
      effort: data.effort ?? null,
      skills: data.skills ?? [],
      description: data.description ?? '',
      owns,
      never,
    })
    if (!has(`tier/${tierKey}`)) {
      add({ id: `tier/${tierKey}`, type: 'tier', key: tierKey, title: `${data.model} / ${data.effort}`, model: data.model, effort: data.effort })
    }
    link(`role/${entry.key}`, `tier/${tierKey}`, 'tier')
  }

  // --- скиллы -----------------------------------------------------------------

  for (const entry of sources.skills) {
    const { data } = parseFrontmatter(entry.text)
    add({
      id: `skill/${entry.key}`,
      type: 'skill',
      key: entry.key,
      title: data.name ?? entry.key,
      file: entry.path,
      description: clip(data.description ?? '', 300),
      vendored: Boolean(sources.skillsLock.skills?.[entry.key]),
    })
  }
  for (const entry of sources.roles) {
    const { data } = parseFrontmatter(entry.text)
    for (const skill of data.skills ?? []) {
      if (has(`skill/${skill}`)) link(`role/${entry.key}`, `skill/${skill}`, 'preloads')
      else note(entry.path, 1, `роль предзагружает скилл \`${skill}\`, которого нет в .agents/skills/`)
    }
  }

  // --- дни, сервисы, тома -----------------------------------------------------

  const compose = parseCompose(sources.composeText)
  for (const f of compose.findings) note('deploy/compose.yml', f.line, f.message)
  const composeByName = Object.fromEntries(compose.services.map((s) => [s.name, s]))

  const landing = {}
  for (const block of sources.landingText.split('<a class="day"').slice(1)) {
    const href = block.match(/href="\/(day\d+)\/"/)
    if (!href) continue
    landing[href[1]] = {
      title: (block.match(/class="t">([^<]*)</) ?? [])[1]?.trim() ?? '',
      date: (block.match(/class="d">([^<]*)</) ?? [])[1]?.trim() ?? '',
    }
  }

  // Комментарии Caddyfile упоминают handle_path в пояснении: маршрут — только
  // действующая строка.
  const routed = new Set(
    sources.caddyText
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .flatMap((l) => [...l.matchAll(/handle_path \/(day\d+)\/\*/g)].map((m) => m[1])),
  )

  for (const name of sources.days) {
    const svc = composeByName[name] ?? { image: null, dependsOn: [], volumes: [], envFiles: [] }
    add({
      id: `day/${name}`,
      type: 'day',
      key: name,
      title: landing[name]?.title || name,
      date: landing[name]?.date ?? null,
      dir: `days/${name}`,
      route: routed.has(name) ? `/${name}/` : null,
      image: svc.image,
      envFiles: svc.envFiles,
    })
  }

  for (const s of compose.services) {
    if (/^day\d+$/.test(s.name)) continue
    add({ id: `service/${s.name}`, type: 'service', key: s.name, title: s.name, image: s.image, envFiles: s.envFiles, file: 'deploy/compose.yml' })
  }
  add({
    id: 'service/site',
    type: 'service',
    key: 'site',
    title: 'site',
    source: 'site/',
    file: 'site/index.html',
    note: 'Лендинг: статика, которую caddy отдаёт из bind-монтирования ../site.',
  })

  for (const v of compose.volumes) {
    add({ id: `volume/${v}`, type: 'volume', key: v, title: v, file: 'deploy/compose.yml' })
  }

  const unitId = (name) => (/^day\d+$/.test(name) ? `day/${name}` : `service/${name}`)
  for (const s of compose.services) {
    for (const dep of s.dependsOn) if (has(unitId(dep))) link(unitId(s.name), unitId(dep), 'depends')
    for (const v of s.volumes) if (v.named && has(`volume/${v.source}`)) link(unitId(s.name), `volume/${v.source}`, 'mounts')
  }
  for (const name of routed) if (has(`day/${name}`)) link('service/caddy', `day/${name}`, 'routes')
  const caddy = composeByName.caddy
  if (caddy?.volumes.some((v) => v.source === '../site')) link('service/caddy', 'service/site', 'serves')

  // --- внешние сервисы --------------------------------------------------------

  for (const p of sources.providers) {
    add({
      id: `external/${p.id}`,
      type: 'external',
      key: p.id,
      title: p.model ? `${p.id} (${p.model})` : p.id,
      kind: p.kind,
      tier: p.tier,
      model: p.model,
      source: 'router/config/providers.json',
    })
    link('service/router', `external/${p.id}`, 'calls')
  }
  for (const e of sources.overlay.externals) {
    add({ id: `external/${e.id}`, type: 'external', key: e.id, title: e.title, kind: e.kind, note: e.note, source: 'atlas/overlay.json' })
  }
  // Конвейер образов: Actions собирает → GHCR → сервер тянет тег.
  for (const s of compose.services) {
    if (!s.image?.startsWith('ghcr.io/')) continue
    if (has('external/ghcr')) link(unitId(s.name), 'external/ghcr', 'image')
  }
  for (const p of sources.overlay.publishes ?? []) {
    if (!has(`external/${p.from}`) || !has(`external/${p.to}`)) {
      note('atlas/overlay.json', lineOf(sources.overlayText, `"${p.from}"`), `в publishes указан внешний сервис, которого нет среди externals`)
      continue
    }
    link(`external/${p.from}`, `external/${p.to}`, 'publishes')
  }
  for (const c of sources.overlay.calls) {
    if (!composeByName[c.from]) {
      note('atlas/overlay.json', lineOf(sources.overlayText, `"${c.from}"`), `в calls указан сервис \`${c.from}\`, которого нет в deploy/compose.yml`)
      continue
    }
    if (!has(`external/${c.to}`)) {
      note('atlas/overlay.json', lineOf(sources.overlayText, `"${c.to}"`), `в calls указан внешний сервис \`${c.to}\`, которого нет среди externals`)
      continue
    }
    link(unitId(c.from), `external/${c.to}`, 'calls')
  }

  // --- классы гейтов и фазы цикла (overlay) -----------------------------------

  for (const c of sources.overlay.classes) {
    add({ id: `class/${c.id}`, type: 'class', key: c.id, title: c.title, what: c.what, note: c.note ?? '', source: 'atlas/overlay.json' })
  }
  for (const c of sources.overlay.classes) {
    for (const role of c.gates) {
      if (roleNames.has(role)) link(`class/${c.id}`, `role/${role}`, 'gates')
      else note('atlas/overlay.json', lineOf(sources.overlayText, `"${role}"`), `класс ${c.id} ссылается на роль \`${role}\`, которой нет в .claude/agents/`)
    }
  }

  for (const p of sources.overlay.phases) {
    const key = String(p.n).padStart(2, '0')
    add({ id: `phase/${key}`, type: 'phase', key, title: p.title, n: p.n, exit: p.exit, human: Boolean(p.human), source: 'atlas/overlay.json' })
  }
  for (const p of sources.overlay.phases) {
    const key = String(p.n).padStart(2, '0')
    for (const role of p.roles) {
      if (roleNames.has(role)) link(`phase/${key}`, `role/${role}`, 'runs')
      else note('atlas/overlay.json', lineOf(sources.overlayText, `"${role}"`), `фаза ${p.n} ссылается на роль \`${role}\`, которой нет в .claude/agents/`)
    }
    for (const cls of p.classes ?? []) {
      if (has(`class/${cls}`)) link(`phase/${key}`, `class/${cls}`, 'runs')
      else note('atlas/overlay.json', lineOf(sources.overlayText, `"${cls}"`), `фаза ${p.n} ссылается на класс ${cls}, которого нет в overlay`)
    }
  }

  // --- цитаты: cites, relies, mentions ----------------------------------------

  const resolvePath = (value) => {
    const base = value.split('/').pop()
    if (ROOT_DOCS.has(base)) {
      // Корневой документ из закрытого списка. Путь берётся как написан:
      // `AGENTS.md` лежит в корне, и `agent_docs/AGENTS.md` — другой,
      // несуществующий файл, о чём и должна сказать находка.
      const key = base.replace(/\.md$/, '').toLowerCase()
      const file = value.includes('/') ? value : base === 'AGENTS.md' ? 'AGENTS.md' : `agent_docs/${value}`
      // Узел корневого документа строится по списку входов, а не по факту
      // файла, поэтому здесь проверяется именно файл: иначе переименование
      // прошло бы мимо гейта.
      if (!inputExists(sources.root, file)) return { file: null, node: null }
      return { file, node: has(`guide/${key}`) ? `guide/${key}` : null }
    }
    const dir = value.slice(0, value.indexOf('/'))
    const rest = value.slice(value.indexOf('/') + 1)
    if (dir === 'guides') {
      const name = rest.replace(/\.md$/, '')
      return { file: `agent_docs/guides/${name}.md`, node: has(`guide/${name}`) ? `guide/${name}` : null }
    }
    if (dir === 'design') {
      const name = rest.replace(/\.md$/, '')
      return { file: `agent_docs/design/${name}.md`, node: has(`design/${name}`) ? `design/${name}` : null }
    }
    const folder = dir === 'adr' ? 'agent_docs/adr' : 'agent_docs/development-history'
    const type = dir === 'adr' ? 'adr' : 'history'
    const id = atomicId(rest)
    if (!id) return { file: `${folder}/${rest}`, node: null }
    return { file: has(`${type}/${id}`) ? `${folder}/${rest}` : null, node: has(`${type}/${id}`) ? `${type}/${id}` : null, id }
  }

  const citing = [
    ...sources.adr.map((e) => ({ id: `adr/${atomicId(e.key)}`, entry: e })),
    ...sources.history.map((e) => ({ id: `history/${atomicId(e.key)}`, entry: e })),
    ...sources.design.map((e) => ({ id: `design/${e.key}`, entry: e })),
    ...sources.guides.map((e) => ({ id: `guide/${e.key}`, entry: e })),
    ...sources.roles.map((e) => ({ id: `role/${e.key}`, entry: e })),
  ]

  for (const { id, entry } of citing) {
    if (!has(id)) continue
    const seen = new Set()
    for (const c of scanCitations(entry.text)) {
      if (c.kind === 'adr') {
        const target = `adr/${c.value}`
        if (!has(target)) {
          note(entry.path, c.line, `цитата ADR \`${c.value}\` не разрешается: файла нет в agent_docs/adr/`)
          continue
        }
        if (target !== id) addOnce(seen, () => link(id, target, 'cites'), `cites:${target}`)
      } else if (c.kind === 'path') {
        const r = resolvePath(c.value)
        const exists = r.node !== null || (r.file !== null && inputExists(sources.root, r.file))
        if (!exists) {
          note(entry.path, c.line, `путь \`${c.value}\` не разрешается: такого файла нет`)
          continue
        }
        if (r.node && r.node !== id) addOnce(seen, () => link(id, r.node, 'cites'), `cites:${r.node}`)
      } else if (c.kind === 'invariant') {
        if (!has(`invariant/${c.value}`)) {
          note(entry.path, c.line, `упомянут инвариант ${c.value}, которого нет в agent_docs/invariants.md (там ${invariantRange})`)
          continue
        }
        addOnce(seen, () => link(id, `invariant/${c.value}`, 'relies'), `relies:${c.value}`)
      } else if (roleNames.has(c.value) && id !== `role/${c.value}`) {
        addOnce(seen, () => link(id, `role/${c.value}`, 'mentions'), `mentions:${c.value}`)
      }
    }
  }

  // --- replaces ---------------------------------------------------------------

  for (const entry of sources.adr) {
    const id = atomicId(entry.key)
    if (!id || !has(`adr/${id}`)) continue
    const { replaces, replacedBy } = replacementRefs(entry.text)
    for (const other of replaces) {
      if (has(`adr/${other}`)) link(`adr/${id}`, `adr/${other}`, 'replaces')
      else note(entry.path, 1, `в статусе «Заменяет» указан ADR \`${other}\`, которого нет`)
    }
    for (const other of replacedBy) {
      if (has(`adr/${other}`)) link(`adr/${other}`, `adr/${id}`, 'replaces')
      else note(entry.path, 1, `в статусе «Заменено на» указан ADR \`${other}\`, которого нет`)
    }
  }

  // --- about: документ → день --------------------------------------------------

  const about = sources.overlay.about ?? {}
  for (const { id, entry } of citing) {
    if (!has(id) || id.startsWith('guide/') || id.startsWith('role/')) continue
    const key = id.slice(id.indexOf('/') + 1)
    const override = about[key]
    const days = override ? override.days : [...new Set([...entry.key.matchAll(/\b(day\d+)\b/g)].map((m) => m[1]))]
    for (const day of days) {
      if (has(`day/${day}`)) link(id, `day/${day}`, 'about')
      else note('atlas/overlay.json', lineOf(sources.overlayText, `"${day}"`), `в about указан день \`${day}\`, которого нет в days/`)
    }
  }
  for (const key of Object.keys(about)) {
    if (!has(`adr/${key}`) && !has(`history/${key}`) && !has(`design/${key}`)) {
      note('atlas/overlay.json', lineOf(sources.overlayText, `"${key}"`), `в about указан документ \`${key}\`, которого нет`)
    }
  }

  // --- fired: правило → где сработало -----------------------------------------

  for (const entry of sources.history) {
    const id = `history/${atomicId(entry.key)}`
    if (!has(id)) continue
    for (const trace of firedTraces(entry.text, roleNames)) {
      link(`role/${trace.role}`, id, 'fired', { line: trace.line, excerpt: trace.excerpt, marks: trace.marks })
    }
  }

  // Внешний узел — то, с чем работающая система обменивается. Узел без
  // единого ребра означает, что overlay разошёлся с реальностью: чинится
  // ребром или удалением записи, а не подстройкой списка руками.
  for (const n of nodes) {
    if (n.type !== 'external') continue
    if (edges.some((e) => e.from === n.id || e.to === n.id)) continue
    note(
      n.source === 'atlas/overlay.json' ? 'atlas/overlay.json' : 'router/config/providers.json',
      n.source === 'atlas/overlay.json' ? lineOf(sources.overlayText, `"${n.key}"`) : 1,
      `внешний узел \`${n.key}\` не связан ни с чем: либо его нет в работе системы, либо не хватает ребра`,
    )
  }

  // Координаты — последними: раскладка считается по готовому графу
  // (контракт 1 этапа 3, раскладка 2026-09-13-2100).
  const placed = layout(nodes, edges)
  for (const node of nodes) Object.assign(node, placed.get(node.id))

  return { nodes, edges, findings }
}

/** Ребро добавляется один раз на пару «документ — цель». */
function addOnce(seen, fn, key) {
  if (seen.has(key)) return
  seen.add(key)
  fn()
}

/** Номер строки, где встретилось значение, — чтобы находка правилась по адресу. */
function lineOf(text, needle) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.includes(needle))
  return i === -1 ? 1 : i + 1
}
