"""Поднятый http.server, отвечающий как Ollama.

Не мок клиента, а настоящий HTTP-обмен: проверяются и запрос, и разбор
ответа. Живая Ollama появится в заходе 3; здесь непроверенным остаётся
только её собственный контракт.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeOllama:
    def __init__(self, routes: dict[str, tuple[int, object]]) -> None:
        self.routes = routes
        self.requests: list[tuple[str, dict]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _reply(self, request: dict | None = None) -> None:
                status, payload = outer.routes.get(self.path, (404, {"error": "no route"}))
                if callable(payload):
                    payload = payload(request or {})
                body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                outer.requests.append((self.path, {}))
                self._reply()

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("content-length", 0))
                request = json.loads(self.rfile.read(n) or b"{}")
                outer.requests.append((self.path, request))
                self._reply(request)

            def log_message(self, *_a):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def __enter__(self) -> "FakeOllama":
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    @staticmethod
    def deterministic(request: dict) -> dict:
        """Вектор из sha256 текста: один и тот же текст — один и тот же вектор."""
        import hashlib

        out = []
        for text in request.get("input", []):
            digest = hashlib.sha256(text.encode("utf-8")).digest()
            out.append([b / 255.0 for b in digest[:8]])
        return {"embeddings": out}

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.server.server_close()
