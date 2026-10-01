"""Инструменты `project.search` и `project.status`.

Главное здесь — ПОРЯДОК: проверка предшествует расходу. Потому почти каждая
проверка смотрит не только на ответ, но и на то, позвали ли эмбеддер и
потратился ли суточный потолок.
"""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

import limits
import rpc
import serve
import tools
from index import VectorIndex


class FakeEmbedder:
    """Эмбеддер, который считает свои вызовы. Настоящий в тестах не зовут."""

    def __init__(self, vector=None, fail: Exception | None = None) -> None:
        self.calls = []
        self.vector = vector if vector is not None else [1.0, 0.0]
        self.fail = fail

    def embed(self, texts, timeout=None):
        self.calls.append((list(texts), timeout))
        if self.fail is not None:
            raise self.fail
        return [list(self.vector) for _ in texts]


def meta(source, section, text, commit="a1b2c3d", strategy="structural"):
    return {
        "source": source,
        "title": source.rsplit("/", 1)[-1],
        "section": section,
        "chunk_id": f"{source}#{section}",
        "strategy": strategy,
        "sha256": "0" * 64,
        "commit": commit,
        "text": text,
    }


class ToolsCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.indexes = tools.Indexes(self.dir, "модель:latest")
        self.embedder = FakeEmbedder()
        self.cap = limits.DailyCap(self.dir / "usage.json", limit=3, today=lambda: "2026-09-30")
        self.status = serve.Status()

    def write_index(self, strategy="structural", commit="a1b2c3d"):
        rows = [
            meta("agent_docs/invariants.md", "I-4 > лимит", "лимит проверяется до вызова", commit, strategy),
            meta("AGENTS.md", "Роли агентов", "роли определены во фронтматтере", commit, strategy),
        ]
        vectors = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype="float32")
        VectorIndex.build(strategy, rows, vectors, "модель:latest").save(self.dir)

    def search(self, **args):
        tool = tools.make_search(self.indexes, self.embedder, self.cap)
        ok, value = tool.parse(args)
        self.assertTrue(ok, value)
        return tool.run(value)


class ParseTest(ToolsCase):
    def tool(self):
        return tools.make_search(self.indexes, self.embedder, self.cap)

    def test_пустой_запрос_не_принимается(self):
        for bad in ({}, {"query": ""}, {"query": "   "}, {"query": 5}):
            ok, err = self.tool().parse(bad)
            self.assertFalse(ok, bad)
            self.assertIn("query", err)

    def test_умолчания_это_пять_и_структурная(self):
        ok, value = self.tool().parse({"query": "лимитер"})
        self.assertTrue(ok)
        self.assertEqual(value["limit"], tools.DEFAULT_LIMIT)
        self.assertEqual(value["strategy"], "structural")

    def test_предел_выдачи_десять(self):
        self.assertFalse(self.tool().parse({"query": "x", "limit": 11})[0])
        self.assertTrue(self.tool().parse({"query": "x", "limit": 10})[0])
        self.assertFalse(self.tool().parse({"query": "x", "limit": 0})[0])

    def test_булево_не_проходит_за_число(self):
        # `bool` — подкласс `int`, и без отдельной проверки `limit: true`
        # прошёл бы как единица.
        self.assertFalse(self.tool().parse({"query": "x", "limit": True})[0])

    def test_чужая_стратегия_не_принимается(self):
        self.assertFalse(self.tool().parse({"query": "x", "strategy": "bm25"})[0])

    def test_нестрока_в_стратегии_это_отказ_разбора_а_не_исключение(self):
        # `in` по словарю хеширует ключ: без проверки типа объект или массив
        # давал TypeError мимо `try` в rpc.py, то есть HTTP 500 вместо
        # отказа инструмента (находка гейтов к PR #282).
        for bad in ({}, [], {"a": 1}, ["structural"], 5, None):
            ok, err = self.tool().parse({"query": "x", "strategy": bad})
            self.assertFalse(ok, repr(bad))
            self.assertIn("strategy", err)

    def test_слишком_длинный_запрос_не_эмбеддится(self):
        ok, err = self.tool().parse({"query": "щ" * (tools.MAX_QUERY + 1)})
        self.assertFalse(ok)
        self.assertIn("длиннее", err)
        self.assertEqual(self.embedder.calls, [], "эмбеддер позван на разборе")


class OrderTest(ToolsCase):
    """Проверка предшествует расходу — I-4 по духу."""

    def test_без_индекса_эмбеддер_не_зовётся_и_потолок_не_тратится(self):
        self.indexes.load()
        with self.assertRaises(rpc.ToolError) as caught:
            self.search(query="лимитер")
        self.assertEqual(str(caught.exception), tools.NO_INDEX)
        self.assertEqual(self.embedder.calls, [], "эмбеддер позван без индекса")
        self.assertEqual(self.cap.state()["used"], 0, "потолок потрачен без индекса")

    def test_нет_индекса_нужной_стратегии_тоже_без_эмбеддера(self):
        self.write_index("structural")
        self.indexes.load()
        with self.assertRaises(rpc.ToolError) as caught:
            self.search(query="лимитер", strategy="fixed")
        self.assertEqual(str(caught.exception), tools.NO_STRATEGY_INDEX)
        self.assertEqual(self.embedder.calls, [])
        self.assertEqual(self.cap.state()["used"], 0)

    def test_исчерпанный_потолок_останавливает_до_вызова_эмбеддера(self):
        self.write_index()
        self.indexes.load()
        for _ in range(3):
            self.search(query="лимитер")
        self.assertEqual(len(self.embedder.calls), 3)
        with self.assertRaises(rpc.ToolError) as caught:
            self.search(query="лимитер")
        self.assertEqual(str(caught.exception), tools.DAILY_EXHAUSTED)
        self.assertEqual(len(self.embedder.calls), 3, "эмбеддер позван поверх потолка")

    def test_каждый_поиск_тратит_ровно_один_вызов(self):
        self.write_index()
        self.indexes.load()
        self.search(query="лимитер", limit=10)
        self.assertEqual(self.cap.state()["used"], 1)

    def test_отказ_эмбеддера_не_выдаёт_его_адрес(self):
        self.write_index()
        self.indexes.load()
        self.embedder.fail = RuntimeError("/api/embed: нет связи с http://ollama:11434")
        with self.assertRaises(rpc.ToolError) as caught:
            self.search(query="лимитер")
        self.assertEqual(str(caught.exception), tools.EMBED_FAILED)
        self.assertNotIn("11434", str(caught.exception))

    def test_срок_вызова_у_запроса_свой_а_не_сборочный(self):
        self.write_index()
        self.indexes.load()
        self.search(query="лимитер")
        self.assertEqual(self.embedder.calls[0][1], tools.QUERY_TIMEOUT)
        self.assertLess(tools.QUERY_TIMEOUT, 600.0, "поиск ждёт столько же, сколько сборка")


class SearchResultTest(ToolsCase):
    def test_выдача_несёт_источник_раздел_и_близость(self):
        self.write_index()
        self.indexes.load()
        answer = self.search(query="лимитер", limit=2)
        first = answer["results"][0]
        self.assertEqual(first["source"], "agent_docs/invariants.md")
        self.assertEqual(first["section"], "I-4 > лимит")
        self.assertAlmostEqual(first["score"], 1.0, places=3)
        self.assertEqual(answer["index"]["strategy"], "structural")
        self.assertEqual(answer["index"]["chunks"], 2)

    def test_limit_режет_число_результатов(self):
        self.write_index()
        self.indexes.load()
        self.assertEqual(len(self.search(query="лимитер", limit=1)["results"]), 1)
        self.assertEqual(len(self.search(query="лимитер", limit=2)["results"]), 2)

    def test_выдержка_режется_и_рез_назван(self):
        long = "щ" * (tools.MAX_TEXT + 500)
        rows = [meta("a.md", "s", long)]
        VectorIndex.build("structural", rows, np.asarray([[1.0, 0.0]], dtype="float32"), "модель:latest").save(self.dir)
        self.indexes.load()
        result = self.search(query="x")["results"][0]
        self.assertEqual(len(result["text"]), tools.MAX_TEXT)
        self.assertTrue(result["truncated"])

    def test_весь_ответ_не_больше_потолка(self):
        rows = [meta(f"f{i}.md", "s", "щ" * tools.MAX_TEXT) for i in range(10)]
        vectors = np.asarray([[1.0, 0.0]] * 10, dtype="float32")
        VectorIndex.build("structural", rows, vectors, "модель:latest").save(self.dir)
        self.indexes.load()
        answer = self.search(query="x", limit=10)
        size = len(json.dumps(answer, ensure_ascii=False).encode("utf-8"))
        self.assertLessEqual(size, tools.MAX_ANSWER)
        # И урезание названо: иначе «нашлось десять» и «отдали три» стали бы
        # неразличимы для вызывающего.
        self.assertGreater(answer["dropped"], 0)
        self.assertLess(len(answer["results"]), 10)

    def test_ни_адреса_ни_заголовков_в_ответе_нет(self):
        self.write_index()
        self.indexes.load()
        keys = set()
        for result in self.search(query="лимитер", limit=2)["results"]:
            keys |= set(result)
        self.assertEqual(keys, {"source", "title", "section", "score", "text", "truncated"})


class IndexesTest(ToolsCase):
    def test_пустой_том_это_ничего_не_загружено(self):
        self.assertEqual(self.indexes.load(), [])
        self.assertFalse(self.indexes.any_loaded)
        self.assertEqual(self.indexes.state()["commit"], "unknown")

    def test_обе_стратегии_загружаются_рядом(self):
        self.write_index("structural")
        self.write_index("fixed")
        self.assertEqual(sorted(self.indexes.load()), ["fixed", "structural"])
        self.assertEqual(self.indexes.state()["chunks"], {"fixed": 2, "structural": 2})

    def test_коммит_индекса_берётся_из_метаданных_а_не_из_образа(self):
        # Ради этого он и нужен: расхождение с COMMIT образа — единственный
        # признак того, что индекс отстал от выкатки.
        self.write_index(commit="deadbee")
        self.indexes.load()
        self.status.update(commit="0123456")
        self.assertEqual(self.indexes.commit(), "deadbee")

    def test_половина_пары_не_считается_индексом(self):
        self.write_index()
        (self.dir / "structural.meta.json").unlink()
        self.assertEqual(self.indexes.load(), [])


class StatusToolTest(ToolsCase):
    def tool(self):
        return tools.make_status(self.status, self.indexes, self.cap)

    def run_status(self):
        ok, value = self.tool().parse({})
        self.assertTrue(ok)
        return self.tool().run(value)

    def test_состояние_сборки_и_загруженного_индекса_это_разные_поля(self):
        # Сборка не удалась, а в томе целая пара — служба ищет и говорит, по
        # чему именно (ADR п. 6).
        self.write_index(commit="deadbee")
        self.indexes.load()
        self.status.update(state="failed", error=serve.NO_EMBEDDER, commit="0123456")
        answer = self.run_status()
        self.assertEqual(answer["build"]["state"], "failed")
        self.assertEqual(answer["build"]["error"], serve.NO_EMBEDDER)
        self.assertEqual(answer["build"]["commit"], "0123456")
        self.assertEqual(answer["index"]["commit"], "deadbee")
        self.assertEqual(answer["index"]["strategies"], ["structural"])

    def test_остаток_суточного_потолка_виден(self):
        self.write_index()
        self.indexes.load()
        self.search(query="лимитер")
        daily = self.run_status()["daily"]
        self.assertEqual(daily, {"limit": 3, "used": 1, "remaining": 2})

    def test_состояние_ничего_не_тратит(self):
        self.write_index()
        self.indexes.load()
        for _ in range(5):
            self.run_status()
        self.assertEqual(self.embedder.calls, [])
        self.assertEqual(self.cap.state()["used"], 0)

    def test_причина_отказа_остаётся_из_закрытого_набора(self):
        self.status.update(state="failed", error=serve.TOO_LONG)
        self.assertIn(self.run_status()["build"]["error"], serve.REASONS)


if __name__ == "__main__":
    unittest.main()


class ОтвергнутыйИндексВиденСнаружи(unittest.TestCase):
    """«Пара в томе есть, но не подошла» не должно выглядеть как «тома нет».

    После смены модели это ровно то состояние, в котором окажется служба, и
    без отдельного поля владелец на /healthz увидит пустой индекс без причины.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        мета = [{"source": "x.md", "section": "s", "chunk_id": "c", "sha256": "0" * 64,
                 "text": "t", "strategy": "fixed"}]
        VectorIndex.build("fixed", мета, np.asarray([[1.0, 0.0]], dtype="float32"),
                          "старая").save(self.dir)

    def test_индекс_чужой_модели_попадает_в_rejected(self):
        indexes = tools.Indexes(self.dir, "новая")
        indexes.load()
        self.assertEqual(indexes.state()["strategies"], [])
        self.assertEqual(indexes.state()["rejected"], ["fixed"],
                         "отвергнутая пара неотличима от отсутствующей")

    def test_пустой_том_не_даёт_rejected(self):
        # Контроль: иначе «rejected» выполнялось бы всегда и ничего не значило.
        indexes = tools.Indexes(Path(self.tmp.name) / "нет-такого", "новая")
        indexes.load()
        self.assertEqual(indexes.state()["rejected"], [])

    def test_своя_модель_не_попадает_в_rejected(self):
        indexes = tools.Indexes(self.dir, "старая")
        indexes.load()
        self.assertEqual(indexes.state()["strategies"], ["fixed"])
        self.assertEqual(indexes.state()["rejected"], [])
