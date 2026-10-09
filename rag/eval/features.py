"""Четыре признака дня 22, посчитанные на Python (ADR 2026-10-09-1335, п. 3.3).

ЭТО ВТОРАЯ КОПИЯ МЕХАНИКИ `days/day22/eval/score.mjs`, и это названо ценой в
«Последствиях» ADR. Первая копия на JS считает признаки у ответов облачных
моделей через публичный API дня, вторая — здесь, у ответов локальной модели,
потому что сданный день 22 не правится, а индекс FAISS читается только из
Python.

Что держит копии вместе, а не комментарий: тесты
`rag/test/test_eval_local.py` — `НормализацияСверки` прогоняет одни и те же
пары текстов и ждёт того же ответа, что даёт `flatten` в `score.mjs`, а
`ФразаОтказаОдна` берёт фразу отказа из `agents/src/rag-agent.js` регуляркой
и сверяет с константой ниже. Разъедутся — краснеет прогон единицы `rag`.

Граница между механикой и судьёй здесь та же, что в дне 22: вердикт 0/1/2
ставит отдельный экземпляр роли `reviewer` по рубрике, и подставить его
отсюда нечем — `verdict` в записи признаков всегда `None`.
"""

from __future__ import annotations

import statistics
import unicodedata

# Рубрика судьи — дословно из `days/day22/eval/score.mjs`, `RUBRIC`.
RUBRIC = "0 — неверно или выдумано; 1 — частично; 2 — верно и по источнику"

# Фраза отказа строгого промпта — дословно из `agents/src/rag-agent.js`,
# `REFUSAL`. Равенство держит тест, а не это замечание.
REFUSAL = "В найденных фрагментах ответа нет"

# Слова колонки «Качество» страницы дня 28 — по вердикту судьи. Балл на
# странице не показывается: по десяти вопросам балл даёт ложную точность
# (спецификация раскладки, «День 28», п. 3).
QUALITY_WORDS = {2: "совпало", 1: "частично", 0: "не совпало"}


def flatten(text) -> str:
    """Нормализация сверки по фразе — та же, что `flatten` в `score.mjs`.

    NFC, пробельные последовательности в один пробел, обрезка по краям,
    нижний регистр. И НИЧЕГО БОЛЬШЕ: ни замены «ё» на «е», ни выкидывания
    знаков. Каждое такое послабление делает `key: true` дешевле, то есть
    признак слабее, и заметить это по экрану уже нельзя.
    """
    if text is None:
        return ""
    return " ".join(unicodedata.normalize("NFC", str(text)).split()).lower()


def retrieved_of(sources: list[str], expected: list[str]) -> bool:
    """Верный источник среди найденных. Сравнение путей — точное, не по подстроке."""
    found = set(sources)
    return any(path in found for path in expected)


def cited_of(answer: str, expected: list[str]) -> bool:
    """Путь верного источника назван в ответе — подстрокой после нормализации.

    Что это ловит сверх попадания: `cited: true` у ответа, который назвал путь
    и соврал про его содержимое. Поэтому признак и стоит рядом с вердиктом
    судьи, а не вместо него.
    """
    flat = flatten(answer)
    return any(flatten(path) in flat for path in expected)


def is_refusal(answer: str) -> bool:
    """Сказала ли модель фразу отказа строгого промпта.

    Ловит форму, а не смысл: отказ своими словами признаком не станет, а
    пересказ фразы внутри содержательного ответа — станет. Смысл различает
    судья, и это разделение намеренное (то же, что у `isRefusal` дня 22).
    """
    return flatten(REFUSAL) in flatten(answer)


def features_for(question: dict, answer: str, sources: list[str]) -> dict:
    """Один ответ локальной модели → запись признаков для файла результата.

    `question` — запись набора `days/day22/eval/questions.json`: `sources`
    (верные пути) и `key` (ключевая фраза; у общих вопросов `None`).

    Где признака НЕТ — там `None`, а не `False`: у общего вопроса верного
    источника не бывает вовсе, и `cited: false` читалось бы как «не назвал
    верный путь», то есть как упрёк за несуществующее требование.
    """
    expected = list(question.get("sources") or [])
    has_source = len(expected) > 0
    key = question.get("key")
    return {
        "retrieved": retrieved_of(sources, expected) if has_source else None,
        "cited": cited_of(answer, expected) if has_source else None,
        "key": None if key is None else flatten(key) in flatten(answer),
        "refused": is_refusal(answer),
        # Вердикт ставит судья. Прогон его не знает и знать не может.
        "verdict": None,
    }


def quality_word(verdict) -> str | None:
    """Вердикт 0/1/2 → слово колонки «Качество». Вне рубрики — `None`.

    `None` на входе и `None` на выходе значат «судья ещё не смотрел», и
    страница печатает это строкой, а не прочерком.
    """
    return QUALITY_WORDS.get(verdict) if isinstance(verdict, int) else None


def median_or_none(values) -> float | None:
    """Медиана по непустым числам, иначе `None`.

    Медиана, а не среднее: один холодный запуск с загрузкой весов сдвигает
    среднее и о модели не говорит ничего (спецификация раскладки, «День 26»).
    `None` вместо нуля — потому что ноль здесь был бы выдуманным числом (I-8).
    """
    numbers = [value for value in values if isinstance(value, (int, float))]
    return round(statistics.median(numbers), 3) if numbers else None
