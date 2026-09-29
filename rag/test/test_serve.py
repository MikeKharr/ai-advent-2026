import io
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import serve


class HealthzTest(unittest.TestCase):
    def setUp(self):
        self.status = serve.Status()
        self.server = serve.make_server(self.status, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path: str):
        with urllib.request.urlopen(f"{self.url}{path}", timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_healthz_отвечает_200_и_называет_состояние(self):
        status, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "starting")

    def test_healthz_остаётся_200_когда_сборка_не_удалась(self):
        # Выкатка не должна ждать часы первой сборки: 200 значит «единица
        # поднялась», состояние индекса — в теле.
        self.status.update(state="failed", error=serve.NO_EMBEDDER)
        status, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "failed")
        self.assertEqual(body["error"], serve.NO_EMBEDDER)

    def test_маршрут_за_caddy_тот_же(self):
        self.assertEqual(self.get("/rag/healthz")[0], 200)

    def test_прочие_пути_дают_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/tools/call")
        self.assertEqual(caught.exception.code, 404)

    def test_состояние_читается_и_пишется_из_разных_потоков(self):
        done = threading.Event()

        def writer():
            for i in range(200):
                self.status.update(state=f"building-{i}")
            done.set()

        threading.Thread(target=writer, daemon=True).start()
        for _ in range(50):
            self.assertIn("state", self.status.read())
        done.wait(5)
        self.assertTrue(done.is_set())


class PublicReasonTest(unittest.TestCase):
    """Текст исключения не уезжает в публичную ручку — заход 3, п. 7 списка
    «что не проверено» в rag/README.md.

    Заходом 3 `/rag/healthz` становится публичным и открытым без ключа: его
    дёргает шаг «Проверка живого сайта» в `deploy.yml`, а прочитать может кто
    угодно. Поле `error` до этого несло `f"{тип}: {ошибка}"`, то есть текст,
    который сформатировал `urllib`, — а в отказе клиента Ollama там стоит
    `OLLAMA_URL`: внутреннее имя службы и её порт. Это не секрет и не
    нарушение I-1, но набор возможных строк там неограничен, а публикуется он
    даром. Решение захода: причина — из закрытого набора `serve.REASONS`,
    подробность целиком уходит в журнал контейнера.

    Проверка идёт по телу настоящего HTTP-ответа, а не по значению в объекте:
    предмет — что именно видит читатель ручки.
    """

    def setUp(self):
        self.status = serve.Status()
        self.server = serve.make_server(self.status, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def body_after_failure(self, err: Exception) -> dict:
        """Прогнать run_build, у которого сборка падает заданной ошибкой."""
        import build

        original = build.build_all
        self.addCleanup(setattr, build, "build_all", original)

        def boom(*_a, **_k):
            raise err

        build.build_all = boom
        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            serve.run_build(self.status)
            self.journal = sys.stderr.getvalue()
        finally:
            sys.stderr = stderr
        with urllib.request.urlopen(f"{self.url}/rag/healthz", timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def test_адрес_эмбеддера_не_попадает_в_ответ_ручки(self):
        from embed import EmbedError

        # Дословно то, чем ошибается живой клиент, когда службы нет.
        err = EmbedError("/api/embed: нет связи с http://ollama:11434 (Connection refused)")
        body = self.body_after_failure(err)
        raw = json.dumps(body, ensure_ascii=False)
        self.assertNotIn("ollama", raw)
        self.assertNotIn("11434", raw)
        self.assertNotIn("http", raw)
        self.assertEqual(body["error"], serve.NO_EMBEDDER)
        self.assertEqual(body["state"], "failed")

    def test_подробность_не_теряется_а_уходит_в_журнал_контейнера(self):
        # Иначе «закрытый набор» стоил бы владельцу возможности разобраться.
        from embed import EmbedError

        self.body_after_failure(EmbedError("/api/embed: нет связи с http://ollama:11434"))
        self.assertIn("11434", self.journal)
        self.assertIn("EmbedError", self.journal)

    def test_срыв_по_сроку_называется_своими_словами(self):
        import build

        body = self.body_after_failure(build.BuildTimeout("прервана на стратегия fixed, чанк 640"))
        self.assertEqual(body["error"], serve.TOO_LONG)
        # И не путается с отказом эмбеддера: это разные поводы смотреть журнал.
        self.assertNotEqual(serve.TOO_LONG, serve.NO_EMBEDDER)

    def test_любая_прочая_ошибка_тоже_из_набора(self):
        body = self.body_after_failure(ValueError("/data/structural.faiss: Permission denied"))
        self.assertEqual(body["error"], serve.INTERNAL)
        self.assertNotIn("/data", json.dumps(body, ensure_ascii=False))

    def test_пустой_корпус_не_выдаётся_за_отказ_эмбеддера(self):
        # Достижимо в проде: каталог есть, а шаг «Сборка корпуса для индекса»
        # положил в него пусто. Пока это был EmbedError, единственный быстрый
        # сигнал владельцу показывал не туда (находка `reviewer`, Б3).
        import build

        body = self.body_after_failure(build.EmptyCorpus("корпус /app/corpus пуст"))
        self.assertEqual(body["error"], serve.EMPTY_CORPUS)
        self.assertNotEqual(body["error"], serve.NO_EMBEDDER)
        self.assertNotIn("/app", json.dumps(body, ensure_ascii=False))

    def test_набор_причин_закрыт_и_каждая_в_нём(self):
        import build

        from embed import EmbedError

        errors = (
            EmbedError("x"),
            build.BuildTimeout("y"),
            build.EmptyCorpus("z"),
            RuntimeError("q"),
            OSError("w"),
        )
        for err in errors:
            self.assertIn(serve.reason(err), serve.REASONS, repr(err))
        # Ветки различаются, а не сводятся к одной строке: иначе «набор
        # закрыт» выполнялось бы и при `return INTERNAL` на всё подряд.
        self.assertEqual(len({serve.reason(e) for e in errors}), 4)


class StartupTest(unittest.TestCase):
    """Обе ветви `main`, а не одна.

    Мест записи публичного `error` три, и прибивались они по одному, по мере
    того как их находили: `run_build` — заходом 3, ветвь `else` в `main` —
    находкой `reviewer` Н2, а **ветвь `then` того же `if`** — находкой
    `reviewer` Б5, то есть после правки, прошедшей вплотную к ней и мимо неё.
    Здесь обе ветви держатся рядом, чтобы класс закрывался целиком, а не по
    экземпляру.

    Почему ветвь `then` вообще нуждается в держателе. `run_build` покрыт
    прямым вызовом, `build_all` — двумя десятками проверок, но то, что
    `main` их ЗАПУСКАЕТ, не держало ничто: снятие `Thread(...).start()`
    оставляло прогон зелёным. В проде это самый тихий из возможных отказов —
    индекс не собирается никогда, `/healthz` вечно отдаёт 200 со `starting`,
    шаг «Проверка живого сайта» смотрит на код ответа, шаг «Контейнер
    поднимается и отвечает на /healthz» делает `curl -fsS … >/dev/null` и в
    тело не заглядывает. Девять зелёных проверок при мёртвой единице.
    """

    def run_main(self, env: dict):
        """Поднять `main` до места, где он ушёл бы в `serve_forever`.

        `Status` НЕ подменяется намеренно: объект состояния создаёт сам
        `main`, а тест забирает тот, который `main` отдал серверу. Пока
        `Status` подменялся на заранее созданный, проверка «сборке передали
        то же состояние, что серверу» была вырожденной — она выполнялась при
        любом аргументе, потому что `Status()` внутри `main` возвращал тот
        же объект. Поймано мутацией М15 уже после правки по Б5.
        """
        from unittest import mock

        captured = []

        def grab(status, *_a, **_k):
            captured.append(status)
            raise RuntimeError("стоп")

        with (
            mock.patch.dict(os.environ, env),
            mock.patch.object(serve, "make_server", grab),
        ):
            with self.assertRaises(RuntimeError):
                serve.main()
        self.assertEqual(len(captured), 1, "main не дошёл до создания сервера")
        return captured[0]

    def test_старт_без_корпуса_пишет_причину_из_набора(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "нет-такого-каталога")
            status = self.run_main({"RAG_CORPUS": missing})
        body = status.read()
        self.assertEqual(body["state"], "failed")
        self.assertIn(body["error"], serve.REASONS)
        self.assertEqual(body["error"], serve.NO_CORPUS)
        # Путь к корпусу в публичную строку не попадает ни при каком tmp.
        self.assertNotIn(missing, json.dumps(body, ensure_ascii=False))

    def test_с_корпусом_сборка_действительно_запускается(self):
        import tempfile
        import threading as th
        from unittest import mock

        started = th.Event()
        seen = []

        def fake_run_build(status):
            seen.append(status)
            status.update(state="building")
            started.set()

        with tempfile.TemporaryDirectory() as tmp:
            # Каталог существует — значит ветвь `then`.
            with mock.patch.object(serve, "run_build", fake_run_build):
                status = self.run_main({"RAG_CORPUS": tmp})
            # Поток демонский: ждём его по событию, а не по времени.
            self.assertTrue(started.wait(5), "сборка не запущена из main")
        self.assertEqual(len(seen), 1, "run_build вызван не один раз")
        # Тот же объект, что ушёл серверу: иначе сборка писала бы состояние,
        # которого /healthz никогда не покажет.
        self.assertIs(seen[0], status, "сборке передали не то состояние")
        self.assertEqual(status.read()["state"], "building")

    def test_ветви_не_перепутаны_местами(self):
        # Иначе проверка выше проходила бы и при `if not ... .is_dir()`:
        # без корпуса сборка запускаться не должна.
        import tempfile
        from unittest import mock

        called = []
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "нет-такого-каталога")
            with mock.patch.object(serve, "run_build", lambda s: called.append(s)):
                status = self.run_main({"RAG_CORPUS": missing})
        self.assertEqual(called, [])
        self.assertEqual(status.read()["state"], "failed")


if __name__ == "__main__":
    unittest.main()
