import os
import tempfile
import unittest
from pathlib import Path

import build
import chunking
import corpus
from embed import EmbedError, OllamaEmbedder
from test.fakeollama import FakeOllama

ROUTES = {"/api/embed": (200, FakeOllama.deterministic)}


def corpus_tree(root: Path) -> None:
    (root / "agent_docs").mkdir(parents=True)
    (root / "AGENTS.md").write_text("# Правила\n\nтело правил\n", encoding="utf-8")
    (root / "agent_docs" / "invariants.md").write_text(
        "# Инварианты\n\n## I-4\n\nлимит до вызова\n", encoding="utf-8"
    )
    (root / "COMMIT").write_text("deadbeef\n", encoding="utf-8")


class ReadChunksTest(unittest.TestCase):
    def test_чанки_несут_коммит_корпуса_и_путь_источника(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            corpus_tree(root)
            chunks = build.read_chunks(root, "structural")
            self.assertTrue(chunks)
            self.assertEqual({c.commit for c in chunks}, {"deadbeef"})
            self.assertEqual({c.source for c in chunks}, {"AGENTS.md", "agent_docs/invariants.md"})
            self.assertEqual({c.strategy for c in chunks}, {"structural"})


class IncrementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "corpus"
        self.index = Path(self.tmp.name) / "index"
        corpus_tree(self.root)

    def build_once(self, fake) -> dict:
        embedder = OllamaEmbedder(fake.url, "m")
        chunks = build.read_chunks(self.root, "fixed")
        return build.build_strategy("fixed", chunks, embedder, self.index)

    def test_первая_сборка_эмбеддит_все_чанки(self):
        with FakeOllama(ROUTES) as fake:
            stats = self.build_once(fake)
            self.assertEqual(stats["embedded"], stats["count"])
            self.assertEqual(stats["reused"], 0)
            self.assertGreater(stats["embed_calls"], 0)

    def test_повтор_без_правок_не_зовёт_эмбеддер_вовсе(self):
        with FakeOllama(ROUTES) as fake:
            first = self.build_once(fake)
            second = self.build_once(fake)
        self.assertEqual(second["embedded"], 0)
        self.assertEqual(second["embed_calls"], 0)
        self.assertEqual(second["reused"], first["count"])

    def test_правка_документа_переэмбеддит_только_изменившееся(self):
        with FakeOllama(ROUTES) as fake:
            first = self.build_once(fake)
            (self.root / "AGENTS.md").write_text("# Правила\n\nдругое тело\n", encoding="utf-8")
            second = self.build_once(fake)
        self.assertEqual(second["embedded"], 1)
        self.assertEqual(second["reused"], first["count"] - 1)

    def test_размер_пачки_задаёт_число_вызовов(self):
        with FakeOllama(ROUTES) as fake:
            embedder = OllamaEmbedder(fake.url, "m")
            chunks = build.read_chunks(self.root, "fixed")
            stats = build.build_strategy("fixed", chunks, embedder, self.index, batch=1)
        self.assertEqual(stats["embed_calls"], stats["count"])


class StatsTest(unittest.TestCase):
    def test_статистика_чанков_считает_медиану_и_долю_разрезанных(self):
        chunks = [
            chunking.Chunk("a.md", "t", "", "a.md#0", "fixed", "```js\nconst a = 1"),
            chunking.Chunk("a.md", "t", "", "a.md#1", "fixed", "```\nхвост"),
            chunking.Chunk("b.md", "t", "", "b.md#0", "fixed", "целый текст"),
        ]
        stats = build.chunk_stats(chunks)
        self.assertEqual(stats["count"], 3)
        self.assertEqual(stats["median_chars"], len("целый текст"))
        self.assertAlmostEqual(stats["cut_blocks_share"], 2 / 3, places=3)

    def test_пустой_набор_не_делит_на_ноль(self):
        self.assertEqual(build.chunk_stats([])["count"], 0)


if __name__ == "__main__":
    unittest.main()


class DeadlineTest(unittest.TestCase):
    """Потолок на ПРОХОД сборки — ADR 2026-09-29-1639, заход 3; п. 6 списка
    «что не проверено» в rag/README.md.

    Из какого отказа. Срок есть у запроса (600 с), а вызовов на стратегию под
    две сотни: зависший эмбеддер отдаёт по отказу каждые десять минут, и проход
    тянется до ~31 часа на стратегию, держа ядро общей машины (находка
    `compliance` к PR #278). Потолок на вызов такого прохода не ограничивает
    вовсе — доказательство ниже в числе вызовов, а не в словах.

    Часы подменены: «зависание» проверяется без реального ожидания, но
    проверяется настоящий проход через настоящий HTTP-стенд, и утверждения
    идут о журнале стенда (`FakeOllama.requests`), а не о коде ответа.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "corpus"
        self.index = Path(self.tmp.name) / "index"
        (self.root / "agent_docs").mkdir(parents=True)
        # Десять документов — чтобы чанков было заметно больше, чем вызовов
        # уложится в срок: иначе проход кончился бы сам и срок был бы ни при чём.
        # Каталог agent_docs/, а не корень: список корпуса задаёт corpus.collect.
        for i in range(10):
            (self.root / "agent_docs" / f"doc{i}.md").write_text(
                f"# Документ {i}\n\nтело {i}\n", encoding="utf-8"
            )
        self.chunks = build.read_chunks(self.root, "fixed")
        self.assertGreater(len(self.chunks), 5, "корпус стенда слишком мал, проверка ничего не значит")

    def slow_embedder(self, url: str, step: float, clock: list[float]) -> OllamaEmbedder:
        """Эмбеддер, каждый вызов которого «съедает» step секунд по часам теста."""
        embedder = OllamaEmbedder(url, "модель")
        real = embedder.embed

        def embed(texts, timeout=None):
            clock[0] += step
            return real(texts, timeout)

        embedder.embed = embed
        return embedder

    def test_срок_прохода_прерывает_серию_вызовов_а_не_только_вызов(self):
        clock = [0.0]
        with FakeOllama(ROUTES) as fake:
            embedder = self.slow_embedder(fake.url, 600.0, clock)
            deadline = build.Deadline(1800.0, now=lambda: clock[0])
            with self.assertRaises(build.BuildTimeout):
                build.build_strategy(
                    "fixed", self.chunks, embedder, self.index, batch=1, deadline=deadline
                )
            # Ровно 1800 / 600: четвёртый вызов не ушёл. Число — и есть
            # доказательство: без проверки перед вызовом стенд получил бы
            # столько запросов, сколько чанков.
            self.assertEqual(len(fake.requests), 3)
            self.assertLess(len(fake.requests), len(self.chunks))

    def test_срок_один_на_обе_стратегии_а_не_по_сроку_на_каждую(self):
        # Срок — про занятое ядро машины, а стратегий на этом ядре две подряд.
        # Числа подобраны так, чтобы ПЕРВАЯ стратегия уложилась целиком, а
        # вторая упёрлась в остаток: при сроке на каждую стратегию порознь
        # прошли бы обе, и отказа не было бы вовсе.
        per_strategy = len(self.chunks)
        self.assertEqual(per_strategy, len(build.read_chunks(self.root, "structural")))
        clock = [0.0]
        with FakeOllama({**ROUTES, "/api/tags": (200, {"models": [{"name": "модель"}]})}) as fake:
            embedder = self.slow_embedder(fake.url, 600.0, clock)
            # 15 вызовов по 600 с на 20 чанков: первой стратегии хватает, второй нет.
            deadline = build.Deadline(600.0 * 15, now=lambda: clock[0])
            with self.assertRaises(build.BuildTimeout):
                build.build_all(self.root, self.index, embedder, deadline=deadline, batch=1)
            embeds = [path for path, _ in fake.requests if path == "/api/embed"]
        self.assertGreater(len(embeds), per_strategy, "первая стратегия не дошла до конца")
        self.assertEqual(len(embeds), 15, "второй стратегии достался свой срок")

    def test_срок_вызова_не_переживает_срок_прохода(self):
        # Иначе потолок на проход был бы потолком «плюс ещё десять минут».
        seen: list[float | None] = []
        with FakeOllama(ROUTES) as fake:
            embedder = OllamaEmbedder(fake.url, "модель")
            real = embedder.embed

            def embed(texts, timeout=None):
                seen.append(timeout)
                return real(texts, timeout)

            embedder.embed = embed
            build.build_strategy(
                "fixed", self.chunks, embedder, self.index, batch=1, deadline=build.Deadline(5.0)
            )
        self.assertTrue(seen)
        self.assertEqual(embedder.timeout, 600.0, "умолчание клиента изменилось — проверка ниже пуста")
        for timeout in seen:
            self.assertIsNotNone(timeout)
            self.assertLessEqual(timeout, 5.0)

    def test_срок_не_прерывает_проход_который_в_него_укладывается(self):
        # Обратная сторона: потолок, который срабатывает на честной сборке, —
        # не потолок, а поломка.
        with FakeOllama(ROUTES) as fake:
            embedder = OllamaEmbedder(fake.url, "модель")
            stats = build.build_strategy(
                "fixed", self.chunks, embedder, self.index, deadline=build.Deadline(3600.0)
            )
        self.assertEqual(stats["count"], len(self.chunks))

    def test_ноль_снимает_срок_совсем(self):
        # Для локального прогона, где сборка идёт под присмотром человека.
        deadline = build.Deadline(0)
        self.assertIsNone(deadline.remaining())
        self.assertIsNone(deadline.check("где угодно"))

    def test_умолчание_взято_из_окружения_а_не_прибито(self):
        self.assertEqual(build.BUILD_TIMEOUT, float(os.environ.get("RAG_BUILD_TIMEOUT_SECONDS", "43200")))


class WaitForEmbedderTest(unittest.TestCase):
    """Первый старт рядом с разворачивающимся образом Ollama — заход 3.

    Из какого отказа: `ollama` на первой выкатке разворачивает образ в
    3,75 ГБ, а `rag` стартует рядом и сразу идёт в `/api/tags`. Без ожидания
    «эмбеддер не ответил» было бы нормальным исходом первого запуска, повтора
    после него нет, и починкой стал бы ручной рестарт — то есть ровно то, чего
    выкатка по коммиту должна избегать.
    """

    def test_ожидание_переживает_первые_отказы_и_доходит_до_стенда(self):
        with FakeOllama({"/api/tags": (200, {"models": [{"name": "модель"}]})}) as fake:
            embedder = OllamaEmbedder(fake.url, "модель")
            real, tries = embedder.tags, []

            def flaky():
                tries.append(1)
                if len(tries) < 3:
                    raise EmbedError("/api/tags: нет связи")
                return real()

            embedder.tags = flaky
            build.wait_ready(embedder, build.Deadline(600.0), wait=60.0, sleep=lambda _s: None)
            self.assertEqual(len(tries), 3)
            # Утверждение о журнале стенда, а не о коде возврата: предмет —
            # что до службы в итоге дошёл настоящий запрос.
            self.assertIn("/api/tags", [path for path, _ in fake.requests])

    def test_ожидание_не_бесконечно(self):
        # Иначе первый же промах адреса подвесил бы единицу навсегда, и она
        # при этом отвечала бы 200 на /healthz.
        clock = [0.0]
        embedder = OllamaEmbedder("http://127.0.0.1:9", "модель")
        with self.assertRaises(EmbedError):
            build.wait_ready(
                embedder,
                build.Deadline(0),
                wait=30.0,
                sleep=lambda s: clock.__setitem__(0, clock[0] + s),
                now=lambda: clock[0],
            )
        self.assertGreaterEqual(clock[0], 30.0)

    def test_ожидание_входит_в_срок_прохода_а_не_прибавляется_к_нему(self):
        # Общий срок главнее своего: иначе ожидание стало бы вторым местом,
        # где проход стоит часами.
        clock = [0.0]
        embedder = OllamaEmbedder("http://127.0.0.1:9", "модель")
        deadline = build.Deadline(12.0, now=lambda: clock[0])
        with self.assertRaises(build.BuildTimeout):
            build.wait_ready(
                embedder,
                deadline,
                wait=100000.0,
                sleep=lambda s: clock.__setitem__(0, clock[0] + s),
                now=lambda: clock[0],
            )
        self.assertLess(clock[0], 100000.0)

    def test_полный_проход_переживает_неготовый_эмбеддер(self):
        # Держатель того, что ожидание вообще кем-то ВЫЗЫВАЕТСЯ: без этой
        # проверки wait_ready мог бы существовать и не стоять на пути сборки —
        # прогон остался бы зелёным, а первая выкатка всё равно упала бы.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "corpus"
            (root / "agent_docs").mkdir(parents=True)
            (root / "agent_docs" / "doc.md").write_text("# Док\n\nтело\n", encoding="utf-8")
            routes = {**ROUTES, "/api/tags": (200, {"models": [{"name": "модель"}]})}
            with FakeOllama(routes) as fake:
                embedder = OllamaEmbedder(fake.url, "модель")
                real, tries = embedder.tags, []

                def flaky():
                    tries.append(1)
                    if len(tries) < 3:
                        raise EmbedError("/api/tags: нет связи")
                    return real()

                embedder.tags = flaky
                stats = build.build_all(
                    root, Path(tmp) / "index", embedder, deadline=build.Deadline(600.0)
                )
            self.assertEqual(len(stats), 2)
            self.assertGreaterEqual(len(tries), 3)


class EmptyCorpusTest(unittest.TestCase):
    """Пустой корпус — свой отказ, а не отказ эмбеддера.

    Держатель того, что именно `build_all` кидает `EmptyCorpus`: без него
    ветка в `serve.reason` существовала бы и никогда не срабатывала —
    публичный `/healthz` показывал бы «эмбеддер не ответил» на сбой шага
    «Сборка корпуса для индекса» (находка `reviewer`, Б3).
    """

    def test_каталог_есть_а_чанков_нет_это_отдельный_отказ(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "corpus"
            root.mkdir(parents=True)
            # Каталог существует и даже не пуст — но ни один файл в корпус не
            # входит, то есть ровно то, чем кончается сбой шага сборки корпуса.
            (root / "не-в-корпусе.bin").write_bytes(b"\x00")
            with FakeOllama({**ROUTES, "/api/tags": (200, {"models": [{"name": "модель"}]})}) as fake:
                embedder = OllamaEmbedder(fake.url, "модель")
                with self.assertRaises(build.EmptyCorpus):
                    build.build_all(root, Path(tmp) / "index", embedder)
                # До эмбеддера дело дошло — значит отказ не про связь с ним.
                self.assertIn("/api/tags", [path for path, _ in fake.requests])

    def test_это_не_подвид_отказа_эмбеддера(self):
        self.assertFalse(issubclass(build.EmptyCorpus, EmbedError))
