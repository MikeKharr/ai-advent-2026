"""Клиент локальной Ollama для замеров недели 26–30 (ADR 2026-10-09-1335, п. 1.4).

Куда ходит. Только в экземпляр `ai.local.ollama-localhost` на
`http://127.0.0.1:11435` — тот, который завели ради замеров. Экземпляр сайта
(`ai.zpq.ollama-tailnet`, `11434`) здесь не упоминается ни одной строкой: он
обслуживает посетителей через роутер, и замер его не трогает (ADR, п. 1.1).

Почему `/api/generate` со `stream: true`, а не `/v1/chat/completions`.
Замер меряет время до первого токена, а OpenAI-совместимая ручка длительностей
от движка не отдаёт вовсе — только `usage`, и `completion_tokens` в нём
СЧИТАЕТ ТОКЕНЫ РАССУЖДЕНИЯ вместе с ответом (прогон 2026-10-09, раздел «Две
ловушки OpenAI-совместимого эндпоинта» журнала замеров). Делёж этого числа на
время после первого видимого токена даёт скорость втрое выше настоящей, и это
ровно та ошибка, в которую легко въехать, считая стоимость по `usage`.

Про `num_ctx`: его здесь задаёт КАЖДЫЙ вызов явно. У `qwen3.8:27b` в
`/api/show` окна нет, умолчание Ollama 0.33.3 неизвестно, а при его
превышении вход обрезается молча (ADR, п. 4.2). Второе следствие замера:
`load_duration` вылезал на КАЖДОМ переключении между вызовами с разным
`num_ctx` — Ollama поднимает под другое окно новый экземпляр модели. Поэтому
прогон, который хочет сравнимые времена, держит окно одним на весь блок.

Зависимости — только стандартная библиотека: единица `rag` тянет из pip
ровно `faiss-cpu`, `numpy` и `packaging` (карта шага «Граница runtime-зависимостей»
в `ci.yml`), и ни один замер этот список не расширяет.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request

# Адрес службы замеров. Переменная — чтобы тест поднял подложную Ollama, а не
# чтобы прогон ходил куда-то ещё: умолчание прибито к localhost намеренно.
OLLAMA_URL = os.environ.get("EVAL_OLLAMA_URL", "http://127.0.0.1:11435")

# Та же сборка, что у `mac-qwen3` в проде (`router/config/providers.json`):
# число замера переносится на прод-путь без оговорки о другой модели.
Q4 = "qwen3.8:27b"

# Сборка без отказов — ОДНА ось дня 29 и только числами (ADR, п. 1.3 и 4.3).
# Её тексты не попадают ни в `results.json`, ни на страницу: вето
# `compliance` ADR 2026-10-07-1349 держит их внутри ключевого профиля.
Q6 = "hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Q6_K"

# Шаг выборки пика RSS — 50 мс (ADR, п. 4.4; метод замера памяти — ADR
# 2026-09-30-0957). Реже нельзя: загрузка весов 17 ГБ занимает секунды, и
# выборка раз в секунду прошла бы мимо пика на этом участке.
RSS_SAMPLE_SECONDS = 0.05


def _post(path: str, payload: dict, timeout: float):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{OLLAMA_URL}{path}", data=body, headers={"Content-Type": "application/json"}
    )
    return urllib.request.urlopen(request, timeout=timeout)  # noqa: S310


def ps(timeout: float = 15) -> dict:
    """`/api/ps` — что сейчас в памяти, сколько занимает и с каким окном.

    `context_length` здесь — единственный способ узнать окно, с которым модель
    фактически загружена: в `/api/show` его нет (ADR, п. 4.2).

    Отказ не поднимается исключением: `/api/ps` — наблюдение рядом с замером,
    и упавшее наблюдение не обязано валить прогон. Строка `error` в записи
    видна и в файле результата.
    """
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/ps", timeout=timeout) as response:  # noqa: S310
            data = json.load(response)
    except (OSError, urllib.error.URLError, ValueError) as error:
        return {"error": f"{type(error).__name__}: {error}"}
    return {"models": [_ps_model(item) for item in data.get("models", [])]}


def _ps_model(item: dict) -> dict:
    return {
        "name": item.get("name"),
        "size_bytes": item.get("size"),
        "size_vram_bytes": item.get("size_vram"),
        "context_length": item.get("context_length"),
    }


def peak_model(samples: list[dict], model: str) -> dict | None:
    """Самая тяжёлая запись модели среди выборок `/api/ps`.

    Чистая функция рядом с выборкой: пик — это максимум по `size_vram_bytes`,
    и считать его должен не тот код, который снимает выборки, иначе проверить
    правило нечем.
    """
    best = None
    for sample in samples:
        for item in sample.get("models", []):
            if item.get("name") != model:
                continue
            if best is None or (item.get("size_vram_bytes") or 0) > (best.get("size_vram_bytes") or 0):
                best = item
    return best


def unload(model: str, timeout: float = 120, wait_seconds: float = 60,
           sleep=time.sleep) -> dict:
    """Выгрузить модель из памяти (`keep_alive: 0`) и дождаться пустого `/api/ps`.

    Нужно перед сменой окна контекста и перед сменой сборки: две модели по
    17 и 22 ГБ рядом делят GPU, и замер второй мерил бы тесноту, а не её саму
    (день 29, ось квантования).

    Возвращает `{"unloaded": False, …}`, а не исключение: модель, оставшаяся
    в памяти, — наблюдение прогона, и оно обязано попасть в файл, а не
    оборвать его.
    """
    try:
        with _post("/api/generate", {"model": model, "keep_alive": 0}, timeout) as response:
            response.read()
    except (OSError, urllib.error.URLError) as error:
        return {"unloaded": False, "error": f"{type(error).__name__}: {error}"}
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        sleep(1)
        if not any(item["name"] == model for item in ps().get("models", [])):
            return {"unloaded": True}
    return {"unloaded": False, "note": "модель всё ещё в /api/ps"}


THINK_CLOSE = "</think>"


def strip_think(text: str) -> str:
    """Отрезать рассуждение, вытекшее в видимый ответ, по закрывающей метке.

    ЗАЧЕМ. У сборки без отказов (`Q6`) шаблон чата дописывает `<think>` сам, а
    способность `thinking` она в `/api/tags` не объявляет: Ollama поля
    `thinking` не заполняет, и рассуждение приходит прямо в `response` —
    часто с непарной закрывающей меткой (прогон 2026-10-09,
    `day29_quant.py`, поле `think_leak`). Признаки, посчитанные по такому
    тексту, мерили бы рассуждение, а не ответ.

    Режется ПО ПОСЛЕДНЕЙ закрывающей метке, а не по первой: вложенная или
    повторённая метка иначе оставила бы хвост рассуждения в ответе. Метки
    нет — текст возвращается как есть, и это не ошибка: у `Q4` с
    `think: false` рассуждения не бывает вовсе.
    """
    at = text.rfind(THINK_CLOSE)
    return text if at == -1 else text[at + len(THINK_CLOSE):].lstrip()


def metrics_of(final: dict, ttft: float | None, ttft_answer: float | None,
               wall: float, thinking: str, response: str) -> dict:
    """Метрики одного вызова из последнего чанка потока — чистой функцией.

    Отдельно от сети, потому что именно здесь живёт арифметика, которую легко
    испортить молча: деление на длительность в наносекундах и выбор ИМЕННО
    `eval_duration`, а не настенного времени. Настенное время включает
    загрузку весов и обработку входа; скорость генерации, посчитанная по
    нему, на первом запросе после выгрузки врёт втрое.

    `ttft_ms` — до первого токена ЛЮБОГО вида, `ttft_answer_ms` — до первого
    токена видимого ответа. При включённом рассуждении они расходятся в разы,
    и подменять одно другим нельзя.
    """
    eval_count = final.get("eval_count") or 0
    eval_duration = final.get("eval_duration") or 0
    prompt_count = final.get("prompt_eval_count") or 0
    prompt_duration = final.get("prompt_eval_duration") or 0

    def ms(nanoseconds):
        return None if not nanoseconds else round(nanoseconds / 1e6, 1)

    return {
        "ttft_ms": None if ttft is None else round(ttft * 1000, 1),
        "ttft_answer_ms": None if ttft_answer is None else round(ttft_answer * 1000, 1),
        "wall_ms": round(wall * 1000, 1),
        "prompt_eval_count": prompt_count,
        "prompt_eval_cached_count": final.get("prompt_eval_cached_count"),
        "eval_count": eval_count,
        "thinking_chars": len(thinking),
        "response_chars": len(response),
        "load_duration_ms": ms(final.get("load_duration")),
        "prompt_eval_duration_ms": ms(prompt_duration),
        "eval_duration_ms": ms(eval_duration),
        "total_duration_ms": ms(final.get("total_duration")),
        "gen_tokens_per_s": (
            round(eval_count / (eval_duration / 1e9), 2) if eval_count and eval_duration else None
        ),
        "prompt_tokens_per_s": (
            round(prompt_count / (prompt_duration / 1e9), 2)
            if prompt_count and prompt_duration
            else None
        ),
    }


def generate(model: str, prompt: str, options: dict | None = None,
             think: bool | None = None, system: str | None = None,
             keep_alive: str = "10m", fmt: dict | None = None,
             timeout: float = 1800) -> dict:
    """Один вызов модели потоком. Возвращает текст, рассуждение и метрики.

    `think` передаётся только когда задан: у `Q6` способности `thinking` нет,
    и просить её — значит получить отказ движка вместо ответа.

    Отказ сети и отказ движка не поднимаются исключением, а ложатся в поле
    `error`. Причина записана в ADR, п. 3.5: недоступность или обрыв — это
    результат замера с кодом в файле, а не дефект прогона. Исключение
    обнулило бы уже собранные ответы набора.
    """
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "keep_alive": keep_alive,
        "options": options or {},
    }
    if think is not None:
        payload["think"] = think
    if system is not None:
        payload["system"] = system
    if fmt is not None:
        payload["format"] = fmt

    start = time.perf_counter()
    ttft = None
    ttft_answer = None
    answer: list[str] = []
    thinking: list[str] = []
    final: dict = {}
    error = None
    try:
        with _post("/api/generate", payload, timeout) as response:
            for raw in response:
                if not raw.strip():
                    continue
                chunk = json.loads(raw)
                if chunk.get("error"):
                    error = chunk["error"]
                    break
                thought = chunk.get("thinking") or ""
                visible = chunk.get("response") or ""
                if (thought or visible) and ttft is None:
                    ttft = time.perf_counter() - start
                if visible and ttft_answer is None:
                    ttft_answer = time.perf_counter() - start
                if thought:
                    thinking.append(thought)
                if visible:
                    answer.append(visible)
                if chunk.get("done"):
                    final = chunk
    except (OSError, urllib.error.URLError, ValueError) as caught:
        error = f"{type(caught).__name__}: {caught}"
    wall = time.perf_counter() - start

    text = "".join(answer)
    thought_text = "".join(thinking)
    return {
        "model": model,
        "options": options or {},
        "think": think,
        "error": error,
        "response": text,
        "thinking": thought_text,
        "done_reason": final.get("done_reason"),
        "metrics": metrics_of(final, ttft, ttft_answer, wall, thought_text, text),
    }


# ---------- пик RSS процессов ollama ----------

def is_ollama_process(command: str) -> bool:
    """Относится ли процесс к Ollama — по пути, а не только по имени.

    ЭТО НЕ ПРИДИРКА, А ИСПРАВЛЕНИЕ ЛОЖНОГО ЧИСЛА. Первая редакция ловила
    только процессы с именем `ollama*` и на живой машине давала пик 177 МиБ
    при занятых 18,7 ГБ: веса модели на macOS живут в отдельном процессе
    `llama-server` внутри бандла Ollama
    (`…/Cellar/ollama/<версия>/libexec/lib/ollama/llama-server`, проверено
    `ps` 2026-10-09). То есть пик RSS измерялся бы мимо модели.

    `llama-server` засчитывается ТОЛЬКО когда путь ведёт внутрь Ollama:
    отдельно поставленный `llama-server` чужого стенда к замеру не относится.
    """
    name = command.rsplit("/", 1)[-1]
    if name == "ollama" or name.startswith("ollama-"):
        return True
    return name.startswith("llama-server") and "/ollama/" in command


def ollama_rss(run=subprocess.run) -> dict | None:
    """RSS процессов Ollama в КиБ: сумма и разбивка по процессам.

    Сумма, а не максимум одного процесса: сервер и рунер с весами — разные
    процессы, и память модели живёт во втором. Разбивка пишется в файл рядом
    с суммой, чтобы читатель видел, из чего число сложено: на машине может
    работать вторая служба Ollama, и её сервер попадает в ту же сумму. Это
    названо честно, а не спрятано.

    `/api/ps` этого не заменяет: он говорит, сколько движок ОТВЁЛ модели, а
    `ps` — сколько процессы занимают на деле. ADR 2026-09-30-0957 требует
    обоих, и расхождение между ними — результат, а не ошибка.
    """
    try:
        out = run(["ps", "-Ao", "rss=,comm="], capture_output=True, text=True,
                  timeout=20, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    processes = []
    for line in out.splitlines():
        match = re.match(r"\s*(\d+)\s+(.*)$", line)
        if match and is_ollama_process(match.group(2).strip()):
            processes.append({"name": match.group(2).strip().rsplit("/", 1)[-1],
                              "rss_kib": int(match.group(1))})
    if not processes:
        return None
    return {"total_kib": sum(item["rss_kib"] for item in processes),
            "processes": processes}


class RssPeak:
    """Пик RSS процессов `ollama` за время блока, выборкой каждые 50 мс.

    Контекстный менеджер, а не параметр вызова: пик снимается НА ВРЕМЯ
    ПРОГОНА (ADR, п. 4.4), то есть на блок из нескольких вызовов, и внутри
    одного вызова он смысла не имеет — модель грузится один раз на блок.

    Поток демонический и сам ничего не валит: отказ `ps` даёт `None` в
    выборке, а пустой набор выборок — `peak_kib is None`, то есть «не
    измерено», а не ноль. Выдуманных нулей не бывает (I-8).
    """

    def __init__(self, interval: float = RSS_SAMPLE_SECONDS, sample=ollama_rss) -> None:
        self.interval = interval
        self._sample = sample
        self.samples: list[dict] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            value = self._sample()
            if value is not None:
                self.samples.append(value)
            self._stop.wait(self.interval)

    def __enter__(self) -> "RssPeak":
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @property
    def peak(self) -> dict | None:
        """Выборка с наибольшей суммой — вместе с разбивкой по процессам."""
        return max(self.samples, key=lambda item: item["total_kib"]) if self.samples else None

    @property
    def peak_kib(self) -> int | None:
        top = self.peak
        return None if top is None else top["total_kib"]

    def report(self) -> dict:
        top = self.peak
        return {
            "peak_rss_kib": None if top is None else top["total_kib"],
            "peak_processes": None if top is None else top["processes"],
            "samples": len(self.samples),
            "interval_s": self.interval,
        }
