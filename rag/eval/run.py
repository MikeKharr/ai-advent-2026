"""Прогон меры сравнения: обе стратегии по одному набору вопросов.

Запуск — заход 5 ADR 2026-09-29-1639, после первой полной сборки на VPS.
Здесь только код прогона; чисел без Ollama получить нельзя.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import metrics  # noqa: E402
from build import MODEL, OLLAMA_URL, INDEX_DIR  # noqa: E402
from embed import OllamaEmbedder  # noqa: E402
from index import VectorIndex  # noqa: E402

QUERIES = Path(__file__).resolve().parent / "queries.json"


def run(index_dir: Path, queries_path: Path, embedder: OllamaEmbedder, k: int = metrics.MRR_K) -> dict:
    queries = metrics.load_queries(queries_path)
    vectors = embedder.embed([q["question"] for q in queries])
    out = {}
    for strategy in ("fixed", "structural"):
        index = VectorIndex.load(index_dir, strategy)
        if index is None:
            out[strategy] = {"error": f"индекса {strategy} нет в {index_dir}"}
            continue
        results = [(q, [meta for _, meta in index.search(v, k)]) for q, v in zip(queries, vectors)]
        out[strategy] = metrics.score(results)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Сравнение стратегий по queries.json")
    parser.add_argument("--index", default=str(INDEX_DIR))
    parser.add_argument("--queries", default=str(QUERIES))
    args = parser.parse_args(argv)
    report = run(Path(args.index), Path(args.queries), OllamaEmbedder(OLLAMA_URL, MODEL))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
