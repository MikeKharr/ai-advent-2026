"""Механические проверки верности ответов дня 26 — то, что не отдают судье.

Правило ADR 2026-10-09-1335, п. 2: «оценка верности — механическая, где она
возможна (факт, тест функции, валидность JSON по схеме), иначе — судья».
Механическая проверка здесь не вспомогательная, а главная: вердикт, который
можно посчитать, не должен зависеть от модели-судьи.

Перенос из `…-measurements/scripts/verify_quant.py` и `rle_test.js`
(прогон 2026-10-09). Ни одна проверка не смотрит на `thinking`: рассуждение
отрезается `ollama_client.strip_think` до вызова, иначе проверка на подстроку
находила бы верный ответ в рассуждении у модели, которая в итоге ответила
неверно.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path

RUNNER = Path(__file__).resolve().parent / "rle_test.js"


def strip_fences(text: str) -> str:
    """Снять обрамление ```…``` вокруг кода. Модель его ставит, хотя просят не ставить."""
    out = re.sub(r"^\s*```[a-zA-Z]*\s*", "", text.strip())
    return re.sub(r"\s*```\s*$", "", out).strip()


def contains(answer: str, expected: str) -> dict:
    """Эталон есть в ответе подстрокой, без учёта регистра и переносов.

    Самая слабая из проверок, и слабость названа: она ловит присутствие
    верного числа, а не верность рассуждения. Поэтому у задач, где есть что
    запустить или что разобрать, стоит не она.
    """
    flat = " ".join(answer.split()).lower()
    want = " ".join(expected.split()).lower()
    return {"kind": "подстрока", "ok": want in flat, "expected": expected}


def validate(value, schema: dict, problems: list[str], path: str = "$") -> None:
    """Проверка значения по подмножеству JSON Schema, которое задаёт прогон.

    Подмножество, а не полная реализация: в схеме дня 26 есть `type`,
    `required`, `properties`, `items`, `minItems`, `maxItems` — и ничего
    больше. Полный валидатор означал бы зависимость из pip, а карта
    «Граница runtime-зависимостей» в `ci.yml` единице `rag` её не даёт.

    Лишнее поле считается НАРУШЕНИЕМ: схема дня 26 закрытая, и ответ с
    придуманным полем прошёл бы как верный, если бы лишнее прощалось.
    """
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            problems.append(f"{path}: ожидался object")
            return
        for required in schema.get("required", []):
            if required not in value:
                problems.append(f"{path}: нет обязательного поля {required}")
        for key, item in value.items():
            if key in schema.get("properties", {}):
                validate(item, schema["properties"][key], problems, f"{path}.{key}")
            else:
                problems.append(f"{path}: лишнее поле {key}")
    elif kind == "array":
        if not isinstance(value, list):
            problems.append(f"{path}: ожидался array")
            return
        if "minItems" in schema and len(value) < schema["minItems"]:
            problems.append(f"{path}: элементов {len(value)} < minItems {schema['minItems']}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            problems.append(f"{path}: элементов {len(value)} > maxItems {schema['maxItems']}")
        for at, item in enumerate(value):
            validate(item, schema["items"], problems, f"{path}[{at}]")
    elif kind == "string":
        if not isinstance(value, str):
            problems.append(f"{path}: ожидался string, получен {type(value).__name__}")
    elif kind == "integer":
        # `bool` — подкласс `int` в Python, и `true` прошло бы за целое.
        if not isinstance(value, int) or isinstance(value, bool):
            problems.append(f"{path}: ожидался integer, получен {type(value).__name__}")


def by_schema(answer: str, schema: dict) -> dict:
    """Ответ разбирается как JSON и проходит схему."""
    try:
        value = json.loads(strip_fences(answer))
    except ValueError as error:
        return {"kind": "схема", "ok": False, "problems": [f"не разбирается как JSON: {error}"]}
    problems: list[str] = []
    validate(value, schema, problems)
    return {"kind": "схема", "ok": not problems, "problems": problems}


def by_running_js(answer: str, run=subprocess.run) -> dict:
    """Функция из ответа запускается в Node против восьми наборов.

    ЧТО ЗДЕСЬ ОПАСНО И ПОЧЕМУ ЭТО ВСЁ РАВНО ТАК. `rle_test.js` исполняет код,
    который написала модель, без песочницы. Это осознанный выбор замера, а не
    упущение: проверить функцию иначе, чем запуском, нечем, а ответ приходит
    от модели на той же машине и никуда не публикуется. Прогон идёт руками
    владельца на ноутбуке и НЕ ЗАПУСКАЕТСЯ НИ ОДНИМ ШАГОМ CI — тесты единицы
    зовут `by_running_js` только с подложным `run`.
    """
    code = strip_fences(answer)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "candidate.js"
        path.write_text(code, encoding="utf-8")
        try:
            done = run(["node", str(RUNNER), str(path)], capture_output=True,
                       text=True, timeout=60, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            return {"kind": "запуск", "ok": False, "problems": [f"node не запустился: {error}"]}
    try:
        got = json.loads(done.stdout)
    except ValueError:
        return {"kind": "запуск", "ok": False,
                "problems": [(done.stderr or done.stdout)[:400]]}
    return {
        "kind": "запуск",
        "ok": got["passed"] == got["total"],
        "passed": got["passed"],
        "total": got["total"],
        "cases": got.get("cases", []),
    }


def verdict_of(check: dict | None) -> str | None:
    """Проверка → слово вердикта страницы. Нет проверки — нет вердикта.

    `None` значит «считает судья», а не «неверно»: страница печатает это
    строкой, и выдуманного «неверно» на ней не появляется (I-8).
    """
    if check is None:
        return None
    if check.get("ok"):
        return "верно"
    # «Частично» ставит только судья: механика различает прошло и не прошло, и
    # вводить третью градацию ей нечем.
    return "неверно"
