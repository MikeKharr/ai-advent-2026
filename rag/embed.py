"""Клиент Ollama: /api/tags, /api/pull, /api/embed.

Только stdlib. Ключа нет и расхода в деньгах нет: служба своя (ADR
2026-09-29-1639, п. 4). Дорого здесь ядро общей машины, поэтому клиент
считает каждый свой вызов — счётчик уходит в метрики сравнения.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class EmbedError(RuntimeError):
    """Эмбеддер не ответил или ответил не тем. Пустой список — не ответ."""


BODY_LIMIT = 400


def _тело_отказа(err: urllib.error.HTTPError) -> str:
    """Тело ответа службы — в текст отказа, и значит в журнал.

    Пока его здесь не было, `400` от Ollama выглядел одинаково при любой
    причине, и два диагноза подряд были поставлены по косвенным признакам
    и оба оказались неверными (`agent_docs/backlog.md`, запись о `400` на
    стратегии `structural`).

    Наружу это не выходит: публичная причина берётся из закрытого набора
    (`rag/serve.py`, `reason`), и тело в неё не попадает ни по какой ветке.
    Ollama своя, ключей у неё нет, в теле нет ничего секретного; обрезка —
    не про тайну, а про размер строки в журнале.
    """
    try:
        body = err.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — тело уже прочитано или оборвано
        return "(тело не прочитано)"
    body = " ".join(body.split())
    if not body:
        return "(тело пусто)"
    return body[:BODY_LIMIT] + ("…" if len(body) > BODY_LIMIT else "")


class OllamaEmbedder:
    def __init__(self, base_url: str, model: str, timeout: float = 600.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.calls = 0
        self.vectors = 0

    def _post(self, path: str, payload: dict, timeout: float | None = None) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raise EmbedError(f"{path}: HTTP {err.code} {_тело_отказа(err)}") from err
        except (urllib.error.URLError, OSError, TimeoutError) as err:
            raise EmbedError(f"{path}: нет связи с {self.base_url} ({err})") from err
        except json.JSONDecodeError as err:
            raise EmbedError(f"{path}: ответ не JSON") from err

    def tags(self) -> list[str]:
        """Имена моделей, которые у службы уже есть."""
        req = urllib.request.Request(f"{self.base_url}/api/tags", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raise EmbedError(f"/api/tags: HTTP {err.code}") from err
        except (urllib.error.URLError, OSError, TimeoutError, json.JSONDecodeError) as err:
            raise EmbedError(f"/api/tags: нет связи с {self.base_url} ({err})") from err
        return [m.get("name", "") for m in body.get("models", [])]

    def has_model(self) -> bool:
        """Есть ли У СЛУЖБЫ именно та модель, что заказана.

        Сравнение с тегом, а не по имени до двоеточия: имя без тега Ollama
        разворачивает в `:latest`, и при заказе `embeddinggemma:300m-qat-q4_0`
        уже лежащий `embeddinggemma:latest` выдавал бы «модель есть». Тогда
        `pull()` не звался бы, новые веса не приезжали, а смена модели
        проходила бы молча и без последствий.
        """
        wanted = self.model if ":" in self.model else f"{self.model}:latest"
        return wanted in self.tags()

    def pull(self) -> None:
        body = self._post("/api/pull", {"model": self.model, "stream": False})
        status = body.get("status")
        if status != "success":
            raise EmbedError(f"/api/pull: модель {self.model} не приехала (status={status!r})")

    def embed(self, texts: list[str], timeout: float | None = None) -> list[list[float]]:
        """Векторы для текстов, по одному на текст, в том же порядке.

        `timeout` — срок ЭТОГО вызова. Его задаёт вызывающий, потому что у
        прохода сборки свой срок на всё (`build.Deadline`), и вызов не вправе
        пережить его: иначе потолок на проход был бы потолком «плюс ещё
        десять минут». Пусто — умолчание клиента.
        """
        if not texts:
            return []
        self.calls += 1
        body = self._post("/api/embed", {"model": self.model, "input": texts}, timeout=timeout)
        vectors = body.get("embeddings")
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            got = len(vectors) if isinstance(vectors, list) else None
            raise EmbedError(f"/api/embed: векторов {got}, а текстов {len(texts)}")
        dims = {len(v) for v in vectors}
        if len(dims) != 1 or not all(isinstance(v, list) and v for v in vectors):
            raise EmbedError(f"/api/embed: неодинаковая или пустая размерность {sorted(dims)}")
        self.vectors += len(vectors)
        return vectors
