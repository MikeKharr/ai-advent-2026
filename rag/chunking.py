"""Две стратегии нарезки, обе с одинаковым набором метаданных.

ADR 2026-09-29-1352, п. 3. Разница между стратегиями — ровно в двух местах:
где проходит граница и что уходит в эмбеддинг. Метаданные одни и те же,
чтобы сравнение считалось одной мерой (`metrics.py`).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

WINDOW = 1500
OVERLAP = 200
SECTION_LIMIT = 3000
# Насколько далеко назад от края окна ищется конец абзаца или строки.
LOOKBACK = WINDOW // 3

HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$")
MD_SUFFIXES = (".md",)


@dataclass
class Chunk:
    source: str
    title: str
    section: str
    chunk_id: str
    strategy: str
    text: str
    sha256: str = ""
    commit: str = ""
    # Что уходит в эмбеддинг: у структурной стратегии — с цепочкой заголовков.
    embed_text: str = field(default="")

    def as_meta(self) -> dict:
        return {
            "source": self.source,
            "title": self.title,
            "section": self.section,
            "chunk_id": self.chunk_id,
            "strategy": self.strategy,
            "sha256": self.sha256,
            "commit": self.commit,
            "text": self.text,
        }


def sha256_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def doc_title(source: str, text: str) -> str:
    """H1 документа, иначе имя файла."""
    if source.endswith(MD_SUFFIXES):
        for line in text.splitlines():
            m = HEADING.match(line)
            if m and len(m.group(1)) == 1:
                return m.group(2).strip()
    return source.rsplit("/", 1)[-1]


def _finish(chunks: list[Chunk], commit: str) -> list[Chunk]:
    for chunk in chunks:
        chunk.commit = commit
        if not chunk.embed_text:
            chunk.embed_text = chunk.text
        chunk.sha256 = sha256_of(f"{chunk.strategy}\n{chunk.embed_text}")
    return chunks


def _boundary(text: str, start: int, end: int) -> int:
    """Ближайший назад конец абзаца, иначе конец строки, иначе край окна."""
    floor = max(start + 1, end - LOOKBACK)
    para = text.rfind("\n\n", floor, end)
    if para != -1:
        return para + 2
    line = text.rfind("\n", floor, end)
    if line != -1:
        return line + 1
    return end


def chunk_fixed(source: str, text: str, commit: str = "") -> list[Chunk]:
    """Окно 1500 знаков, перекрытие 200, граница — конец абзаца или строки.

    Заголовки не учитываются намеренно (ADR 2026-09-29-1352, п. 3): ни при
    выборе границы, ни в поле `section`, ни в тексте для эмбеддинга. Пустой
    `section` здесь — не пробел, а то, что эта стратегия про документ знает.
    """
    title = doc_title(source, text)
    chunks: list[Chunk] = []
    start, n = 0, len(text)
    while start < n:
        end = min(start + WINDOW, n)
        if end < n:
            end = _boundary(text, start, end)
        body = text[start:end].strip()
        if body:
            chunks.append(
                Chunk(
                    source=source,
                    title=title,
                    section="",
                    chunk_id=f"{source}#{len(chunks)}",
                    strategy="fixed",
                    text=body,
                )
            )
        if end >= n:
            break
        start = max(end - OVERLAP, start + 1)
    return _finish(chunks, commit)


def _split_paragraphs(body: str, limit: int) -> list[str]:
    """Набор абзацев до `limit` знаков; абзац длиннее лимита уходит целиком."""
    parts: list[str] = []
    buf = ""
    for para in re.split(r"\n{2,}", body):
        para = para.strip()
        if not para:
            continue
        if buf and len(buf) + 2 + len(para) > limit:
            parts.append(buf)
            buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
    if buf:
        parts.append(buf)
    return parts


def _split_top_level(body: str, limit: int) -> list[str]:
    """Код: по пустым строкам верхнего уровня (следующая строка без отступа)."""
    lines = body.splitlines()
    blocks: list[list[str]] = [[]]
    for i, line in enumerate(lines):
        if not line.strip():
            nxt = next((l for l in lines[i + 1 :] if l.strip()), None)
            if blocks[-1] and nxt is not None and not nxt[:1].isspace():
                blocks.append([])
                continue
        blocks[-1].append(line)
    texts = ["\n".join(b).strip() for b in blocks]
    return _join_blocks([t for t in texts if t], limit)


def _join_blocks(blocks: list[str], limit: int) -> list[str]:
    out: list[str] = []
    buf = ""
    for block in blocks:
        if buf and len(buf) + 2 + len(block) > limit:
            out.append(buf)
            buf = block
        else:
            buf = f"{buf}\n\n{block}" if buf else block
    if buf:
        out.append(buf)
    return out


def _hard_split(body: str, limit: int) -> list[str]:
    """Последний рубеж структурной стратегии: кусок, который не разошёлся ни
    по абзацам, ни по пустым строкам верхнего уровня, дорезается по строкам.

    Такое бывает: сплющенный JSON — один блок на 70 КБ. Без этого чанк ушёл
    бы в эмбеддер целиком, а тот молча обрезал бы его по своему контексту,
    и сравнение стратегий меряло бы обрезку, а не нарезку.
    """
    if not body:
        return []
    if len(body) <= limit:
        return [body]
    parts, buf = [], ""
    for line in body.splitlines(keepends=True):
        while len(line) > limit:
            if buf:
                parts.append(buf)
                buf = ""
            parts.append(line[:limit])
            line = line[limit:]
        if buf and len(buf) + len(line) > limit:
            parts.append(buf)
            buf = ""
        buf += line
    if buf:
        parts.append(buf)
    return [p.strip() for p in parts if p.strip()]


def _markdown_sections(text: str) -> list[tuple[str, str]]:
    """Пары (цепочка заголовков, тело) по заголовкам markdown."""
    chain: list[str] = []
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            level = len(m.group(1))
            chain = chain[: level - 1] + [m.group(2).strip()]
            sections.append((" › ".join(chain), []))
            continue
        sections[-1][1].append(line)
    return [(name, "\n".join(body).strip()) for name, body in sections]


def chunk_structural(source: str, text: str, commit: str = "") -> list[Chunk]:
    """Markdown — по заголовкам, код — файлом или по пустым строкам верхнего уровня.

    Чанк несёт цепочку заголовков в тексте, который уходит в эмбеддинг.
    """
    title = doc_title(source, text)
    chunks: list[Chunk] = []

    def add(section: str, body: str) -> None:
        for part in _hard_split(body.strip(), SECTION_LIMIT):
            _append(section, part)

    def _append(section: str, body: str) -> None:
        head = f"{title} › {section}" if section else title
        chunks.append(
            Chunk(
                source=source,
                title=title,
                section=section,
                chunk_id=f"{source}#{len(chunks)}",
                strategy="structural",
                text=body,
                embed_text=f"{head}\n\n{body}",
            )
        )

    if source.endswith(MD_SUFFIXES):
        for section, body in _markdown_sections(text):
            if len(body) <= SECTION_LIMIT:
                add(section, body)
            else:
                for part in _split_paragraphs(body, SECTION_LIMIT):
                    add(section, part)
    else:
        section = source.rsplit("/", 1)[-1]
        if len(text.strip()) <= SECTION_LIMIT:
            add(section, text)
        else:
            for part in _split_top_level(text, SECTION_LIMIT):
                add(section, part)
    return _finish(chunks, commit)


STRATEGIES = {"fixed": chunk_fixed, "structural": chunk_structural}

LIST_ITEM = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S")


def cuts_block(chunk: Chunk, next_chunk: Chunk | None) -> bool:
    """Чанк режет блок кода или список пополам.

    Блок кода: нечётное число оград ``` — открыли и не закрыли (или наоборот).
    Список: чанк оборвался на пункте, а следующий чанк того же файла
    начинается с пункта — значит перечисление разъехалось по двум чанкам.
    """
    if chunk.text.count("```") % 2 == 1:
        return True
    if next_chunk is None or next_chunk.source != chunk.source:
        return False
    tail = [l for l in chunk.text.splitlines() if l.strip()]
    head = [l for l in next_chunk.text.splitlines() if l.strip()]
    return bool(tail and head and LIST_ITEM.match(tail[-1]) and LIST_ITEM.match(head[0]))
