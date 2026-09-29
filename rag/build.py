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
MODEL = os.environ.get("RAG_MODEL", "embeddinggemma")
CORPUS_DIR = Path(os.environ.get("RAG_CORPUS", "corpus"))
INDEX_DIR = Path(os.environ.get("RAG_INDEX", "/data"))
BATCH = int(os.environ.get("RAG_BATCH", "16"))


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


def build_strategy(
    strategy: str,
    chunks: list[chunking.Chunk],
    embedder: OllamaEmbedder,
    index_dir: Path,
    batch: int = BATCH,
) -> dict:
    """Собрать и сохранить индекс одной стратегии. Возвращает метрики сборки."""
    started = time.monotonic()
    known = {}
    old = VectorIndex.load(index_dir, strategy)
    if old is not None:
        known = old.vectors_by_sha()

    fresh = [c for c in chunks if c.sha256 not in known]
    calls_before, reused = embedder.calls, len(chunks) - len(fresh)
    for i in range(0, len(fresh), batch):
        part = fresh[i : i + batch]
        for chunk, vector in zip(part, embedder.embed([c.embed_text for c in part])):
            known[chunk.sha256] = np.asarray(vector, dtype="float32")

    vectors = np.asarray([known[c.sha256] for c in chunks], dtype="float32")
    VectorIndex.build(strategy, [c.as_meta() for c in chunks], vectors).save(index_dir)
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


def build_all(
    corpus_dir: Path = CORPUS_DIR,
    index_dir: Path = INDEX_DIR,
    embedder: OllamaEmbedder | None = None,
) -> list[dict]:
    embedder = embedder or OllamaEmbedder(OLLAMA_URL, MODEL)
    if not embedder.has_model():
        embedder.pull()
    out = []
    for strategy in chunking.STRATEGIES:
        chunks = read_chunks(corpus_dir, strategy)
        if not chunks:
            raise EmbedError(f"корпус {corpus_dir} пуст — индексировать нечего")
        out.append(build_strategy(strategy, chunks, embedder, index_dir))
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
