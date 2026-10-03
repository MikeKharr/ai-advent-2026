"""Прогон меры сравнения: обе стратегии по одному набору вопросов.

Запуск — заход 5 ADR 2026-09-29-1639, после первой полной сборки на VPS.
Здесь только код прогона; чисел без Ollama получить нельзя.
"""

from __future__ import annotations

import argparse
import datetime
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import metrics  # noqa: E402
from build import MODEL, OLLAMA_URL, INDEX_DIR  # noqa: E402
from embed import OllamaEmbedder  # noqa: E402
from index import VectorIndex  # noqa: E402

QUERIES = Path(__file__).resolve().parent / "queries.json"


STRATEGIES = ("fixed", "structural")

# Подпись и описание стратегии для страницы итогов. Источник истины о самих
# правилах нарезки — rag/chunking.py; здесь только то, как их назвать человеку.
STRATEGY_INFO = {
    "fixed": ("По размеру",
              "Окна 1500 знаков с перекрытием 200; заголовки не учитываются намеренно."),
    "structural": ("По структуре",
                   "Разделы по заголовкам, цепочка заголовков в тексте; код — файл или куски по пустым строкам."),
}


def chunk_summary(meta: list[dict]) -> dict:
    """Статистика нарезки из метаданных индекса — тем же правилом, что сборка.

    Длина — `len(text)`, как в `build.chunk_stats`, иначе страница и журнал
    сборки показывали бы разную медиану одного и того же индекса.
    """
    lengths = [len(m["text"]) for m in meta]
    return {
        "chunks": len(meta),
        "len_median": int(statistics.median(lengths)) if lengths else 0,
        "len_max": max(lengths) if lengths else 0,
    }

# Выдержка найденного чанка в разборе по вопросу. Длина — для чтения
# человеком на странице итогов, а не для оценки: метрики считаются по полному
# тексту чанка.
EXCERPT = 240


def detail_for(query: dict, hits: list[tuple[float, dict]], top: int = 3) -> dict:
    """Разбор одного вопроса по одной стратегии — то, что покажет страница.

    `rank` — место первого чанка из ожидаемого документа (1…k) или `None`,
    если в первых k его нет. Это тот же ранг, из которого MRR@10 берёт
    обратную величину, поэтому сводная метрика и разбор не могут разойтись.
    """
    sources = [meta["source"] for _, meta in hits]
    rank = next((i + 1 for i, s in enumerate(sources) if s in query["expected"]), None)
    phrase = query.get("phrase")
    return {
        "rank": rank,
        "phrase_in_first": (
            metrics.phrase_in_first([meta["text"] for _, meta in hits], phrase) if phrase else None
        ),
        "top": [
            {
                "source": meta["source"],
                "section": meta.get("section", ""),
                "score": round(score, 4),
                "excerpt": " ".join(meta["text"].split())[:EXCERPT],
            }
            for score, meta in hits[:top]
        ],
    }


def run(index_dir: Path, queries_path: Path, embedder: OllamaEmbedder,
        k: int = metrics.MRR_K, detail: bool = False) -> dict:
    queries = metrics.load_queries(queries_path)
    vectors = embedder.embed([q["question"] for q in queries])
    out = {}
    sources: set[str] = set()
    commits: set[str] = set()
    # answer/evidence/evidence_source — эталонный ответ и дословная цитата из
    # верного документа, которая его подтверждает. Мера их не считает: они для
    # страницы итогов, чтобы читатель видел, что именно искал поиск.
    per_query = {q["id"]: {"id": q["id"], "question": q["question"], "expected": q["expected"],
                           "phrase": q.get("phrase"), "answer": q.get("answer"),
                           "evidence": q.get("evidence"),
                           "evidence_source": q.get("evidence_source")} for q in queries}
    for strategy in STRATEGIES:
        index = VectorIndex.load(index_dir, strategy, embedder.model)
        if index is None:
            out[strategy] = {"error": f"индекса {strategy} нет в {index_dir}"}
            continue
        hits_all = [index.search(v, k) for v in vectors]
        results = [(q, [meta for _, meta in hits]) for q, hits in zip(queries, hits_all)]
        out[strategy] = metrics.score(results)
        if detail:
            label, about = STRATEGY_INFO[strategy]
            out[strategy] = {"label": label, "about": about,
                             **chunk_summary(index.meta), **out[strategy]}
            sources.update(m["source"] for m in index.meta)
            commits.update(m.get("commit", "") for m in index.meta)
            for q, hits in zip(queries, hits_all):
                per_query[q["id"]][strategy] = detail_for(q, hits)
    if detail:
        out["queries"] = list(per_query.values())
        # Шапка прогона. Коммит берётся из метаданных индекса, а не из дерева:
        # мера описывает тот индекс, по которому искала. Разные коммиты у
        # стратегий — не ошибка прогона, но страница обязана это показать.
        out = {
            "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "commit": ",".join(sorted(c[:7] for c in commits if c)) or "unknown",
            "model": embedder.model,
            "corpus": {"files": len(sources)},
            **out,
        }
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Сравнение стратегий по queries.json")
    parser.add_argument("--index", default=str(INDEX_DIR))
    parser.add_argument("--queries", default=str(QUERIES))
    parser.add_argument("--detail", action="store_true",
                        help="добавить разбор по каждому вопросу: ранг, что найдено первым, выдержку")
    args = parser.parse_args(argv)
    report = run(Path(args.index), Path(args.queries), OllamaEmbedder(OLLAMA_URL, MODEL),
                 detail=args.detail)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
