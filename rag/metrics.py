"""Мера сравнения стратегий (ADR 2026-09-29-1352, п. 4).

Ничего не «проходит» и не «проваливается»: считаются числа, разница видна
по ним. Граница меры названа там же и повторена в `rag/README.md`: 30
вопросов пишет один человек этого проекта.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

RECALL_K = 5
MRR_K = 10


def load_queries(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["queries"]


def _norm(text: str) -> str:
    """Сравнение фраз без оглядки на перенос строки и вид пробела."""
    text = unicodedata.normalize("NFC", text).replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip().lower()


def recall_at_k(sources: list[str], expected: list[str], k: int = RECALL_K) -> float:
    """Доля ожидаемых документов, попавших в первые k чанков."""
    if not expected:
        return 0.0
    top = set(sources[:k])
    return len([e for e in expected if e in top]) / len(expected)


def reciprocal_rank(sources: list[str], expected: list[str], k: int = MRR_K) -> float:
    want = set(expected)
    for i, src in enumerate(sources[:k], start=1):
        if src in want:
            return 1.0 / i
    return 0.0


def phrase_in_first(texts: list[str], phrase: str) -> bool:
    return bool(texts) and _norm(phrase) in _norm(texts[0])


def score(results: list[tuple[dict, list[dict]]]) -> dict:
    """results: пары (вопрос, найденные чанки по убыванию оценки)."""
    recalls, rrs = [], []
    phrase_total = phrase_hit = 0
    for query, hits in results:
        sources = [h["source"] for h in hits]
        recalls.append(recall_at_k(sources, query["expected"]))
        rrs.append(reciprocal_rank(sources, query["expected"]))
        if query.get("phrase"):
            phrase_total += 1
            phrase_hit += phrase_in_first([h["text"] for h in hits], query["phrase"])
    n = len(results) or 1
    return {
        "queries": len(results),
        f"recall@{RECALL_K}": round(sum(recalls) / n, 4),
        f"mrr@{MRR_K}": round(sum(rrs) / n, 4),
        "phrase_queries": phrase_total,
        "phrase_in_first_chunk": round(phrase_hit / phrase_total, 4) if phrase_total else None,
    }
