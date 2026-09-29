import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request

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

    def test_набор_причин_закрыт_и_каждая_в_нём(self):
        import build

        from embed import EmbedError

        for err in (EmbedError("x"), build.BuildTimeout("y"), RuntimeError("z"), OSError("w")):
            self.assertIn(serve.reason(err), serve.REASONS, repr(err))


if __name__ == "__main__":
    unittest.main()
