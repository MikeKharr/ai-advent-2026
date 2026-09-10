// Узкий парсер подмножества compose.yml: только то, из чего строится граф —
// имена сервисов, образ, `depends_on`, `volumes`, `env_file` и верхний блок
// `volumes:`. Полноценный YAML не нужен и означал бы зависимость
// (ADR 2026-09-07-1525).
//
// Подмножество узкое намеренно, поэтому парсер обязан говорить, где он
// перестал понимать файл: строка в блоке сервиса или в блоке томов, не
// подошедшая ни под один шаблон, возвращается находкой. Гейт падает закрыто —
// граф не обедняется молча.

/** Ключи, которые парсер читает: внутри них форма важна. */
const PARSED_KEYS = new Set(['depends_on', 'volumes', 'env_file'])

/** Отрезает хвостовой комментарий: `- v:/data   # тома переживают пересоздание`. */
function stripComment(s) {
  const m = s.match(/^(.*?)\s+#.*$/)
  return (m ? m[1] : s).trim()
}

/**
 * @param {string} text содержимое compose.yml
 * @returns {{services: Array<{name:string,image:string|null,dependsOn:string[],
 *   volumes:Array<{source:string,target:string,named:boolean}>,envFiles:string[]}>,
 *   volumes: string[], findings: Array<{line:number, message:string}>}}
 */
export function parseCompose(text) {
  const services = []
  const volumeNames = []
  const findings = []

  let section = null // 'services' | 'volumes' | null
  let service = null // текущий сервис
  let key = null // текущий ключ внутри сервиса

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const at = i + 1
    const unknown = (what) =>
      findings.push({
        line: at,
        message: `строка вне подмножества парсера compose (${what}): ${stripComment(raw).slice(0, 60)}`,
      })

    if (raw.trim() === '' || /^\s*#/.test(raw)) continue

    const top = raw.match(/^([a-z_]+):\s*$/)
    if (top) {
      section = top[1] === 'services' || top[1] === 'volumes' ? top[1] : null
      service = null
      key = null
      continue
    }

    if (section === null) continue

    const second = raw.match(/^ {2}([a-z0-9_.-]+):\s*(.*)$/)
    if (second) {
      const inline = stripComment(second[2])
      if (section === 'services') {
        service = { name: second[1], image: null, dependsOn: [], volumes: [], envFiles: [] }
        services.push(service)
        key = null
        if (inline !== '') unknown('сервис задан в строку')
      } else if (inline === '' || inline === '{}') {
        volumeNames.push(second[1])
      } else {
        unknown('том с настройками')
      }
      continue
    }

    if (section === 'volumes') {
      unknown('настройки тома в верхнем блоке')
      continue
    }

    if (!service) {
      unknown('строка вне блока сервиса')
      continue
    }

    // Дефис в классе — ради расширений `x-*`, которые compose разрешает
    // на любом уровне: они не наши, но и не выход за подмножество.
    const field = raw.match(/^ {4}([a-z_-]+):\s*(.*)$/)
    if (field) {
      key = field[1]
      const inline = stripComment(field[2])
      if (key === 'image' && inline) service.image = inline
      else if (PARSED_KEYS.has(key) && inline !== '') unknown(`${key} задан в строку`)
      continue
    }

    const item = raw.match(/^ {6}- (.+)$/)
    if (item) {
      const value = stripComment(item[1])
      if (key === 'depends_on') service.dependsOn.push(value)
      else if (key === 'env_file') {
        const path = value.match(/^path:\s*(.+)$/)
        if (path) service.envFiles.push(path[1])
        else if (/:/.test(value)) unknown('env_file в неизвестной форме')
        else service.envFiles.push(value)
      } else if (key === 'volumes') {
        if (/^(type|source|target|read_only|bind|volume):/.test(value)) {
          unknown('том в длинной форме')
          continue
        }
        // `источник:цель[:режим]`; именованный том — тот, чей источник не путь.
        const parts = value.replace(/^"|"$/g, '').split(':')
        const source = parts[0]
        const target = parts[1] ?? ''
        service.volumes.push({ source, target, named: !source.startsWith('.') && !source.startsWith('/') })
      }
      continue
    }

    // Строка глубже элемента списка: у разбираемых ключей допустима только
    // длинная форма `env_file`, всё прочее — выход за подмножество.
    if (PARSED_KEYS.has(key)) {
      if (key === 'env_file' && /^ {8}(required|path):/.test(raw)) continue
      unknown(`${key} в форме, которую парсер не читает`)
      continue
    }

    // Ключи, которые парсер не разбирает (logging, environment, ports…):
    // их внутренности графа не касаются.
    if (key !== null && /^ {6,}\S/.test(raw)) continue

    unknown('неизвестная строка в блоке сервиса')
  }

  // Признак `named` верен только относительно верхнего блока volumes:
  // источник без точки и слэша, которого нет в блоке, — не наш том.
  for (const s of services) {
    for (const v of s.volumes) v.named = v.named && volumeNames.includes(v.source)
  }

  return { services, volumes: volumeNames, findings }
}
