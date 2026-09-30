import hmac
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

import limits
import rpc
import serve
import tools
from index import VectorIndex

# Ключ службы в тестах. Настоящий живёт только в `.env` на сервере и в
# GitHub Secrets (AGENTS.md, «Универсальные правила»).
KEY = "test-rag-key-0123456789"


def start_service(case, key: str = KEY, **over):
    """Поднять службу на свободном порту и убрать её за собой.

    Индекс, лимитер и суточный потолок — свои на каждый тест и в своём
    временном каталоге: иначе тесты делили бы `/data` и счёт суток.
    """
    import tempfile

    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    case.index_dir = Path(tmp.name)
    case.status = over.pop("status", None) or serve.Status()
    case.indexes = over.pop("indexes", None) or tools.Indexes(case.index_dir)
    case.limiter = over.pop("limiter", None) or limits.Limiter()
    case.daily_cap = over.pop("daily_cap", None) or limits.DailyCap(case.index_dir / "usage.json", limit=100)
    case.journal = []
    case.server = serve.make_server(
        case.status,
        port=0,
        indexes=case.indexes,
        limiter=case.limiter,
        daily_cap=case.daily_cap,
        handle_one=over.pop("handle_one", None) or (lambda _m: None),
        key=key,
        log=case.journal.append,
        **over,
    )
    threading.Thread(target=case.server.serve_forever, daemon=True).start()
    case.url = f"http://127.0.0.1:{case.server.server_address[1]}"
    case.addCleanup(case.server.server_close)
    case.addCleanup(case.server.shutdown)
    return case.url


class HealthzTest(unittest.TestCase):
    def setUp(self):
        start_service(self)

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
        start_service(self)

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
            serve.run_build(self.status, tools.Indexes(self.index_dir))
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

        # RAG_KEY — часть окружения старта: без него `main` не доходит до
        # сервера вовсе (проверяется отдельно в `KeyRequiredTest`).
        with (
            mock.patch.dict(os.environ, {"RAG_KEY": KEY, **env}),
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

        def fake_run_build(status, indexes):
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
            with mock.patch.object(serve, "run_build", lambda s, i: called.append(s)):
                status = self.run_main({"RAG_CORPUS": missing})
        self.assertEqual(called, [])
        self.assertEqual(status.read()["state"], "failed")




class RouteTableTest(unittest.TestCase):
    """Конвенция лимитера у этой единицы (ADR 2026-09-29-2139, п. 7).

    Смысл тот же, что у корневого `test/limiter-seam-days.test.js` для дней:
    ручка объявляет своё окно в таблице, исключение обязано нести причину, а
    запись без окна не даёт модулю загрузиться. Разница в наборе имён окон —
    у этой единицы ручек две и окно одно.
    """

    def test_у_каждой_записи_названо_окно(self):
        self.assertGreater(len(serve.ROUTES), 0, "таблица ручек пуста")
        for route in serve.ROUTES:
            self.assertIn(route.limit, serve.LIMITS, f"{route}: окно не названо")
            if route.limit == "open":
                self.assertTrue(route.why.strip(), f"{route}: исключение без причины")

    def test_запись_без_окна_не_даёт_загрузиться(self):
        bad = (serve.Route("GET", ("/x",), "нет-такого-окна", handler="healthz"),)
        with self.assertRaises(RuntimeError):
            serve.check_routes(bad)

    def test_исключение_без_причины_не_даёт_загрузиться(self):
        bad = (serve.Route("GET", ("/x",), "open", handler="healthz", why="  "),)
        with self.assertRaises(RuntimeError):
            serve.check_routes(bad)

    def test_проверка_таблицы_зовётся_при_загрузке_модуля_а_не_из_main(self):
        # Держатель стоит не на функции, а на её месте: `check_routes` может
        # быть сколь угодно строгой и при этом никем не вызванной. Здесь
        # проверяется, что её зовёт сам модуль — импорт с негодной таблицей
        # обязан упасть.
        import importlib.util

        source = Path(serve.__file__).read_text(encoding="utf-8")
        broken = source.replace('Route("POST", ("/rag",), "call", handler="rpc")',
                                'Route("POST", ("/rag",), "", handler="rpc")')
        self.assertNotEqual(broken, source, "приманка не подставилась")
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / "serve_broken.py"
        path.write_text(broken, encoding="utf-8")
        spec = importlib.util.spec_from_file_location("serve_broken", path)
        module = importlib.util.module_from_spec(spec)
        with self.assertRaises(RuntimeError):
            spec.loader.exec_module(module)

    def test_путь_вне_таблицы_не_находится(self):
        self.assertIsNone(serve.match("/tools/call"))
        self.assertIsNone(serve.match("/"))
        self.assertIsNotNone(serve.match("/rag"))
        self.assertIsNotNone(serve.match("/rag/"))
        self.assertIsNotNone(serve.match("/rag/healthz"))

    def test_запрос_не_обманывает_таблицу_хвостом(self):
        # `/rag?x=1` — тот же /rag, `/ragged` — не он.
        self.assertIsNotNone(serve.match("/rag?query=1"))
        self.assertIsNone(serve.match("/ragged"))
        self.assertIsNone(serve.match("/rag/tools"))


def request(url: str, path: str, method: str = "POST", key: str | None = KEY, body=None, headers=None):
    """Сырой запрос без исключений: возвращает (код, заголовки, тело-байты)."""
    import http.client
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
    head = dict(headers or {})
    if key is not None:
        head["authorization"] = f"Bearer {key}"
    raw = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode("utf-8")
    if raw is not None:
        head["content-type"] = "application/json"
    try:
        conn.request(method, path, body=raw, headers=head)
        resp = conn.getresponse()
        return resp.status, dict(resp.getheaders()), resp.read()
    finally:
        conn.close()


class KeyTest(unittest.TestCase):
    """Ключ — всегда и до чтения тела; отказ выглядит как пустое место."""

    def setUp(self):
        start_service(self, handle_one=lambda m: {"jsonrpc": "2.0", "id": m.get("id"), "result": {"ok": True}})

    def test_годный_ключ_пропускает(self):
        code, _h, raw = request(self.url, "/rag", body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["result"], {"ok": True})

    def test_отказ_по_ключу_и_неизвестный_путь_совпадают_побайтно(self):
        # Решение владельца по /mcp (ADR 2026-09-23-1844, пп. 1–2): два
        # разных ответа снова отличали бы эндпоинт от пустого места.
        bad_key = request(self.url, "/rag", key="wrong-key", body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        unknown = request(self.url, "/no-such-path", key=None)
        for name in ("date", "server", "connection"):
            bad_key[1].pop(name, None)
            unknown[1].pop(name, None)
        self.assertEqual(bad_key, unknown)
        self.assertEqual(bad_key[0], 404)
        self.assertEqual(bad_key[2], b"")

    def test_без_заголовка_ключа_тот_же_пустой_404(self):
        code, _h, raw = request(self.url, "/rag", key=None, body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual((code, raw), (404, b""))

    def test_тело_неавторизованного_запроса_не_читается(self):
        # Иначе потолок тела не был бы потолком: кто угодно без ключа
        # заставлял бы службу читать сколько угодно байт.
        code, _h, _raw = request(
            self.url, "/rag", key="wrong-key", body={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {}}
        )
        self.assertEqual(code, 404)
        # Ни один вызов инструмента не дошёл до RPC — и слот не занят.
        self.assertEqual(self.limiter.stats()["trackedIps"], 0)

    def test_сверка_идёт_через_compare_digest_а_не_через_равенство(self):
        # I-14 для утверждения «сверка ключа постоянного времени». Держится
        # не замером времени (он флакует), а тем, ЧЕМ сравнивают: замена
        # `hmac.compare_digest` на `==` краснит эту проверку.
        from unittest import mock

        calls = []
        real = hmac.compare_digest

        def spy(a, b):
            calls.append((a, b))
            return real(a, b)

        with mock.patch.object(serve.hmac, "compare_digest", spy):
            request(self.url, "/rag", body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(len(calls), 1, "ключ сверили не через compare_digest")
        self.assertEqual(calls[0][1], KEY.encode("utf-8"))

    def test_решение_принимает_результат_сверки_а_не_сам_её_вызов(self):
        # Проверка выше говорит только «вызов был», и мутант, который
        # оставляет вызов, а решает через `==`, её пережил бы (находка
        # гейтов к PR #282, третий раз за PR та же форма: держатель стоит
        # на факте, а не на его роли в пути исполнения).
        #
        # Здесь подменяется РЕЗУЛЬТАТ, и ответ службы обязан пойти за ним.
        from unittest import mock

        body = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        with mock.patch.object(serve.hmac, "compare_digest", lambda _a, _b: False):
            self.assertEqual(request(self.url, "/rag", body=body)[0], 404, "годный ключ прошёл вопреки отказу сверки")
        with mock.patch.object(serve.hmac, "compare_digest", lambda _a, _b: True):
            self.assertEqual(request(self.url, "/rag", key="wrong-key", body=body)[0], 200, "негодный ключ не прошёл вопреки согласию сверки")

    def test_ключ_сверяется_и_на_методе_который_всё_равно_получит_405(self):
        # Порядок: ключ ДО метода. Иначе прохожий отличал бы живой адрес от
        # пустого места по 405.
        self.assertEqual(request(self.url, "/rag", method="DELETE", key="wrong-key")[0], 404)
        self.assertEqual(request(self.url, "/rag", method="DELETE")[0], 405)

    def test_чужой_метод_не_отвечает_501_от_библиотеки(self):
        # `BaseHTTPRequestHandler` на неописанный метод отвечает своим 501 с
        # текстом — то есть отличал бы адрес от пустого места ещё до ключа.
        for method in ("PUT", "PATCH", "OPTIONS", "HEAD"):
            self.assertEqual(request(self.url, "/no-such-path", method=method, key=None)[0], 404, method)

    def test_перебор_даёт_одну_строку_в_журнал_за_окно_и_без_адреса(self):
        limiter = limits.Limiter(refusal_signal=3)
        start_service(self, limiter=limiter)
        for _ in range(10):
            request(self.url, "/rag", key="wrong-key", body={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        bursts = [e for e in self.journal if e["event"] == "refusal_burst"]
        self.assertEqual(len(bursts), 1, "сигнал о переборе сам стал перебором строк")
        self.assertEqual(bursts[0]["count"], 3)
        # I-10: журнал контейнера переживает часовое окно, адреса в нём нет.
        self.assertNotIn("127.0.0.1", json.dumps(self.journal, ensure_ascii=False))


class HealthzOpenTest(unittest.TestCase):
    def setUp(self):
        start_service(self)

    def test_healthz_открыт_без_ключа(self):
        # Его дёргает шаг «Проверка живого сайта» в deploy.yml и HEALTHCHECK
        # образа — оба без заголовков.
        code, _h, raw = request(self.url, "/healthz", method="GET", key=None)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(raw)["state"], "starting")

    def test_healthz_называет_и_сборку_и_загруженный_индекс(self):
        # `state` — про СБОРКУ, `index` — про то, по чему идёт поиск сейчас.
        body = json.loads(request(self.url, "/rag/healthz", method="GET", key=None)[2])
        self.assertEqual(body["state"], "starting")
        self.assertEqual(body["index"], {"commit": "unknown", "strategies": [], "chunks": {}})

    def test_остаток_суточного_потолка_в_открытую_ручку_не_идёт(self):
        # Он говорил бы прохожему, пользуется ли службой кто-то прямо сейчас.
        raw = request(self.url, "/rag/healthz", method="GET", key=None)[2].decode("utf-8")
        self.assertNotIn("daily", raw)
        self.assertNotIn("remaining", raw)


class OrderAndLimiterTest(unittest.TestCase):
    """Лимитер ДО передачи `tools/call` обработчику."""

    def setUp(self):
        self.seen = []

        def handle_one(message):
            self.seen.append(message)
            return {"jsonrpc": "2.0", "id": message.get("id"), "result": {"content": []}}

        start_service(self, limiter=limits.Limiter(per_min=2, per_hour=2), handle_one=handle_one)

    def call(self, n=1):
        body = [{"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": "project.search"}} for i in range(n)]
        return request(self.url, "/rag", body=body if n > 1 else body[0])

    def test_отказ_лимитера_не_доходит_до_обработчика(self):
        self.assertEqual(self.call()[0], 200)
        self.assertEqual(self.call()[0], 200)
        code, _h, raw = self.call()
        self.assertEqual(code, 429)
        self.assertEqual(json.loads(raw)["error"]["code"], -32002)
        self.assertEqual(len(self.seen), 2, "обработчик позван поверх окна")

    def test_пачка_считается_поштучно_а_не_за_один_вызов(self):
        code, _h, _raw = self.call(3)
        self.assertEqual(code, 429)
        self.assertEqual(self.seen, [], "пачка прошла мимо окна")

    def test_не_вызовы_инструментов_слотов_не_занимают(self):
        for _ in range(5):
            self.assertEqual(request(self.url, "/rag", body={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})[0], 200)
        self.assertEqual(self.call()[0], 200, "tools/list съел слот вызова")

    def test_отказ_лимитера_несёт_id_запроса(self):
        self.call()
        self.call()
        body = json.loads(request(self.url, "/rag", body={"jsonrpc": "2.0", "id": "мой", "method": "tools/call"})[2])
        self.assertEqual(body["id"], "мой")


class BodyTest(unittest.TestCase):
    def setUp(self):
        start_service(self, handle_one=lambda m: {"jsonrpc": "2.0", "id": m.get("id"), "result": {}})

    def test_тело_больше_потолка_не_читается(self):
        big = b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"x":"' + b"a" * (serve.MAX_BODY + 10) + b'"}}'
        code, _h, raw = request(self.url, "/rag", body=big)
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(raw)["error"]["code"], rpc.PARSE_ERROR)
        self.assertEqual(self.limiter.stats()["trackedIps"], 0, "слот занят телом, которое не прочли")

    def test_не_json_это_parse_error(self):
        code, _h, raw = request(self.url, "/rag", body="{это не json".encode("utf-8"))
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(raw)["error"]["code"], rpc.PARSE_ERROR)

    def test_уведомление_даёт_202_без_тела(self):
        start_service(self, handle_one=lambda _m: None)
        code, _h, raw = request(self.url, "/rag", body={"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual((code, raw), (202, b""))

    def test_пустая_пачка_это_негодный_запрос(self):
        code, _h, raw = request(self.url, "/rag", body=[])
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(raw)["error"]["code"], rpc.INVALID_REQUEST)


class EndToEndTest(unittest.TestCase):
    """Настоящий RPC поверх настоящих инструментов, с поддельным эмбеддером."""

    def setUp(self):
        start_service(self)
        rows = [{
            "source": "agent_docs/invariants.md", "title": "Инварианты", "section": "I-4",
            "chunk_id": "c1", "strategy": "structural", "sha256": "0" * 64, "commit": "a1b2c3d",
            "text": "проверка лимита предшествует вызову API",
        }]
        VectorIndex.build("structural", rows, np.asarray([[1.0, 0.0]], dtype="float32")).save(self.index_dir)
        self.indexes.load()
        self.embed_calls = []

        class Embedder:
            def embed(_self, texts, timeout=None):
                self.embed_calls.append(texts)
                return [[1.0, 0.0] for _ in texts]

        handle_one = rpc.create_rpc(serve.SERVER_INFO, serve.make_tools(self.status, self.indexes, self.daily_cap, Embedder()))
        start_service(self, status=self.status, indexes=self.indexes, daily_cap=self.daily_cap, handle_one=handle_one)

    def call(self, name, arguments=None, id_=1):
        body = {"jsonrpc": "2.0", "id": id_, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}
        code, _h, raw = request(self.url, "/rag", body=body)
        return code, json.loads(raw)

    def test_список_инструментов_это_ровно_два_имени(self):
        code, _h, raw = request(self.url, "/rag", body={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(code, 200)
        self.assertEqual([t["name"] for t in json.loads(raw)["result"]["tools"]], ["project.search", "project.status"])

    def test_поиск_доходит_до_выдачи(self):
        code, answer = self.call("project.search", {"query": "лимит"})
        self.assertEqual(code, 200)
        payload = json.loads(answer["result"]["content"][0]["text"])
        self.assertEqual(payload["results"][0]["source"], "agent_docs/invariants.md")
        self.assertEqual(payload["index"]["commit"], "a1b2c3d")
        self.assertEqual(self.embed_calls, [["лимит"]])

    def test_состояние_доходит_до_выдачи(self):
        code, answer = self.call("project.status")
        payload = json.loads(answer["result"]["content"][0]["text"])
        self.assertEqual(payload["index"]["strategies"], ["structural"])
        self.assertEqual(payload["daily"]["limit"], 100)
        self.assertEqual(self.embed_calls, [], "status позвал эмбеддер")

    def test_ответ_не_несёт_ни_адреса_ни_заголовков_запроса(self):
        _code, answer = self.call("project.search", {"query": "лимит"})
        raw = json.dumps(answer, ensure_ascii=False)
        for forbidden in ("127.0.0.1", "authorization", "Bearer", "user-agent", KEY):
            self.assertNotIn(forbidden, raw, forbidden)


class KeyRequiredTest(unittest.TestCase):
    """Без `RAG_KEY` процесс не стартует (ADR 2026-09-29-2139, п. 1)."""

    def run_main(self, env):
        from unittest import mock

        reached = []
        with (
            mock.patch.dict(os.environ, env, clear=False),
            mock.patch.object(serve, "make_server", lambda *a, **k: reached.append(1)),
        ):
            code = serve.main()
        return code, reached

    def test_без_ключа_служба_не_поднимается(self):
        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            code, reached = self.run_main({"RAG_KEY": ""})
            journal = sys.stderr.getvalue()
        finally:
            sys.stderr = stderr
        self.assertEqual(code, 2)
        self.assertEqual(reached, [], "сервер создан без ключа")
        self.assertIn("RAG_KEY", journal)

    def test_пробелы_за_ключ_не_считаются(self):
        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            code, reached = self.run_main({"RAG_KEY": "   "})
        finally:
            sys.stderr = stderr
        self.assertEqual((code, reached), (2, []))


class RunBuildReadyTest(unittest.TestCase):
    """Удачный путь `run_build` — долг захода 3 (ADR 2026-09-29-2139, п. 9).

    До этого захода поле `state` никто не читал, и ни один из тринадцати
    тестов `run_build` не доводил его до `ready`: покрыты были только четыре
    ветви отказа. Теперь `state` читает `project.status`, и «сборка удалась»
    стало наблюдаемым снаружи — значит, обязано быть под тестом.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.status = serve.Status()
        self.indexes = tools.Indexes(self.dir)

    def run_ok(self, stats=None, write_index=True):
        import build
        from unittest import mock

        if write_index:
            rows = [{
                "source": "AGENTS.md", "title": "Правила", "section": "Роли", "chunk_id": "c1",
                "strategy": "structural", "sha256": "0" * 64, "commit": "abcdef1",
                "text": "роли определены в .claude/agents",
            }]
            VectorIndex.build("structural", rows, np.asarray([[1.0, 0.0]], dtype="float32")).save(self.dir)

        done = stats if stats is not None else [{"strategy": "structural", "count": 1}]
        with (
            mock.patch.object(build, "build_all", lambda *a, **k: done),
            mock.patch.object(build, "CORPUS_DIR", self.dir),
        ):
            serve.run_build(self.status, self.indexes)
        return self.status.read()

    def test_удачная_сборка_доводит_состояние_до_ready(self):
        state = self.run_ok()
        self.assertEqual(state["state"], "ready")
        self.assertIsNone(state["error"])
        self.assertEqual(state["strategies"], [{"strategy": "structural", "count": 1}])

    def test_удачная_сборка_перечитывает_том(self):
        # Без этого свежесобранный индекс не искался бы до перезапуска
        # контейнера: в памяти остался бы индекс прошлой выкатки.
        self.assertEqual(self.indexes.load(), [], "том не пуст до сборки")
        self.run_ok()
        self.assertEqual(self.indexes.state()["strategies"], ["structural"])
        self.assertEqual(self.indexes.commit(), "abcdef1")

    def test_коммит_корпуса_попадает_в_состояние_до_сборки_а_не_после(self):
        # Иначе при отказе сборки `project.status` не сказал бы, какой
        # корпус вообще пытались собрать.
        (self.dir / "COMMIT").write_text("0123456789abcdef\n", encoding="utf-8")
        self.assertEqual(self.run_ok()["commit"], "0123456789abcdef")

    def test_отказ_сборки_том_не_перечитывает(self):
        import build
        from unittest import mock

        loaded = []
        self.indexes.load = lambda: loaded.append(1)
        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            with (
                mock.patch.object(build, "build_all", side_effect=RuntimeError("нет")),
                mock.patch.object(build, "CORPUS_DIR", self.dir),
            ):
                serve.run_build(self.status, self.indexes)
        finally:
            sys.stderr = stderr
        self.assertEqual(self.status.read()["state"], "failed")
        self.assertEqual(loaded, [])


def raw_exchange(url: str, request: bytes, wait: float = 1.5) -> bytes:
    """Послать сырые байты в одно соединение и собрать ВСЁ, что пришло.

    Не `http.client`: предмет проверки — сколько ответов сервер прислал на
    одно соединение, а клиент протокола прочитал бы ровно один и про второй
    промолчал бы.
    """
    import socket
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    sock = socket.create_connection((parts.hostname, parts.port), timeout=5)
    sock.sendall(request)
    sock.settimeout(wait)
    chunks = []
    try:
        while True:
            piece = sock.recv(4096)
            if not piece:
                break
            chunks.append(piece)
    except (TimeoutError, OSError):
        pass
    finally:
        sock.close()
    return b"".join(chunks)


class SmugglingTest(unittest.TestCase):
    """Тело неавторизованного запроса не разбирается как следующий запрос.

    Находка гейтов Б1 к PR #282. Ключ проверяется ДО чтения тела — это и
    есть замысел (иначе потолок тела не был бы потолком), но из него следует,
    что байты тела остаются в сокете. Если соединение при этом не закрыть,
    `BaseHTTPRequestHandler` идёт на следующий круг и разбирает их как
    запрос: кто угодно без ключа получает на том же соединении второй ответ.

    `/rag` — единственный путь, который этот заход открывает наружу без
    ключа (открытым он не становится, но до проверки ключа доходит кто
    угодно), Caddy переносит тело дословно и держит keep-alive к `rag:8086`.

    Ближайший `KeyTest::test_тело_неавторизованного_запроса_не_читается`
    смотрит на код ответа и на незанятый слот лимитера — про закрытие
    соединения в нём нет ничего, и снятие `close_connection` он не краснил.
    """

    def setUp(self):
        start_service(self, handle_one=lambda m: {"jsonrpc": "2.0", "id": m.get("id"), "result": {}})

    def smuggle(self, key_header: bytes, path: bytes = b"/rag") -> bytes:
        smuggled = b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"
        return raw_exchange(
            self.url,
            b"POST " + path + b" HTTP/1.1\r\nHost: x\r\n" + key_header
            + b"content-type: application/json\r\n"
            + b"content-length: " + str(len(smuggled)).encode() + b"\r\n\r\n"
            + smuggled,
        )

    def test_протащенный_запрос_не_получает_второго_ответа(self):
        raw = self.smuggle(b"authorization: Bearer wrong-key\r\n")
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:400]!r}")
        self.assertIn(b"HTTP/1.1 404", raw)

    def test_протащенный_healthz_не_отдаёт_своё_тело(self):
        # Отдельным утверждением, а не тем же: число ответов и содержимое
        # второго — разные наблюдения, и второе прямее говорит, что именно
        # утекало бы.
        raw = self.smuggle(b"authorization: Bearer wrong-key\r\n")
        self.assertNotIn(b'"state"', raw)
        self.assertNotIn(b'"index"', raw)

    def test_то_же_на_запросе_вовсе_без_ключа(self):
        raw = self.smuggle(b"")
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:400]!r}")
        self.assertNotIn(b'"state"', raw)

    def test_то_же_на_неизвестном_пути(self):
        # Вторая причина того же пустого 404 — путь вне таблицы. Ключа тут
        # нет вовсе, и тело всё равно остаётся непрочитанным.
        raw = self.smuggle(b"", path=b"/no-such-path")
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:400]!r}")
        self.assertNotIn(b'"state"', raw)

    def test_405_на_открытой_ручке_тоже_не_отдаёт_второго_ответа(self):
        """Ветвь 405 достижима БЕЗ ключа — находка ревьюера к PR #282.

        У записи `/healthz` окно `open` (`serve.py:111`), поэтому проверка
        ключа на 248 пропускается, и следующей идёт проверка метода на 261.
        `POST /rag/healthz` без всякого `Authorization` уходит в 405, тело не
        читается и остаётся в сокете. Путь публичный: `handle /rag/healthz`
        в `deploy/Caddyfile` метод не ограничивает.

        То есть экспозиция та же, что у закрытой Б1, а не «мелочь за
        ключом»: два бесключевых случая выше ведут в `_nothing_here`, а эта
        ветвь не была покрыта ничем.
        """
        raw = self.smuggle(b"", path=b"/rag/healthz")
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:400]!r}")
        self.assertIn(b"HTTP/1.1 405", raw)
        self.assertNotIn(b'"state"', raw, "протащенный /healthz исполнился")

    def test_405_на_открытой_ручке_и_с_ключом_тоже(self):
        # Ключ ничего не меняет на открытой ручке — он там и не смотрится.
        # Отдельным утверждением, чтобы «держит ключ» нельзя было принять за
        # объяснение зелёного выше.
        raw = self.smuggle(b"authorization: Bearer " + KEY.encode() + b"\r\n", path=b"/rag/healthz")
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:400]!r}")
        self.assertNotIn(b'"state"', raw)

    def test_стенд_живой_годный_ключ_на_том_же_сокете_отвечает(self):
        # Иначе «пришёл один ответ» выполнялось бы и при мёртвой службе:
        # проверка обязана различать гипотезы.
        body = b'{"jsonrpc":"2.0","id":1,"method":"ping"}'
        raw = raw_exchange(
            self.url,
            b"POST /rag HTTP/1.1\r\nHost: x\r\n"
            b"authorization: Bearer " + KEY.encode() + b"\r\n"
            b"content-type: application/json\r\n"
            b"content-length: " + str(len(body)).encode() + b"\r\n\r\n" + body,
        )
        self.assertIn(b"HTTP/1.1 200", raw)


class OneResponsePerConnectionTest(unittest.TestCase):
    """Перебор `ROUTES` × методы × «с телом»: ровно один ответ на соединение.

    Этот держатель заменяет три точечных, и заменяет намеренно. Экземпляров
    одного класса нашлось три, и все три разными способами: тело
    неавторизованного `POST /rag` (мутация `compliance`), ветвь 405 на
    открытой `/healthz` (чтение `reviewer`), `GET /healthz` с телом
    (перебор `compliance`). Значит подвёл не глаз, а **предикат**, которым
    пользовались все трое: «стоит ли строка за проверкой ключа». Правильный
    предикат другой — **«может ли ответ уйти, пока тело запроса не
    вычитано»**, — и проверяется он перебором, а не по месту.

    Точечный тест на `_healthz` оставил бы класс открытым в третий раз.
    Этот перебор ловит и четвёртый экземпляр — у ручки, которой ещё нет:
    пути берутся из `serve.ROUTES`, а не переписываются сюда.

    В теле каждого запроса лежит ЦЕЛЫЙ `POST /rag` с годным ключом и
    `id: 777`. Если соединение рассинхронизировано, протащенный вызов не
    просто получает ответ — он ИСПОЛНЯЕТСЯ, и это видно по `777`.
    """

    def setUp(self):
        start_service(self, handle_one=lambda m: {"jsonrpc": "2.0", "id": m.get("id"), "result": {"pong": True}})

    SMUGGLED = (
        b"POST /rag HTTP/1.1\r\nHost: x\r\nauthorization: Bearer " + KEY.encode()
        + b"\r\ncontent-type: application/json\r\ncontent-length: 42\r\n\r\n"
        + b'{"jsonrpc":"2.0","id":777,"method":"ping"}'
    )

    def exchange(self, method: bytes, path: bytes, auth: bytes) -> bytes:
        body = self.SMUGGLED
        return raw_exchange(
            self.url,
            method + b" " + path + b" HTTP/1.1\r\nHost: x\r\n" + auth
            + b"content-length: " + str(len(body)).encode() + b"\r\n\r\n" + body,
            wait=0.6,
        )

    def test_ни_одна_пара_маршрут_метод_не_отдаёт_второго_ответа(self):
        paths = [p.encode() for route in serve.ROUTES for p in route.paths] + [b"/no-such-path"]
        methods = [b"GET", b"POST", b"PUT", b"DELETE", b"PATCH", b"OPTIONS"]
        keys = {
            "годный ключ": b"authorization: Bearer " + KEY.encode() + b"\r\n",
            "негодный ключ": b"authorization: Bearer wrong-key\r\n",
            "без ключа": b"",
        }
        self.assertGreaterEqual(len(paths), 3, "пути не собрались из ROUTES")

        bad = []
        for path in paths:
            for method in methods:
                for label, auth in keys.items():
                    raw = self.exchange(method, path, auth)
                    count = raw.count(b"HTTP/1.1 ")
                    executed = b"777" in raw
                    if count != 1 or executed:
                        bad.append(
                            f"{method.decode()} {path.decode()} ({label}): "
                            f"ответов={count}, протащенное исполнено={executed}"
                        )
        self.assertEqual(bad, [], "тело запроса разобрано как следующий запрос:\n" + "\n".join(bad))

    def test_перебор_не_вырожден_годный_запрос_всё_ещё_обслуживается(self):
        # Иначе «везде один ответ» выполнялось бы и при службе, которая
        # рвёт всякое соединение сразу: перебор обязан различать гипотезы.
        raw = raw_exchange(self.url, self.SMUGGLED, wait=0.6)
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1)
        self.assertIn(b"HTTP/1.1 200", raw)
        self.assertIn(b"777", raw, "законный запрос с тем же телом не обслужился")

    def test_тело_сверх_потолка_соединение_тоже_не_рассинхронизирует(self):
        """Третий случай того же класса — и он единственный ЗА ключом.

        Тело сверх 64 КБ не читается вовсе (`_read_body` отказывает до
        чтения), значит остаётся в сокете. Пока это закрывалось точечной
        строкой, случай числился пунктом «Владельцу» в бэклоге; страж в
        `finally` закрыл его вместе с остальными, и пункт снят.

        Объявленная длина здесь заведомо больше потолка, а послано сильно
        меньше: предмет — что служба не читает по объявленному числу.
        """
        body = self.SMUGGLED
        raw = raw_exchange(
            self.url,
            b"POST /rag HTTP/1.1\r\nHost: x\r\nauthorization: Bearer " + KEY.encode()
            + b"\r\ncontent-type: application/json\r\ncontent-length: 99999\r\n\r\n" + body,
            wait=0.6,
        )
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:300]!r}")
        self.assertIn(b"HTTP/1.1 400", raw)
        self.assertNotIn(b"777", raw, "протащенный вызов исполнился")

    def test_наведённый_отказ_обработчика_соединение_не_рассинхронизирует(self):
        """Четвёртый экземпляр класса — общий `except` в `_dispatch`.

        Находка `reviewer`, отозвавшего собственное ЧИСТО. Ветвь 500
        отвечает и тело не читает, и она **бесключевая**: отказ внутри
        `_healthz` открывает её для `GET /rag/healthz` с телом.

        Держатель отдельный и обязан быть отдельным: перебор `ROUTES` ×
        методы на ИСПРАВНОЙ службе эту ветвь не задевает вовсе — она
        открывается, только когда что-то внутри бросает. Предикат в полной
        форме: любой путь, способный отправить ответ, обязан либо вычитать
        тело, либо закрыть соединение — **включая общий `except`**.
        """

        class Exploding:
            """Индекс, который валится ровно там, где его читает `_healthz`."""

            def state(self):
                raise RuntimeError("наведённый отказ обработчика")

            def load(self):
                return []

        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            start_service(self, indexes=Exploding(),
                          handle_one=lambda m: {"jsonrpc": "2.0", "id": m.get("id"), "result": {"pong": True}})
            raw = self.exchange(b"GET", b"/rag/healthz", b"")
        finally:
            sys.stderr = stderr

        self.assertIn(b"HTTP/1.1 500", raw, f"ветвь 500 не открылась, проверка вырождена: {raw[:200]!r}")
        self.assertEqual(raw.count(b"HTTP/1.1 "), 1, f"ответов больше одного: {raw[:300]!r}")
        self.assertNotIn(b"777", raw, "протащенный вызов исполнился на ветви 500")

    def test_запрос_без_тела_соединение_не_рвёт(self):
        # Страж закрывает соединение только при НЕВЫЧИТАННОМ теле. Рвать
        # keep-alive там, где тела нет, — цена, которую платить не за что:
        # `/healthz` дёргают выкатка и HEALTHCHECK, и оба ходят без тела.
        # Два бесстелесных GET подряд в одно соединение: если keep-alive
        # цел, придут ДВА ответа. Чтение идёт до конца потока, а не по
        # одному `recv`: первый `recv` может вернуть одни заголовки, и
        # проверка «во втором куске есть 200» ловила бы буферизацию, а не
        # состояние соединения.
        one = b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"
        raw = raw_exchange(self.url, one + one, wait=0.6)
        self.assertEqual(raw.count(b"HTTP/1.1 200"), 2, f"keep-alive порван там, где тела не было: {raw[:200]!r}")

    def test_законный_запрос_с_телом_соединение_тоже_не_рвёт(self):
        """Страж закрывает соединение ТОЛЬКО при невычитанном теле.

        Без этого утверждения защита была бы неотличима от «рвать всякое
        соединение с телом»: мутация, снимающая `self._body_consumed = True`
        в `_read_body`, переживала весь прогон (мутация S12, поймана своим
        же перебором и закрыта здесь). Служба при этом оставалась бы
        «безопасной», но каждый законный вызов инструмента стоил бы нового
        соединения — цена, которой никто не назначал.

        Два ЗАКОННЫХ `POST /rag` с телом подряд в одно соединение: если
        флаг на месте, оба обслужены.
        """
        call = (
            b"POST /rag HTTP/1.1\r\nHost: x\r\nauthorization: Bearer " + KEY.encode()
            + b"\r\ncontent-type: application/json\r\ncontent-length: 42\r\n\r\n"
            + b'{"jsonrpc":"2.0","id":777,"method":"ping"}'
        )
        raw = raw_exchange(self.url, call + call, wait=0.6)
        self.assertEqual(raw.count(b"HTTP/1.1 200"), 2, f"keep-alive порван у законного запроса с телом: {raw[:300]!r}")


class StartupIndexTest(unittest.TestCase):
    """`main` перечитывает том ДО того, как начал отвечать.

    Находка гейтов Б2 к PR #282. Это **единственное**, что делает истинными
    п. 6 ADR `2026-09-29-2139` и абзац `rag/README.md` «Сборка не удалась —
    поиск может работать»: при отказе сборки `run_build` уходит по раннему
    `return` и до своего `indexes.load()` не доходит вовсе. Без строки в
    `main` служба с целой парой файлов в томе отвечала бы «индекса нет».

    `StartupTest` доводит `main` ровно до `make_server`, то есть строка
    исполнялась и раньше — не хватало утверждения, а не возможности.
    """

    def run_main(self, index_dir: Path, corpus_dir: str):
        from unittest import mock

        captured = {}

        def grab(status, *_a, **kwargs):
            captured.update(kwargs, status=status)
            raise RuntimeError("стоп")

        with (
            mock.patch.dict(os.environ, {"RAG_KEY": KEY, "RAG_CORPUS": corpus_dir}),
            mock.patch.object(serve, "INDEX_DIR", index_dir),
            mock.patch.object(serve, "make_server", grab),
        ):
            with self.assertRaises(RuntimeError):
                serve.main()
        self.assertIn("indexes", captured, "main не передал серверу индекс")
        return captured

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        # Корпуса нет намеренно: поток сборки не стартует, и наблюдается
        # ровно загрузка из `main`, а не та, что в конце `run_build`.
        self.no_corpus = str(self.dir / "нет-такого-каталога")

    def write_pair(self, commit="abcdef1"):
        rows = [{
            "source": "AGENTS.md", "title": "Правила", "section": "Роли", "chunk_id": "c1",
            "strategy": "structural", "sha256": "0" * 64, "commit": commit,
            "text": "роли определены в .claude/agents",
        }]
        VectorIndex.build("structural", rows, np.asarray([[1.0, 0.0]], dtype="float32")).save(self.dir)

    def test_целая_пара_в_томе_загружена_до_первого_ответа(self):
        self.write_pair()
        captured = self.run_main(self.dir, self.no_corpus)
        self.assertEqual(captured["indexes"].state()["strategies"], ["structural"])
        self.assertEqual(captured["indexes"].commit(), "abcdef1")

    def test_поиск_работает_при_отказавшей_сборке(self):
        # То самое обещание п. 6 и README целиком: состояние сборки `failed`,
        # а индекс загружен и по нему ищется.
        self.write_pair()
        captured = self.run_main(self.dir, self.no_corpus)
        self.assertEqual(captured["status"].read()["state"], "failed")
        self.assertEqual(captured["status"].read()["error"], serve.NO_CORPUS)
        self.assertTrue(captured["indexes"].any_loaded, "сборка отказала — и поиска не стало")

    def test_пустой_том_это_не_ложная_загрузка(self):
        # Иначе проверка выше проходила бы и при `state()`, отдающем заглушку.
        captured = self.run_main(self.dir, self.no_corpus)
        self.assertEqual(captured["indexes"].state()["strategies"], [])
        self.assertFalse(captured["indexes"].any_loaded)


if __name__ == "__main__":
    unittest.main()
