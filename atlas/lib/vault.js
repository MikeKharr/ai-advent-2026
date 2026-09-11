// Vault Obsidian — производное от `agent_docs/`, а не второй источник
// (ADR 2026-09-10-0550, п. 2). Источник не правится ни при каких условиях:
// wikilinks и фронтматтер живут только в копии, как витрина в Drive
// (ADR 2026-09-07-1510). Устройство каталогов — раздел «Слой (а): vault»
// проекта решения.
//
// Модуль ничего не пишет: он возвращает список файлов. Право записи — у
// `build.js`, и оно ограничено каталогом `atlas/dist/`.

import { atomicId, mapCitations } from './markdown.js'

/** Каталоги, которые генерирует сборка. `.obsidian/` не наш — его не трогаем. */
export const VAULT_DIRS = ['adr', 'history', 'design', 'guides', 'invariants', 'roles', 'days', 'services', 'skills', 'classes', 'phases']

/** Тип узла → каталог заметки. Узлы прочих типов заметок не получают. */
const DIR_OF = {
  adr: 'adr',
  history: 'history',
  design: 'design',
  guide: 'guides',
  invariant: 'invariants',
  role: 'roles',
  day: 'days',
  service: 'services',
  skill: 'skills',
  class: 'classes',
  phase: 'phases',
}

/** Слово статуса ADR → тег. */
function statusTag(status) {
  if (/^Принято/i.test(status)) return 'status/accepted'
  if (/^Предложено/i.test(status)) return 'status/proposed'
  if (/^Отклонено/i.test(status)) return 'status/rejected'
  if (/^Заменено/i.test(status)) return 'status/superseded'
  return null
}

/** Скаляр YAML: строки всегда в кавычках — заголовки полны двоеточий и тире. */
function scalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function frontmatter(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === '') continue
    lines.push(Array.isArray(value) ? `${key}: [${value.join(', ')}]` : `${key}: ${scalar(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * Блок происхождения по формату `agent_docs/guides/drive-sync.md`. Стоит
 * после фронтматтера, а не в самом верху файла: Obsidian читает фронтматтер
 * только первым блоком, а гайд писался для Drive, где фронтматтера нет.
 */
function origin(source, provenance) {
  return [
    '<!--',
    `ИСТОЧНИК: ${source}`,
    `КОММИТ: ${provenance.sha}`,
    `СИНХРОНИЗИРОВАНО: ${provenance.time}`,
    'ВНИМАНИЕ: копия только для чтения. Правки вносить в репозиторий.',
    '-->',
  ].join('\n')
}

/** Имя файла фазы: `01-разбор-задания`. */
function phaseSlug(node) {
  const slug = node.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
  return `${node.key}-${slug}`
}

/** Путь заметки узла внутри vault, без расширения. */
function pathOf(node) {
  const dir = DIR_OF[node.type]
  if (!dir) return null
  return `${dir}/${node.type === 'phase' ? phaseSlug(node) : node.key}`
}

const list = (items) => (items.length > 0 ? items.map((s) => `- ${s}`).join('\n') : '- нет')

/**
 * Строит файлы vault.
 * @param {{nodes:Array, edges:Array}} graph граф из lib/extract.js
 * @param {object} sources входы (нужны тексты документов)
 * @param {{sha:string, time:string}} provenance коммит и его время, не «сейчас»
 * @returns {Array<{path:string, text:string}>}
 */
export function buildVault({ graph, sources, provenance }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const noteOf = new Map()
  for (const node of graph.nodes) {
    const path = pathOf(node)
    if (path) noteOf.set(node.id, path)
  }

  const link = (id) => (noteOf.has(id) ? `[[${noteOf.get(id)}]]` : null)
  const named = (id) => link(id) ?? byId.get(id)?.title ?? id
  const out = (from, kind) => graph.edges.filter((e) => e.from === from && e.kind === kind)
  const into = (to, kind) => graph.edges.filter((e) => e.to === to && e.kind === kind)

  /** Резолвер цитат: ссылка ставится, только если такая заметка есть. */
  const resolve = (kind, value) => {
    if (kind === 'adr') return link(`adr/${value}`)
    if (kind === 'invariant') return link(`invariant/${value}`)
    if (kind === 'word') return link(`role/${value}`)
    if (kind !== 'path') return null

    const base = value.split('/').pop()
    if (value.startsWith('development-history/')) return link(`history/${atomicId(base)}`)
    if (value.startsWith('adr/')) return link(`adr/${atomicId(base)}`)
    if (value.startsWith('design/')) return link(`design/${base.replace(/\.md$/, '')}`)
    if (value.startsWith('guides/')) return link(`guide/${base.replace(/\.md$/, '')}`)
    // Корневой документ — только по верной форме записи: `agent_docs/AGENTS.md`
    // ссылкой не становится, как и не разрешается в графе.
    if (base === 'AGENTS.md') return value === 'AGENTS.md' ? link('guide/agents') : null
    if (!value.includes('/') || value.startsWith('agent_docs/')) return link(`guide/${base.replace(/\.md$/, '')}`)
    return null
  }

  const wikilinked = (text) => mapCitations(text, resolve)

  const files = []
  const note = (path, fields, source, body) => {
    files.push({ path: `${path}.md`, text: `${frontmatter(fields)}\n${origin(source, provenance)}\n\n${body.trimEnd()}\n` })
  }

  // --- копии документов -------------------------------------------------------

  const dayOf = (id) => {
    const days = out(id, 'about').map((e) => byId.get(e.to)?.key)
    return days.length > 0 ? Number(days[0].slice(3)) : null
  }

  const textOf = new Map()
  for (const group of [sources.adr, sources.history, sources.design, sources.guides]) {
    for (const entry of group) textOf.set(entry.path, entry.text)
  }

  for (const node of graph.nodes) {
    if (!['adr', 'history', 'design', 'guide'].includes(node.type)) continue
    const day = dayOf(node.id)
    note(
      noteOf.get(node.id),
      {
        type: node.type,
        id: node.key,
        title: node.title,
        date: node.date,
        status: node.status ?? null,
        day,
        tags: [`type/${node.type}`, node.status ? statusTag(node.status) : null, day ? `day/${day}` : null].filter(Boolean),
      },
      node.file,
      wikilinked(textOf.get(node.file) ?? ''),
    )
  }

  // `invariants.md` целиком — отдельная заметка гайда: по нему ходят так же
  // часто, как по гайдам, а узлом графа он не является (проект решения,
  // дерево vault).
  note(
    'guides/invariants',
    { type: 'guide', id: 'invariants', title: 'Инварианты продукта', tags: ['type/guide'] },
    'agent_docs/invariants.md',
    wikilinked(sources.invariants),
  )

  // --- инварианты -------------------------------------------------------------

  for (const node of graph.nodes.filter((n) => n.type === 'invariant')) {
    note(
      noteOf.get(node.id),
      { type: 'invariant', id: node.key, title: node.key, tags: ['type/invariant'] },
      node.file,
      `# ${node.key}\n\n${wikilinked(node.text)}\n\nИсточник: [[guides/invariants]] (\`${node.file}\`).`,
    )
  }

  // --- роли -------------------------------------------------------------------

  for (const node of graph.nodes.filter((n) => n.type === 'role')) {
    const fired = out(node.id, 'fired')
    const records = new Set(fired.map((e) => e.to)).size
    // Предложный падеж: «в 1 записи», «в 21 записи», но «в 11 записях».
    const inRecords = records % 10 === 1 && records % 100 !== 11 ? 'записи' : 'записях'
    const mentions = into(node.id, 'mentions')
    const body = [
      `# ${node.title}`,
      '',
      node.description,
      '',
      '## Факты',
      '',
      `- Модель: \`${node.model}\`, усилие: \`${node.effort}\``,
      `- Владеет: ${node.owns || '—'}`,
      `- Никогда: ${node.never || '—'}`,
      '',
      '## Предзагруженные скиллы',
      '',
      list(out(node.id, 'preloads').map((e) => named(e.to))),
      '',
      '## Опирается на инварианты',
      '',
      // Роль — не копия файла, а собранная заметка, поэтому её исходящие
      // ссылки переносятся сюда явно: иначе обратные ссылки инварианта в
      // Obsidian не сойдутся с рёбрами `relies` графа.
      list(out(node.id, 'relies').map((e) => named(e.to))),
      '',
      '## Ссылается на',
      '',
      list(out(node.id, 'cites').map((e) => named(e.to))),
      '',
      '## Следы в записях',
      '',
      // Заголовок и подпись называют отношение, а не вывод: правило видит имя
      // роли рядом с признаком гейта и не знает, вынесено вето или снято.
      // Среди следов есть строки, где гейт как раз не срабатывал, — «сработал»
      // и «вынес» в заголовках и подписях запрещены (проект решения, «Панель
      // заметки»). Раздел отдельный от «Упоминаний» и от обратных ссылок
      // Obsidian, которые складывают все виды рёбер.
      'Имя роли рядом с признаком гейта, и только это.',
      '',
      `Следов: ${fired.length} в ${records} ${inRecords}.`,
      '',
      list(fired.map((e) => `${named(e.to)}, строка ${e.line}: «${e.excerpt}»`)),
      '',
      '## Упоминания',
      '',
      `Документов: ${mentions.length}.`,
      '',
      list(mentions.map((e) => named(e.from))),
    ].join('\n')

    note(
      noteOf.get(node.id),
      {
        type: 'role',
        id: node.key,
        title: node.title,
        model: node.model,
        effort: node.effort,
        tags: ['type/role', `model/${node.model}`, `effort/${node.effort}`],
      },
      node.file,
      body,
    )
  }

  // --- дни --------------------------------------------------------------------

  for (const node of graph.nodes.filter((n) => n.type === 'day')) {
    const n = Number(node.key.slice(3))
    const body = [
      `# ${node.title}`,
      '',
      '## Факты',
      '',
      `- Каталог: \`${node.dir}\`, маршрут: \`${node.route ?? 'нет'}\``,
      `- Образ: \`${node.image ?? 'нет'}\``,
      `- Файлы окружения: ${node.envFiles.length > 0 ? node.envFiles.map((f) => `\`${f}\``).join(', ') : 'нет'}`,
      '',
      '## Зависит от',
      '',
      list(out(node.id, 'depends').map((e) => named(e.to))),
      '',
      '## Тома',
      '',
      list(out(node.id, 'mounts').map((e) => byId.get(e.to)?.title ?? e.to)),
      '',
      '## Ходит наружу',
      '',
      list(out(node.id, 'calls').map((e) => byId.get(e.to)?.title ?? e.to)),
      '',
      '## О нём',
      '',
      list(into(node.id, 'about').map((e) => named(e.from))),
    ].join('\n')

    note(
      noteOf.get(node.id),
      { type: 'day', id: node.key, title: node.title, date: node.date, day: n, tags: ['type/day', `day/${n}`] },
      'deploy/compose.yml',
      body,
    )
  }

  // --- сервисы ----------------------------------------------------------------

  for (const node of graph.nodes.filter((n) => n.type === 'service')) {
    const body = [
      `# ${node.title}`,
      '',
      node.note ?? '',
      '',
      '## Факты',
      '',
      `- Образ: \`${node.image ?? 'нет: статика за caddy'}\``,
      `- Файлы окружения: ${node.envFiles?.length > 0 ? node.envFiles.map((f) => `\`${f}\``).join(', ') : 'нет'}`,
      '',
      '## Зависит от',
      '',
      list(out(node.id, 'depends').map((e) => named(e.to))),
      '',
      '## Тома',
      '',
      list(out(node.id, 'mounts').map((e) => byId.get(e.to)?.title ?? e.to)),
      '',
      '## Отдаёт',
      '',
      list([...out(node.id, 'routes'), ...out(node.id, 'serves')].map((e) => named(e.to))),
      '',
      '## Ходит наружу',
      '',
      list([...out(node.id, 'calls'), ...out(node.id, 'image')].map((e) => byId.get(e.to)?.title ?? e.to)),
    ].join('\n')

    note(noteOf.get(node.id), { type: 'service', id: node.key, title: node.title, tags: ['type/service'] }, node.file, body)
  }

  // --- скиллы -----------------------------------------------------------------

  for (const node of graph.nodes.filter((n) => n.type === 'skill')) {
    const preloaded = into(node.id, 'preloads')
    const body = [
      `# ${node.title}`,
      '',
      node.description,
      '',
      '## Факты',
      '',
      `- Происхождение: ${node.vendored ? 'вендорный набор `addyosmani/agent-skills`' : 'собственный скилл проекта'}`,
      '',
      '## Предзагружают роли',
      '',
      list(preloaded.map((e) => named(e.from))),
    ].join('\n')

    note(noteOf.get(node.id), { type: 'skill', id: node.key, title: node.title, tags: ['type/skill'] }, node.file, body)
  }

  // --- классы гейтов ----------------------------------------------------------

  for (const node of graph.nodes.filter((n) => n.type === 'class')) {
    const body = [
      `# ${node.title}`,
      '',
      node.what,
      '',
      '## Гейты мержа',
      '',
      list(out(node.id, 'gates').map((e) => named(e.to))),
      '',
      node.note ? `> ${node.note}` : '',
    ].join('\n')

    note(noteOf.get(node.id), { type: 'class', id: node.key, title: node.title, tags: ['type/class'] }, node.source, body)
  }

  // --- фазы цикла -------------------------------------------------------------

  const phases = graph.nodes.filter((n) => n.type === 'phase').sort((a, b) => a.n - b.n)
  for (const [i, node] of phases.entries()) {
    const next = phases[i + 1]
    const body = [
      `# ${node.n}. ${node.title}`,
      '',
      '## Роли',
      '',
      list(out(node.id, 'runs').map((e) => named(e.to))),
      '',
      '## Критерий выхода',
      '',
      wikilinked(node.exit),
      '',
      node.human ? '> Человеческий гейт: фаза не проходится без слова владельца.' : '',
      '',
      next ? `Следующая фаза: ${link(next.id)}` : 'Последняя фаза цикла.',
    ].join('\n')

    note(
      noteOf.get(node.id),
      { type: 'phase', id: node.key, title: node.title, human: node.human, tags: ['type/phase'] },
      node.source,
      body,
    )
  }

  // --- карта --------------------------------------------------------------------

  const counts = {}
  for (const f of files) {
    const dir = f.path.slice(0, f.path.indexOf('/'))
    counts[dir] = (counts[dir] ?? 0) + 1
  }
  note(
    'index',
    { type: 'index', id: 'index', title: 'Атлас проекта', tags: ['type/index'] },
    'atlas/build.js',
    [
      '# Атлас проекта',
      '',
      `Производная копия репозитория на коммит \`${provenance.sha}\`. Правки — в репозиторий, не здесь.`,
      '',
      '## Точки входа',
      '',
      // Из карты должно быть куда перейти: без ссылок она висит в графе
      // Obsidian отдельным узлом.
      list(
        [
          link('guide/agents') && `${link('guide/agents')} — правила работы над проектом`,
          link('guide/architecture') && `${link('guide/architecture')} — архитектура`,
          '[[guides/invariants]] — инварианты продукта',
          phases[0] && `${link(phases[0].id)} — первая фаза цикла дня`,
          ...graph.nodes.filter((n) => n.type === 'class').map((n) => `${link(n.id)} — ${n.what}`),
        ].filter(Boolean),
      ),
      '',
      '## Разделы',
      '',
      list(
        Object.entries(counts)
          .sort()
          .map(([dir, n]) => `\`${dir}/\` — ${n}`),
      ),
      '',
      `Заметок всего: ${files.length + 1}.`,
    ].join('\n'),
  )

  return files
}
