"""HTTP-поверхность единицы: открытый `/healthz` и `/rag` за ключом.

Контракт единицы в этом проекте — каталог, `Dockerfile` и ответ на
`/healthz` (шаг «Контейнер поднимается и отвечает на /healthz» в `ci.yml`).
Сборка индекса идёт в фоне и `/healthz` не роняет: пока индекса нет, он
честно говорит, на чём стоит.

Порядок в `_dispatch` читается сверху вниз и таков намеренно (ADR
2026-09-29-2139, п. 1) — это тот же порядок, что у службы дня 16
(`mcp/src/service.js`):

  1) таблица маршрутов: пути вне её дают пустой 404;
  2) ключ — всегда и ДО чтения тела; у записи с окном `open` ключа нет;
  3) метод не тот — 405 (у `/rag` это «не POST»);
  4) тело с потолком 64 КБ;
  5) окна лимитера — ДО передачи `tools/call` обработчику RPC;
  6) и только теперь RPC.

Отказ по ключу и неизвестный путь дают побайтно одинаковый пустой 404 —
решение владельца по `/mcp` (ADR 2026-09-23-1844, пп. 1–2) перенесено сюда
без нового обсуждения.

Поле `error` — из закрытого набора причин (`REASONS`), а не текст
исключения. `/rag/healthz` публичен и открыт без ключа: его дёргает шаг
«Проверка живого сайта» в `deploy.yml`, а значит её читает кто угодно. Текст
исключения выдавал бы `OLLAMA_URL` — внутреннее имя службы и порт, — а при
другой ошибке выдал бы то, что сформатировал `urllib`: пути, адреса,
содержимое ответа. Это не секрет, но и не то, что публикуют даром, а главное
— набор возможных строк там неограничен. Подробность целиком уходит в журнал
контейнера, где её читает владелец: `docker compose logs rag`.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import limits
import rpc
import tools

PORT = int(os.environ.get("PORT", "8086"))
INDEX_DIR = Path(os.environ.get("RAG_INDEX", "/data"))

# Тело JSON-RPC больше этого не читаем: у наших инструментов три коротких
# аргумента, и самый длинный из них уже ограничен `tools.MAX_QUERY`.
MAX_BODY = 64 * 1024

# Закрытый набор причин отказа: ровно эти строки может увидеть посетитель.
NO_CORPUS = "корпус не смонтирован"
EMPTY_CORPUS = "корпус пуст"
NO_EMBEDDER = "эмбеддер не ответил"
TOO_LONG = "сборка не уложилась в срок"
INTERNAL = "внутренняя ошибка сборки"
REASONS = (NO_CORPUS, EMPTY_CORPUS, NO_EMBEDDER, TOO_LONG, INTERNAL)

SERVER_INFO = {"name": "project-index", "version": "1"}


class Status:
    """Состояние сборки. Читают из потока HTTP, пишет поток сборки."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = {"state": "starting", "strategies": [], "error": None, "commit": "unknown"}

    def read(self) -> dict:
        with self._lock:
            return dict(self._value)

    def update(self, **fields) -> None:
        with self._lock:
            self._value.update(fields)


# --- таблица маршрутов -------------------------------------------------------
#
# Конвенция ADR 2026-09-29-1600 приезжает сюда по существу, а не по букве
# (ADR 2026-09-29-2139, п. 7): у дней окна называются run/write/read/open, у
# этой единицы ручек две и окно одно — минута с часом на вызовы инструментов.
# Общее с днями то, ради чего конвенция и заводилась: ручка объявляет своё
# окно в таблице, ручки вне таблицы не существует, а исключение обязано
# нести причину. Запись без окна не загружается — ни в проде, ни в тесте.

LIMITS = ("call", "open")


class Route:
    def __init__(self, method: str, paths: tuple[str, ...], limit: str, handler: str, why: str = "") -> None:
        self.method = method
        self.paths = paths
        self.limit = limit
        self.handler = handler
        self.why = why

    def __repr__(self) -> str:
        return f"{self.method} {self.paths[0]}"


ROUTES = (
    Route(
        "GET",
        # Два пути: за Caddy префикс срезан (`uri strip_prefix /rag`), а
        # изнутри контейнера HEALTHCHECK ходит на `/healthz` напрямую.
        ("/healthz", "/rag/healthz"),
        "open",
        handler="healthz",
        why="признак живости читает выкатка и HEALTHCHECK образа — до ключа и без него",
    ),
    Route("POST", ("/rag",), "call", handler="rpc"),
)


def check_routes(routes=ROUTES) -> None:
    """Умолчание безопасное отказом старта.

    Запись без окна, с неизвестным окном или `open` без причины — модуль не
    загружается. Зовётся при загрузке модуля, а не из `main`: иначе тест,
    импортирующий `serve`, проверял бы не то, что поднимается в проде.
    """
    for route in routes:
        if route.limit not in LIMITS:
            raise RuntimeError(f"{route}: окно не названо (ожидалось одно из {LIMITS})")
        if route.limit == "open" and not route.why.strip():
            raise RuntimeError(f"{route}: исключение без причины")
        if not route.paths:
            raise RuntimeError(f"{route}: маршрут без пути")


check_routes()


def match(path: str, routes=ROUTES) -> Route | None:
    clean = path.split("?", 1)[0].split("#", 1)[0]
    clean = clean.rstrip("/") or "/"
    for route in routes:
        if clean in route.paths:
            return route
    return None


def client_ip(headers, remote: str) -> str:
    """Адрес клиента.

    Сам по себе заголовок ничего не гарантирует: подставить в него что угодно
    может кто угодно, кто до службы дотянулся. Держит границу вход —
    `header_up X-Forwarded-For {client_ip}` в блоке `/rag` файла
    `deploy/Caddyfile` ЗАМЕНЯЕТ заголовок адресом соединения, а мимо входа до
    службы не достучаться: портов наружу нет и сеть `rag` отдельная.
    Последний элемент — на случай ещё одного прокси, дописывающего адрес в
    хвост.
    """
    forwarded = headers.get("x-forwarded-for")
    if forwarded:
        last = forwarded.split(",")[-1].strip()
        if last:
            return last
    return remote or "unknown"


def make_handler(status: Status, indexes, limiter, daily_cap, handle_one, key: str, log=lambda _e: None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # Все методы — через один диспетчер. Иначе `BaseHTTPRequestHandler`
        # отвечал бы на DELETE своим 501 с текстом, то есть отличал бы этот
        # адрес от пустого места ещё до проверки ключа.
        def do_GET(self):  # noqa: N802 — имя задаёт BaseHTTPRequestHandler
            self._dispatch("GET")

        def do_POST(self):  # noqa: N802
            self._dispatch("POST")

        def do_PUT(self):  # noqa: N802
            self._dispatch("PUT")

        def do_DELETE(self):  # noqa: N802
            self._dispatch("DELETE")

        def do_PATCH(self):  # noqa: N802
            self._dispatch("PATCH")

        def do_HEAD(self):  # noqa: N802
            self._dispatch("HEAD")

        def do_OPTIONS(self):  # noqa: N802
            self._dispatch("OPTIONS")

        # --- ответы ---------------------------------------------------------

        def _send(self, code: int, payload, extra: dict | None = None) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("cache-control", "no-store")
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _nothing_here(self) -> None:
            """«Здесь ничего нет»: 404, пустое тело, ни `content-type`, ни строчки.

            Одна функция на обе причины — «нет такого пути» и «нет годного
            ключа» — именно затем, чтобы ответы совпадали побайтно: два
            разных ответа снова отличали бы эндпоинт от пустого места.

            **Соединение закрывается, и это не гигиена, а замок.** Тело
            неавторизованного запроса мы намеренно не читаем (потолок тела
            иначе не был бы потолком), поэтому байты тела остаются в сокете.
            Без этой строки `BaseHTTPRequestHandler` идёт на следующий круг
            `handle_one_request` и разбирает их **как следующий запрос** —
            то есть кто угодно без ключа кладёт в тело
            `GET /healthz HTTP/1.1…` и получает на том же соединении второй
            ответ, уже с телом. Caddy переносит тело дословно и держит
            keep-alive к `rag:8086`, так что рассинхронизированное соединение
            уходит обратно в пул.

            Держит `test_serve.py::SmugglingTest` — сырым сокетом, а не
            клиентом: предмет в том, сколько ответов приходит на одно
            соединение, а `http.client` второй ответ просто не прочитал бы
            (находка гейтов Б1 к PR #282; снятие этой строки оставляло весь
            прогон зелёным).
            """
            self.close_connection = True
            self.send_response(404)
            self.send_header("content-length", "0")
            self.send_header("cache-control", "no-store")
            self.end_headers()

        # --- порядок --------------------------------------------------------

        def _dispatch(self, method: str) -> None:
            try:
                route = match(self.path)
                # 1. Путь вне таблицы — пустое место.
                if route is None:
                    return self._nothing_here()

                # 2. Ключ — всегда и ДО чтения тела.
                if route.limit != "open" and not self._key_ok():
                    ip = client_ip(self.headers, self.client_address[0] if self.client_address else "")
                    count, signal = limiter.note_refusal(ip)
                    log({"event": "refuse", "path": route.paths[0], "code": "unauthorized"})
                    # Одна строка за окно на адрес: перебирают. Адреса в
                    # записи нет и не должно быть — журнал контейнера
                    # переживает часовое окно (I-10). Сигнал отвечает
                    # «перебор идёт», а не «кто именно».
                    if signal:
                        log({"event": "refusal_burst", "path": route.paths[0], "count": count})
                    return self._nothing_here()

                # 3. Метод не тот.
                if method != route.method:
                    self.close_connection = True
                    return self._send(405, {"ok": False, "code": "method_not_allowed"}, {"allow": route.method})

                if route.handler == "healthz":
                    return self._healthz()
                return self._rpc()
            except Exception as error:  # noqa: BLE001 — служба обязана отвечать, а не падать
                traceback.print_exc(file=sys.stderr)
                log({"event": "error", "message": str(error)})
                try:
                    self._send(500, {"ok": False, "code": "internal_error"})
                except Exception:  # noqa: BLE001 — ответ уже начат, добавить нечего
                    self.close_connection = True

        def _key_ok(self) -> bool:
            header = self.headers.get("authorization") or ""
            given = header[7:] if header.startswith("Bearer ") else ""
            # `hmac.compare_digest`, а не `==`: сравнение по байтам с ранним
            # выходом отдаёт длину совпавшего префикса временем ответа.
            return hmac.compare_digest(given.encode("utf-8"), key.encode("utf-8"))

        # --- ручки ----------------------------------------------------------

        def _healthz(self) -> None:
            # 200 значит «единица поднялась», а не «индекс готов»: состояние
            # сборки — в теле. Иначе выкатка ждала бы часы первой сборки.
            #
            # `index` рядом со `state` намеренно: `state` описывает СБОРКУ, а
            # `index` — то, что загружено в память и по чему идёт поиск
            # прямо сейчас (ADR п. 6). Остаток суточного потолка сюда НЕ
            # идёт — он за ключом, в `project.status`: прохожему он говорил
            # бы, пользуется ли службой кто-то прямо сейчас (тот же довод,
            # по которому за ключом спрятана статистика лимитера у службы
            # дня 16).
            body = status.read()
            body["index"] = indexes.state()
            self._send(200, body)

        def _read_body(self) -> bytes:
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY:
                raise ValueError("тело больше 64 КБ")
            # Читаем ровно столько, сколько объявлено: объявить меньше, чем
            # послать, значит оставить хвост следующему запросу — поэтому на
            # любом отказе ниже соединение закрывается.
            return self.rfile.read(length)

        def _rpc(self) -> None:
            # 4. Тело с потолком.
            try:
                body = json.loads(self._read_body())
            except (ValueError, OSError):
                self.close_connection = True
                return self._send(400, rpc.rpc_error(None, rpc.PARSE_ERROR, "parse error"))

            # 5. Окна лимитера — ДО исполнения: обработчик RPC зовётся ниже
            # этой строки, и до эмбеддера ничего не доходит.
            calls = rpc.count_tool_calls(body)
            if calls > 0:
                ip = client_ip(self.headers, self.client_address[0] if self.client_address else "")
                ok, reason_, words = limiter.reserve(ip, calls)
                if not ok:
                    log({"event": "refuse", "path": "/rag", "code": "rate_limited", "reason": reason_})
                    return self._send(429, rpc.rpc_error(rpc.first_id(body), -32002, words))

            # 6. И только теперь RPC.
            if isinstance(body, list):
                if not body:
                    return self._send(400, rpc.rpc_error(None, rpc.INVALID_REQUEST, "empty batch"))
                answers = [a for a in (handle_one(item) for item in body) if a is not None]
                if not answers:
                    return self._accepted()
                return self._send(200, answers)

            answer = handle_one(body)
            if answer is None:
                return self._accepted()
            return self._send(200, answer)

        def _accepted(self) -> None:
            """Уведомление — 202 без тела, как велит спецификация."""
            self.send_response(202)
            self.send_header("content-length", "0")
            self.send_header("cache-control", "no-store")
            self.end_headers()

        def log_message(self, *_args) -> None:
            return

    return Handler


def _embedder():
    import build
    from embed import OllamaEmbedder

    return OllamaEmbedder(build.OLLAMA_URL, build.MODEL)


def make_tools(status: Status, indexes, daily_cap, embedder=None) -> list:
    return [
        tools.make_search(indexes, embedder if embedder is not None else _embedder(), daily_cap),
        tools.make_status(status, indexes, daily_cap),
    ]


def make_server(
    status: Status,
    port: int = PORT,
    indexes=None,
    limiter=None,
    daily_cap=None,
    handle_one=None,
    key: str = "",
    log=lambda _e: None,
) -> ThreadingHTTPServer:
    indexes = indexes if indexes is not None else tools.Indexes(INDEX_DIR)
    limiter = limiter if limiter is not None else limits.Limiter()
    daily_cap = daily_cap if daily_cap is not None else limits.DailyCap(log=log)
    if handle_one is None:
        handle_one = rpc.create_rpc(SERVER_INFO, make_tools(status, indexes, daily_cap))
    return ThreadingHTTPServer(
        ("0.0.0.0", port), make_handler(status, indexes, limiter, daily_cap, handle_one, key, log)
    )


def reason(err: BaseException) -> str:
    """Причина из закрытого набора. Подробность сюда не попадает никогда."""
    import build
    from embed import EmbedError

    if isinstance(err, build.BuildTimeout):
        return TOO_LONG
    if isinstance(err, build.EmptyCorpus):
        # Каталог есть, чанков нет — это сбой шага «Сборка корпуса для
        # индекса», а не эмбеддера. Ветка отдельная, потому что набор из
        # пяти строк бесполезен, если одна из них показывает не туда.
        return EMPTY_CORPUS
    if isinstance(err, EmbedError):
        return NO_EMBEDDER
    return INTERNAL


def run_build(status: Status, indexes) -> None:
    import build
    import corpus

    status.update(state="building", commit=corpus.read_commit(build.CORPUS_DIR))
    try:
        stats = build.build_all()
    except Exception as err:  # эмбеддер недоступен — единица жива, поиска нет
        # В журнал — всё, в ответ — причина из набора.
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        status.update(state="failed", error=reason(err))
        return
    status.update(state="ready", strategies=stats, error=None)
    # Перечитать том: до этой строки в памяти лежит то, что нашлось при
    # старте, то есть индекс ПРОШЛОЙ выкатки. Без неё свежесобранный индекс
    # не искался бы до перезапуска контейнера.
    indexes.load()


def main() -> int:
    # Без ключа процесс не стартует. Открыть `/rag` без замка нельзя: за ним
    # ядро общей машины, и «ключа нет — значит, без ключа» стало бы тихим
    # отказом защиты, которую этот заход и заводит.
    key = os.environ.get("RAG_KEY", "").strip()
    if not key:
        print("::error::RAG_KEY не задан — служба не поднимается", file=sys.stderr)
        return 2

    status = Status()
    indexes = tools.Indexes(INDEX_DIR)
    # Загрузка ДО сборки: в томе может лежать целая пара с прошлой выкатки, и
    # тогда поиск работает с первой секунды, пока идёт часовая сборка.
    indexes.load()

    if Path(os.environ.get("RAG_CORPUS", "corpus")).is_dir():
        threading.Thread(target=run_build, args=(status, indexes), daemon=True).start()
    else:
        status.update(state="failed", error=NO_CORPUS)

    server = make_server(
        status,
        indexes=indexes,
        key=key,
        log=lambda e: print(json.dumps(e, ensure_ascii=False), flush=True),
    )
    print(f"rag слушает :{PORT}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
