// Построение графа проекта: узлы и рёбра по таблицам проекта решения
// `agent_docs/design/2026-09-13-2000-project-atlas.md`. Источник не меняется —
// граф извлекается из действующих соглашений цитирования (ADR 2026-09-13-2000).

import { parseCompose } from './compose.js'
import {
  atomicId,
  clip,
  firstParagraph,
  heading,
  parseFrontmatter,
  replacementRefs,
  scanCitations,
  section,
} from './markdown.js'
import { inputExists } from './sources.js'

/** Инвариантов ровно двенадцать: I-N вне этого диапазона — опечатка. */
export const INVARIANT_MAX = 12

const FIRED_WORDS = [/вето/i, /блокирующ/i, /находк/i, /ПРАВКИ/, /ПЕРЕДЕЛАТЬ/]

export function buildGraph(sources) {
  const nodes = []
  const edges = []
  const findings = []

  const add = (node) => {
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

  // --- роли и ярусы -----------------------------------------------------------

  const roleNames = new Set(sources.roles.map((r) => r.key))
  for (const entry of sources.roles) {
    const { data, body } = parseFrontmatter(entry.text)
    const owns = (body.match(/^\*\*Владеет:\*\*\s*(.+)$/m) ?? [])[1] ?? ''
    const never = (body.match(/^\*\*Никогда:\*\*\s*(.+)$/m) ?? [])[1] ?? ''
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

  const routed = new Set([...sources.caddyText.matchAll(/handle_path \/(day\d+)\/\*/g)].map((m) => m[1]))

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
    const [dir, rest] = value.includes('/') ? [value.slice(0, value.indexOf('/')), value.slice(value.indexOf('/') + 1)] : [null, value]
    if (dir === null) return { file: `agent_docs/${rest}`, node: null }
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
        const n = Number(c.value.slice(2))
        if (n < 1 || n > INVARIANT_MAX) {
          note(entry.path, c.line, `упомянут инвариант ${c.value}, а инвариантов I-1…I-${INVARIANT_MAX}`)
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
    const lines = entry.text.split('\n')
    const seen = new Set()
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!FIRED_WORDS.some((re) => re.test(line))) continue
      for (const role of roleNames) {
        if (seen.has(role) || !mentionsRole(line, role)) continue
        seen.add(role)
        link(`role/${role}`, id, 'fired', { line: i + 1, excerpt: clip(line.replace(/^[-*\s>]+/, '').trim()) })
      }
    }
  }

  return { nodes, edges, findings }
}

/**
 * Имя роли в строке — обратные кавычки не обязательны, но `/` и `-` рядом
 * запрещены: иначе `agent_docs/design/` даст роль `design`, а `design-review`
 * — её же.
 */
export function mentionsRole(line, role) {
  return new RegExp(`(?<![\\w/-])${role}(?![\\w/-])`).test(line)
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
