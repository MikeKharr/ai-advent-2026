"""Инструменты MCP: `project.search` и `project.status`.

Порядок в `search` читается сверху вниз и таков намеренно (I-4 по духу:
проверка предшествует расходу, а не следует за ним):

  1) индекса нет — отказ БЕЗ вызова эмбеддера и без траты суточного потолка;
  2) суточный потолок — ДО вызова эмбеддера;
  3) и только теперь вектор запроса, поиск и выдача.

Ни адреса, ни заголовков запроса, ни признаков устройства ни в одном ответе
нет (ADR 2026-09-29-2139, п. 2). Наружу уходит то, что и так лежит в
корпусе: путь файла, заголовок, раздел и выдержка.
"""

from __future__ import annotations

import json
import os

import chunking
from index import VectorIndex
from rpc import Tool, ToolError

# Сколько результатов отдаём. Потолок из ADR п. 2; умолчание — пять.
MAX_LIMIT = 10
DEFAULT_LIMIT = 5

# Выдержка одного чанка и потолок всего ответа — ADR п. 2. Чанк структурной
# стратегии доходит до 3000 знаков, поэтому рез в 2000 виден на глаз, и об
# этом ответ говорит прямо полем `truncated`.
MAX_TEXT = 2000
MAX_ANSWER = 32 * 1024

# Длиннее этого запрос не эмбеддим: у модели своё окно, а длинный запрос —
# это не вопрос, а вставленный файл.
MAX_QUERY = 1000

# Умолчание стратегии — СТРУКТУРНАЯ, и это выбор без числа (ADR п. 3). Меру
# стратегий считает заход 5; довод умолчания слабый и назван слабым:
# структурная несёт цепочку заголовков в `section`, то есть её результат
# читается без открытия файла. Аргумент `strategy` существует ровно потому,
# что числа нет — заход 5 меняет эту строку, если число скажет иначе.
DEFAULT_STRATEGY = "structural"

# Срок вызова эмбеддера для ОДНОГО запроса — не тот, что у сборки (600 с).
# Поиск занимает поток службы, и десять минут ожидания на публичном маршруте
# значили бы, что десяток запросов выводит службу из строя без всякого
# перебора. Число НЕ ИЗМЕРЕНО: оно заведомо больше одного вызова на свободной
# машине (локально — доли секунды) и заведомо больше одного батча из
# шестнадцати чанков, за которым запрос стоит в очереди во время сборки
# (`OLLAMA_NUM_PARALLEL=1`, deploy/compose.yml). Что его поправит — первый
# замер времени ответа `project.search` на VPS во время сборки.
QUERY_TIMEOUT = float(os.environ.get("RAG_QUERY_TIMEOUT_SECONDS", "60"))

NO_INDEX = (
    "индекса нет: сборка не завершилась и в томе нет целой пары файлов. "
    "Состояние сборки — в project.status."
)
NO_STRATEGY_INDEX = "индекса этой стратегии нет; что загружено — в project.status"
DAILY_EXHAUSTED = "суточный потолок вызовов эмбеддинга исчерпан; счёт обнуляется в полночь UTC"
EMBED_FAILED = "эмбеддер не ответил — вектор запроса получить не удалось"


class Indexes:
    """Что загружено в память. Не то же, что состояние сборки.

    Поле `state` у `Status` описывает СБОРКУ, а этот объект — то, что можно
    искать прямо сейчас. Они расходятся намеренно (ADR п. 6): сборка могла не
    удаться, а в томе лежать целая пара файлов с прошлой выкатки — тогда
    служба ищет по ней и называет её `commit`, отличный от `COMMIT` образа.

    **Цена сверки модели, названная прямо.** Пара из тома подхватывается,
    только если собрана ТОЙ ЖЕ моделью. При смене модели (ADR 2026-09-30-0957)
    индекс прошлой выкатки отвергается, и служба остаётся без поиска до конца
    пересборки — часы; а если проход снова убьют по памяти, то без поиска
    вовсе. Это выбор защиты вместо доступности: искать по индексу чужой модели
    нельзя — векторы одной размерности, смесь не даёт ни ошибки, ни признака.

    Это НЕ починка дефекта «сборка не возобновляется после единственного
    отказа» (он в agent_docs/backlog.md, решение за владельцем), а то, что
    делает его последствие переживаемым — пока модель не менялась.
    """

    def __init__(self, index_dir, model: str) -> None:
        self.index_dir = index_dir
        self.model = model
        self._loaded: dict[str, VectorIndex] = {}

    def load(self) -> list[str]:
        """Перечитать том. Возвращает имена загруженных стратегий."""
        loaded = {}
        отвергнуто = []
        for strategy in chunking.STRATEGIES:
            index = VectorIndex.load(self.index_dir, strategy, self.model)
            if index is None and VectorIndex.paths(self.index_dir, strategy)[0].is_file():
                # Пара в томе ЕСТЬ, но не подошла — чужая модель либо разъехавшиеся
                # длины. Без этого «отвергнут» неотличим от «тома нет», а именно
                # это состояние службы сразу после смены модели.
                отвергнуто.append(strategy)
            if index is not None and index.index.ntotal > 0:
                loaded[strategy] = index
        self._loaded = loaded
        self._отвергнуто = sorted(отвергнуто)
        return list(loaded)

    def get(self, strategy: str) -> VectorIndex | None:
        return self._loaded.get(strategy)

    @property
    def any_loaded(self) -> bool:
        return bool(self._loaded)

    def commit(self) -> str:
        """Коммит корпуса, ИЗ КОТОРОГО собран загруженный индекс.

        Берётся из метаданных чанка, а не из `COMMIT` образа: именно их
        расхождение и есть признак того, что индекс отстал от выкатки.
        """
        for index in self._loaded.values():
            if index.meta:
                return str(index.meta[0].get("commit", "unknown"))
        return "unknown"

    def state(self) -> dict:
        # Модель служащего индекса наружу. Ветвь «разные модели» недостижима:
        # в `_loaded` попадают только прошедшие сверку с `self.model` — это
        # заметил reviewer, и прежний комментарий обещал наблюдаемость, которой
        # в этой схеме быть не может. Полезный сигнал другой: `rejected`.
        return {
            "commit": self.commit(),
            "model": self.model if self._loaded else "",
            # Стратегии, чья пара в томе ЕСТЬ, но не подошла. Без этого поля
            # «индекс отвергнут» неотличимо от «тома нет» — а после смены
            # модели это ровно то, что увидит владелец на /healthz.
            "rejected": list(getattr(self, "_отвергнуто", [])),
            "strategies": sorted(self._loaded),
            "chunks": {name: idx.index.ntotal for name, idx in sorted(self._loaded.items())},
        }


def _parse_search(args: dict) -> tuple[bool, object]:
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return False, "нужен непустой query"
    if len(query) > MAX_QUERY:
        return False, f"query длиннее {MAX_QUERY} знаков"

    limit = args.get("limit", DEFAULT_LIMIT)
    # `bool` — подкласс `int`, и без этой проверки `limit: true` прошёл бы
    # как единица.
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        return False, f"limit — целое от 1 до {MAX_LIMIT}"

    strategy = args.get("strategy", DEFAULT_STRATEGY)
    # `isinstance` ДО проверки принадлежности, а не вместе с ней: `in` по
    # словарю хеширует ключ, и `strategy` объектом или массивом давал
    # `TypeError` мимо `try` в `rpc.py` — то есть HTTP 500 вместо отказа
    # инструмента, против докстроки `Tool` («отказ разбора — отказ
    # ИНСТРУМЕНТА, а не протокола»). Находка гейтов к PR #282.
    if not isinstance(strategy, str) or strategy not in chunking.STRATEGIES:
        return False, f"strategy — одно из: {', '.join(sorted(chunking.STRATEGIES))}"

    return True, {"query": query.strip(), "limit": limit, "strategy": strategy}


def _fit(answer: dict) -> dict:
    """Урезать выдачу до потолка ответа, отбрасывая с хвоста.

    С хвоста, а не с головы: результаты идут по убыванию близости, и дешевле
    всего расстаться с самым дальним. Ответ говорит об урезании полем
    `dropped`, иначе «нашлось три» и «отдали три» стали бы неразличимы.
    """
    dropped = 0
    while len(json.dumps(answer, ensure_ascii=False).encode("utf-8")) > MAX_ANSWER and answer["results"]:
        answer["results"].pop()
        dropped += 1
        answer["dropped"] = dropped
    return answer


def make_search(indexes: Indexes, embedder, daily_cap) -> Tool:
    def run(value: dict) -> dict:
        # 1. Индекс. Нет — отказ ДО эмбеддера и без траты потолка.
        if not indexes.any_loaded:
            raise ToolError(NO_INDEX)
        index = indexes.get(value["strategy"])
        if index is None:
            raise ToolError(NO_STRATEGY_INDEX)

        # 2. Суточный потолок — ДО вызова эмбеддера, а не после.
        allowed, _remaining = daily_cap.take(1)
        if not allowed:
            raise ToolError(DAILY_EXHAUSTED)

        # 3. И только теперь расход. Запрос эмбеддится как есть: цепочку
        # заголовков к нему не приписывают, потому что у вопроса её нет —
        # ту же асимметрию имеет любой поиск по эмбеддингам.
        try:
            vector = embedder.embed([value["query"]], QUERY_TIMEOUT)[0]
        except Exception as err:
            raise ToolError(EMBED_FAILED) from err

        results = []
        for score, meta in index.search(vector, value["limit"]):
            text = meta.get("text", "")
            results.append(
                {
                    "source": meta.get("source", ""),
                    "title": meta.get("title", ""),
                    "section": meta.get("section", ""),
                    "score": round(score, 4),
                    "text": text[:MAX_TEXT],
                    "truncated": len(text) > MAX_TEXT,
                }
            )
        return _fit(
            {
                "index": {
                    "commit": indexes.commit(),
                    "strategy": value["strategy"],
                    "chunks": index.index.ntotal,
                },
                "results": results,
            }
        )

    return Tool(
        name="project.search",
        title="Поиск по проекту",
        description=(
            "Поиск по корпусу репозитория ai-advent-2026 (документы agent_docs, AGENTS.md, "
            "README и код живых единиц) векторами. Индекс собран из корпуса последней выкатки "
            "main — поле index.commit говорит, из какого именно."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "вопрос или фраза"},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "default": DEFAULT_LIMIT},
                "strategy": {
                    "type": "string",
                    "enum": sorted(chunking.STRATEGIES),
                    "default": DEFAULT_STRATEGY,
                    "description": "нарезка корпуса; умолчание выбрано без меры, см. ADR 2026-09-29-2139 п. 3",
                },
            },
            "required": ["query"],
        },
        parse=_parse_search,
        run=run,
    )


def make_status(status, indexes: Indexes, daily_cap) -> Tool:
    def run(_value: dict) -> dict:
        state = status.read()
        return {
            # Сборка: её состояние и причина отказа из закрытого набора.
            "build": {
                "state": state.get("state"),
                "error": state.get("error"),
                "commit": state.get("commit"),
                "strategies": state.get("strategies") or [],
            },
            # Что загружено в память прямо сейчас. Расхождение `index.commit`
            # с `build.commit` и есть признак отставшего индекса.
            "index": indexes.state(),
            "daily": daily_cap.state(),
        }

    return Tool(
        name="project.status",
        title="Состояние индекса",
        description=(
            "Состояние сборки индекса, что загружено в память и остаток суточного потолка "
            "вызовов эмбеддинга."
        ),
        input_schema={"type": "object", "properties": {}},
        parse=lambda _args: (True, {}),
        run=run,
    )
