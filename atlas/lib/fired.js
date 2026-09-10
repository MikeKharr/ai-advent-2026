// «Правило → где сработало»: следы гейтов в записях истории.
// Правило — раздел «Правило → где сработало» проекта решения
// agent_docs/design/2026-09-13-2000-project-atlas.md (уточнён после ревью
// этапа 1). Здесь оно и живёт целиком, чтобы читалось как правило, а не
// собиралось по кускам.

import { clip } from './markdown.js'

/** Буква слова — с кириллицей: `\b` в JS её не знает и режет «ответов» на «вето». */
const W = 'A-Za-zА-Яа-яЁё0-9_'
const word = (body) => new RegExp(`(?<![${W}])(?:${body})(?![${W}])`, 'i')

/** Признак срабатывания гейта. */
const MARKS = [word('вето'), word('блокирующ[а-яё]*'), word('находк[а-яё]*'), word('правки'), word('переделать')]

/**
 * Отрицание в том же фрагменте: «вето нет», «блокирующих нет», «без вето»,
 * «нет находок», «не ставил / не наложил / не дал».
 */
const NEGATIONS = [
  word('нет'),
  // «без» — только рядом с самим признаком: «снял вето без условий» — след,
  // «пройдено без вето» — нет.
  word('без\\s+(?:вето|находок|блокирующих|правок|переделки)'),
  word('не\\s+(?:ставил|наложил|дал)'),
]

/**
 * Имя роли: без учёта регистра, но не внутри пути (`design/corpus.md`) и не
 * куском составного имени (`design` из `design-review`).
 */
const roleRe = (role) => new RegExp(`(?<![${W}/-])${role}(?![${W}/-])`, 'i')

/**
 * Единицы привязки в строке. Строка таблицы — одна единица целиком: роль в
 * одной ячейке, признак в другой — это одно срабатывание. Прозаическая строка
 * делится по `;` и по концу предложения.
 */
function fragments(line) {
  if (line.trimStart().startsWith('|')) return [line]
  return line.split(/;|(?<=[.!?])\s+/)
}

/**
 * Следы в тексте записи истории.
 * @param {string} text
 * @param {Set<string>} roleNames имена ролей из .claude/agents/
 * @returns {Array<{role:string, line:number, excerpt:string}>}
 */
export function firedTraces(text, roleNames) {
  const traces = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // Дедупликации по паре «роль → документ» нет; по паре «роль → строка» есть.
    const onThisLine = new Set()

    for (const fragment of fragments(line)) {
      if (!MARKS.some((re) => re.test(fragment))) continue
      if (NEGATIONS.some((re) => re.test(fragment))) continue

      for (const role of roleNames) {
        if (onThisLine.has(role) || !roleRe(role).test(fragment)) continue
        onThisLine.add(role)
        traces.push({ role, line: i + 1, excerpt: clip(line.replace(/^[-*\s>]+/, '').trim()) })
      }
    }
  }
  return traces
}
