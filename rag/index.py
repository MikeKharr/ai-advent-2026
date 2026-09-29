"""Точный индекс FAISS `IndexFlatIP` и метаданные рядом.

`IndexFlatIP` — полный перебор из C++: на 3,5 тысячах векторов ANN (IVF,
HNSW) требует обучения и теряет полноту ради скорости, которой некуда
деваться (ADR 2026-09-29-1639, п. 2). Векторы нормируются, поэтому
скалярное произведение и есть косинус.
"""

from __future__ import annotations

import json
from pathlib import Path

import faiss
import numpy as np


def normalize(vectors: np.ndarray) -> np.ndarray:
    vectors = np.ascontiguousarray(vectors, dtype="float32")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    # Нулевой вектор оставляем нулевым, а не делим на ноль: его близость
    # к любому запросу — 0, и это честнее NaN.
    norms[norms == 0] = 1.0
    return vectors / norms


class VectorIndex:
    """Индекс одной стратегии: `<strategy>.faiss` + `<strategy>.meta.json`."""

    def __init__(self, strategy: str, index: faiss.Index, meta: list[dict]) -> None:
        self.strategy = strategy
        self.index = index
        self.meta = meta

    @classmethod
    def build(cls, strategy: str, meta: list[dict], vectors: np.ndarray) -> "VectorIndex":
        # Сверка до normalize, а не после: normalize переписывает vectors, и
        # охранник за ней читал бы уже не то, что пришло (нит reviewer).
        if len(meta) != len(vectors):
            raise ValueError(f"метаданных {len(meta)}, векторов {len(vectors)}")
        vectors = normalize(vectors)
        index = faiss.IndexFlatIP(vectors.shape[1] if len(vectors) else 1)
        if len(vectors):
            index.add(vectors)
        return cls(strategy, index, meta)

    @staticmethod
    def paths(directory: Path, strategy: str) -> tuple[Path, Path]:
        directory = Path(directory)
        return directory / f"{strategy}.faiss", directory / f"{strategy}.meta.json"

    def save(self, directory: Path) -> None:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        vec_path, meta_path = self.paths(directory, self.strategy)
        faiss.write_index(self.index, str(vec_path))
        meta_path.write_text(
            json.dumps({"strategy": self.strategy, "chunks": self.meta}, ensure_ascii=False),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, directory: Path, strategy: str) -> "VectorIndex | None":
        vec_path, meta_path = cls.paths(Path(directory), strategy)
        if not vec_path.is_file() or not meta_path.is_file():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8")).get("chunks", [])
        index = faiss.read_index(str(vec_path))
        if index.ntotal != len(meta):
            # Половина пары пережила другую — считаем, что индекса нет, и
            # строим заново: молча искать по разъехавшимся спискам нельзя.
            return None
        return cls(strategy, index, meta)

    def vectors_by_sha(self) -> dict[str, np.ndarray]:
        """Готовые векторы из тома по `sha256` чанка — вход инкремента."""
        if self.index.ntotal == 0:
            return {}
        stored = self.index.reconstruct_n(0, self.index.ntotal)
        return {m["sha256"]: stored[i] for i, m in enumerate(self.meta)}

    def search(self, query: np.ndarray, k: int) -> list[tuple[float, dict]]:
        if self.index.ntotal == 0:
            return []
        vec = normalize(np.asarray([query], dtype="float32"))
        scores, ids = self.index.search(vec, min(k, self.index.ntotal))
        return [(float(s), self.meta[i]) for s, i in zip(scores[0], ids[0]) if i >= 0]
