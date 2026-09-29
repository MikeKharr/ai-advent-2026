"""HTTP-поверхность единицы: пока только `/healthz`.

Контракт единицы в этом проекте — каталог, `Dockerfile` и ответ на
`/healthz` (шаг «Контейнер поднимается и отвечает на /healthz» в `ci.yml`).
Сборка индекса идёт в фоне и `/healthz` не роняет: пока индекса нет, он
честно говорит, на чём стоит. Инструменты MCP — заход 4, здесь их нет.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8086"))


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


def make_handler(status: Status):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 — имя задаёт BaseHTTPRequestHandler
            if self.path.rstrip("/") not in ("/healthz", "/rag/healthz"):
                self.send_error(404)
                return
            # 200 значит «единица поднялась», а не «индекс готов»: состояние
            # сборки — в теле. Иначе выкатка ждала бы часы первой сборки.
            body = json.dumps(status.read(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            return

    return Handler


def make_server(status: Status, port: int = PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("0.0.0.0", port), make_handler(status))


def run_build(status: Status) -> None:
    import build
    import corpus

    status.update(state="building", commit=corpus.read_commit(build.CORPUS_DIR))
    try:
        stats = build.build_all()
    except Exception as err:  # эмбеддер недоступен — единица жива, поиска нет
        status.update(state="failed", error=f"{type(err).__name__}: {err}")
        return
    status.update(state="ready", strategies=stats, error=None)


def main() -> int:
    status = Status()
    if Path(os.environ.get("RAG_CORPUS", "corpus")).is_dir():
        threading.Thread(target=run_build, args=(status,), daemon=True).start()
    else:
        status.update(state="failed", error="корпус не смонтирован")
    server = make_server(status)
    print(f"rag слушает :{PORT}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
