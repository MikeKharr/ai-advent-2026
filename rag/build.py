"""Сборка индекса: корпус → чанки → векторы → `IndexFlatIP` в томе.

Инкремент по `sha256` чанка (ADR 2026-09-29-1639, п. 6): при старте
эмбеддятся только те чанки, которых в томе нет. Первая сборка — часы;
дельта мержа — минуты.
"""

from __future__ import annotations

import argparse
import os
import statistics
import time
from pathlib import Path

import numpy as np

import chunking
import corpus
from embed import EmbedError, OllamaEmbedder
from index import VectorIndex

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
# Умолчание с тегом: без тега Ollama подставит `:latest`, и уже лежащие
# в томе веса другой квантизации сошли бы за эту модель.
MODEL = os.environ.get("RAG_MODEL", "embeddinggemma:300m-qat-q4_0")
CORPUS_DIR = Path(os.environ.get("RAG_CORPUS", "corpus"))
INDEX_DIR = Path(os.environ.get("RAG_INDEX", "/data"))
BATCH = int(os.environ.get("RAG_BATCH", "16"))
# Срок на ВЕСЬ проход сборки, а не на вызов. Ноль и меньше — срока нет.
#
# Зачем отдельно от срока запроса. У запроса срок есть и был (600 с), но
# вызовов на стратегию под две сотни: зависший эмбеддер отдавал бы по отказу
# каждые десять минут, и проход тянулся бы до ~31 часа на стратегию, занимая
# ядро общей машины (находка `compliance` к PR #278). Потолок на вызов такой
# проход не ограничивает вовсе — ограничивает только потолок на проход.
#
# Откуда 12 часов. Это не замер VPS, а граница: полный проход на локальной
# связке занял 278 с, на одном ядре VPS ожидаются часы (rag/README.md).
# Число обязано быть заметно больше честной сборки и заметно меньше суток —
# первый прогон на VPS и есть замер, который его проверит.
#
# Чем платим: проход, прерванный по сроку, теряет векторы текущей стратегии —
# в том их сохраняет только завершённая стратегия. Поэтому срок не подгоняют
# впритык к ожидаемому времени сборки.
BUILD_TIMEOUT = float(os.environ.get("RAG_BUILD_TIMEOUT_SECONDS", "43200"))

# Сколько ждать, пока эмбеддер начнёт отвечать.
#
# Прежняя редакция этого комментария была НЕВЕРНА и названа неверной вслух:
# она говорила про разворачивание образа в 3,75 ГБ. Compose тянет и
# распаковывает образы ДО создания контейнеров, а `depends_on` задаёт порядок
# старта — с распаковкой эта единица не гоняется никогда (находка `reviewer`,
# Б4).
#
# Настоящее окно другое и меньше: `docker compose up -d` возвращается по
# старту, а не по готовности, поэтому `rag` может уйти в /api/tags раньше,
# чем `ollama` забиндит слушателя. Окно — секунды. Цена промаха несоразмерна
# окну: повтора на единственном пути нет, `run_build` ловит отказ один раз и
# заканчивает поток, контейнер остаётся живым и отдаёт 200 — то есть один
# промах оставляет индекс несобранным до ручного рестарта, а выкатка при этом
# зелёная.
#
# Признак готовности `ollama` этого окна не закрывает: `healthcheck` там никем
# автоматически не читается (deploy/compose.yml, блок ollama), а `ollama list`
# не равен готовности /api/embed. Держит окно только это ожидание.
#
# Ожидание входит в срок прохода, а не добавляется к нему.
OLLAMA_WAIT = float(os.environ.get("RAG_OLLAMA_WAIT_SECONDS", "600"))


class BuildTimeout(RuntimeError):
    """Проход сборки не уложился в отведённый срок."""


class EmptyCorpus(RuntimeError):
    """Каталог корпуса есть, а чанков не даёт.

    Отдельным классом, а не `EmbedError`: отличается ПОВОД смотреть журнал.
    Пока это был `EmbedError`, публичный `/healthz` на сбой шага «Сборка
    корпуса для индекса» отвечал «эмбеддер не ответил» — то есть единственный
    быстрый сигнал владельцу указывал не туда (находка `reviewer`, Б3).
    """


class Deadline:
    """Один срок на весь проход. `now` подменяется в тестах."""

    def __init__(self, seconds: float, now=time.monotonic) -> None:
        self._now = now
        self.at = now() + seconds if seconds > 0 else None

    def remaining(self) -> float | None:
        return None if self.at is None else self.at - self._now()

    def check(self, where: str) -> float | None:
        """Сколько осталось. Срок вышел — исключение ДО следующего вызова."""
        left = self.remaining()
        if left is not None and left <= 0:
            raise BuildTimeout(
                f"сборка не уложилась в RAG_BUILD_TIMEOUT_SECONDS={BUILD_TIMEOUT:.0f} с: прервана на {where}"
            )
        return left


def read_chunks(corpus_dir: Path, strategy: str) -> list[chunking.Chunk]:
    """Чанки всего корпуса по одной стратегии."""
    corpus_dir = Path(corpus_dir)
    commit = corpus.read_commit(corpus_dir)
    cut = chunking.STRATEGIES[strategy]
    out: list[chunking.Chunk] = []
    for rel in corpus.collect(corpus_dir):
        text = (corpus_dir / rel).read_text(encoding="utf-8", errors="replace")
        out.extend(cut(str(rel).replace(os.sep, "/"), text, commit))
    return out


def chunk_stats(chunks: list[chunking.Chunk]) -> dict:
    if not chunks:
        return {"count": 0, "median_chars": 0, "cut_blocks_share": 0.0}
    lengths = [len(c.text) for c in chunks]
    cut = sum(
        chunking.cuts_block(c, chunks[i + 1] if i + 1 < len(chunks) else None)
        for i, c in enumerate(chunks)
    )
    return {
        "count": len(chunks),
        "median_chars": int(statistics.median(lengths)),
        "cut_blocks_share": round(cut / len(chunks), 4),
    }


def embed_part(embedder, part, call_timeout, deadline, strategy: str) -> list:
    """Векторы батча; при отказе службы — сборка падает, назвав виновника.

    Служба отвечает на батч целиком: один вход за окном или один, на котором
    умер раннер, — и `400` приходит на все шестнадцать, не говоря, на какой.
    На корпусе из трёх тысяч чанков такое сообщение бесполезно, поэтому на
    `400` батч переспрашивается по одному входу — ТОЛЬКО ради имени.

    **Сборка падает в любом случае** (решение владельца 2026-10-02). Если по
    одному все прошли, отказ был не про вход, а про запрос целиком — и это
    тоже называется прямо. Продолжать сборку на одиночных вызовах нельзя: это
    молча умножало бы работу общего ядра до ×16, и прогон оставался бы
    зелёным (находка compliance и reviewer к #293). Так цена переспроса — до
    шестнадцати вызовов — платится только когда сборка всё равно падает.

    Переспроса нет, если служба не ответила вовсе (`status is None`: нет
    связи, срок): тогда первый же одиночный вызов «назвал» бы невиновный чанк.

    Публичная причина от этого не меняется — она из закрытого набора
    (`serve.reason`); подробность уходит только в журнал.
    """
    try:
        return embedder.embed([c.embed_text for c in part], call_timeout)
    except EmbedError as err:
        if err.status != 400:
            raise
        for c in part:
            left = deadline.check(f"стратегия {strategy}, переспрос чанка {c.source}")
            one_timeout = None if left is None else min(embedder.timeout, left)
            try:
                embedder.embed([c.embed_text], one_timeout)
            except EmbedError as one:
                raise EmbedError(
                    f"чанк {c.source} § {c.section!r}, {len(c.embed_text)} знаков: {one}",
                    status=one.status,
                ) from one
        raise EmbedError(
            f"батч из {len(part)} отказан, а по одному прошли все — виноватого "
            f"входа нет, отказ про запрос целиком: {err}",
            status=err.status,
        ) from err


def build_strategy(
    strategy: str,
    chunks: list[chunking.Chunk],
    embedder: OllamaEmbedder,
    index_dir: Path,
    batch: int = BATCH,
    deadline: Deadline | None = None,
) -> dict:
    """Собрать и сохранить индекс одной стратегии. Возвращает метрики сборки."""
    started = time.monotonic()
    deadline = deadline if deadline is not None else Deadline(BUILD_TIMEOUT)
    known = {}
    # Модель передаётся в load: индекс, собранный другой моделью, читается как
    # отсутствующий. Ключ инкремента — только хэш чанка, а векторы разных
    # моделей одинаковой размерности, поэтому иначе старые подмешались бы к
    # новым молча, без ошибки и без признака.
    old = VectorIndex.load(index_dir, strategy, embedder.model)
    if old is not None:
        known = old.vectors_by_sha()

    fresh = [c for c in chunks if c.sha256 not in known]
    calls_before, reused = embedder.calls, len(chunks) - len(fresh)
    for i in range(0, len(fresh), batch):
        part = fresh[i : i + batch]
        # Проверка ДО вызова, а не после: иначе срок значил бы «столько плюс
        # ещё один запрос», и потолок на проход не был бы потолком.
        left = deadline.check(f"стратегия {strategy}, чанк {i} из {len(fresh)}")
        # Срок вызова не вправе пережить срок прохода — отсюда min.
        call_timeout = None if left is None else min(embedder.timeout, left)
        vectors_part = embed_part(embedder, part, call_timeout, deadline, strategy)
        for chunk, vector in zip(part, vectors_part):
            known[chunk.sha256] = np.asarray(vector, dtype="float32")

    vectors = np.asarray([known[c.sha256] for c in chunks], dtype="float32")
    VectorIndex.build(strategy, [c.as_meta() for c in chunks], vectors,
                      embedder.model).save(index_dir)
    stats = chunk_stats(chunks)
    stats.update(
        strategy=strategy,
        embedded=len(fresh),
        reused=reused,
        embed_calls=embedder.calls - calls_before,
        build_seconds=round(time.monotonic() - started, 2),
        dim=int(vectors.shape[1]) if len(vectors) else 0,
    )
    return stats


def wait_ready(
    embedder: OllamaEmbedder,
    deadline: Deadline,
    wait: float = OLLAMA_WAIT,
    sleep=time.sleep,
    now=time.monotonic,
) -> None:
    """Дождаться, пока эмбеддер начнёт отвечать, или отдать его отказ наружу.

    Ожидание ограничено с двух сторон: своим сроком `wait` и общим сроком
    прохода. Второе важнее: без него зависшая служба превратила бы ожидание
    в ещё одно место, где проход стоит часами.
    """
    until = now() + wait
    while True:
        deadline.check("ожидание эмбеддера")
        try:
            embedder.tags()
            return
        except EmbedError:
            if now() >= until:
                raise
            sleep(3.0)


def build_all(
    corpus_dir: Path = CORPUS_DIR,
    index_dir: Path = INDEX_DIR,
    embedder: OllamaEmbedder | None = None,
    deadline: Deadline | None = None,
    batch: int = BATCH,
) -> list[dict]:
    embedder = embedder or OllamaEmbedder(OLLAMA_URL, MODEL)
    # Срок один на обе стратегии: он про занятое ядро машины, а стратегий на
    # этом ядре две подряд. Свой срок у каждой давал бы вдвое больший потолок.
    deadline = deadline if deadline is not None else Deadline(BUILD_TIMEOUT)
    wait_ready(embedder, deadline)
    if not embedder.has_model():
        embedder.pull()
    out = []
    for strategy in chunking.STRATEGIES:
        chunks = read_chunks(corpus_dir, strategy)
        if not chunks:
            raise EmptyCorpus(f"корпус {corpus_dir} пуст — индексировать нечего")
        out.append(build_strategy(strategy, chunks, embedder, index_dir, batch, deadline))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Сборка индекса проекта")
    parser.add_argument("--corpus", default=str(CORPUS_DIR))
    parser.add_argument("--index", default=str(INDEX_DIR))
    args = parser.parse_args(argv)
    for stats in build_all(Path(args.corpus), Path(args.index)):
        print(stats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
