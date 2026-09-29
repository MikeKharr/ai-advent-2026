"""Рукописный JSON-RPC 2.0 и подмножество MCP ревизии 2025-11-25.

Четвёртая копия протокола в проекте и первая на Python. Своя копия в каждой
новой единице — ADR 2026-09-28-0736, п. 3: SDK MCP разрешён только единице
`mcp/`, а карта «единица → пакеты» в шаге «Граница runtime-зависимостей»
(`ci.yml`) даёт `rag/` ровно FAISS и его спутников. SDK потребовал бы правки
этой карты, то есть класса A и вето `compliance` (ADR 2026-09-29-2139,
«Альтернативы рассмотрены»). Дублирование здесь — названная цена границы,
а не недосмотр.

Образец формы — `mcpnews/src/rpc.js`: та же ревизия, тот же `isError` у
отказа инструмента, те же коды. Отличия от него ровно два и оба от языка:
разбор аргументов живёт в самом инструменте (`zod` сюда не приезжает по той
же карте зависимостей), а «уведомление» отличается от запроса отсутствием
ключа `id`, а не `undefined`.
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable

PROTOCOL_VERSION = "2025-11-25"

# Что видит вызывающий, когда инструмент упал не своей ошибкой.
INTERNAL_TOOL_ERROR = "внутренняя ошибка инструмента"


class ToolError(RuntimeError):
    """Отказ, текст которого инструмент назначил сам и показать не жаль."""


# Коды JSON-RPC. -32002 занят отказом лимитера у службы дня 16; здесь отказ
# лимитера отвечает раньше RPC и до сюда не доходит.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602


class Tool:
    """Инструмент: описание для `tools/list` плюс разбор и исполнение.

    `parse` возвращает `(True, значение)` либо `(False, текст отказа)`.
    Отказ разбора — отказ ИНСТРУМЕНТА, а не протокола: модель видит причину
    текстом и зовёт снова.
    """

    def __init__(
        self,
        name: str,
        title: str,
        description: str,
        input_schema: dict,
        parse: Callable[[dict], tuple[bool, Any]],
        run: Callable[[Any], dict],
    ) -> None:
        self.name = name
        self.title = title
        self.description = description
        self.input_schema = input_schema
        self.parse = parse
        self.run = run

    def listed(self) -> dict:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


def rpc_error(id_: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def rpc_result(id_: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def tool_failure(message: str) -> dict:
    """Отказ инструмента: спецификация требует `isError` внутри результата."""
    return {
        "isError": True,
        "content": [{"type": "text", "text": json.dumps({"error": message}, ensure_ascii=False)}],
    }


def tool_ok(payload: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


def count_tool_calls(body: Any) -> int:
    """Сколько вызовов инструментов в этом теле. Пачка считается поштучно.

    Читает лимитер — ДО исполнения. Поэтому считать надо по сырому телу, а не
    по разобранным запросам: разбор идёт уже за лимитером.
    """
    items = body if isinstance(body, list) else [body]
    return sum(1 for item in items if isinstance(item, dict) and item.get("method") == "tools/call")


def first_id(body: Any) -> Any:
    items = body if isinstance(body, list) else [body]
    for item in items:
        if isinstance(item, dict) and "id" in item:
            return item["id"]
    return None


def create_rpc(server_info: dict, tools: list[Tool]):
    """Обработчик одного объекта JSON-RPC.

    Возвращает объект ответа либо `None` — для уведомления (запроса без `id`),
    на которое ответа не бывает.
    """
    by_name = {tool.name: tool for tool in tools}

    def handle_one(message: Any) -> dict | None:
        if not isinstance(message, dict):
            return rpc_error(None, INVALID_REQUEST, "invalid request")
        id_ = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        is_notification = "id" not in message or message["id"] is None
        if not isinstance(method, str):
            return None if is_notification else rpc_error(id_, INVALID_REQUEST, "invalid request")

        # Уведомление: ответа нет ни при каком методе, включая неизвестный.
        if method == "notifications/initialized":
            return None

        if method == "initialize":
            return rpc_result(
                id_,
                {
                    # Ревизию не согласовываем: у службы она одна.
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": server_info,
                },
            )
        if method == "ping":
            return rpc_result(id_, {})
        if method == "tools/list":
            # Порядок фиксирован определением: иначе тест на список ничего
            # не значит.
            return rpc_result(id_, {"tools": [t.listed() for t in tools]})
        if method == "tools/call":
            name = params.get("name") if isinstance(params, dict) else None
            tool = by_name.get(name) if isinstance(name, str) else None
            # Нет такого инструмента — ошибка ЗАПРОСА: имя пришло от клиента,
            # и правит его клиент, а не модель.
            if tool is None:
                return rpc_error(id_, INVALID_PARAMS, f"unknown tool: {str(name)[:64]}")
            arguments = params.get("arguments") if isinstance(params, dict) else None
            ok, value = tool.parse(arguments if isinstance(arguments, dict) else {})
            if not ok:
                return rpc_result(id_, tool_failure(str(value)))
            try:
                return rpc_result(id_, tool_ok(tool.run(value)))
            except ToolError as err:
                # Текст назначен инструментом и предназначен читателю.
                return rpc_result(id_, tool_failure(str(err)))
            except Exception:  # noqa: BLE001 — отказ инструмента, не разрыв протокола
                # Незапланированное наружу не пересказываем — тем же доводом,
                # что и закрытый набор причин у `/healthz` (serve.REASONS):
                # набор строк у `str(err)` неограничен, а в отказе клиента
                # Ollama там стоит `OLLAMA_URL`. Подробность — в журнал
                # контейнера, где её читает владелец.
                traceback.print_exc(file=sys.stderr)
                sys.stderr.flush()
                return rpc_result(id_, tool_failure(INTERNAL_TOOL_ERROR))

        return None if is_notification else rpc_error(id_, METHOD_NOT_FOUND, f"unknown method: {method[:64]}")

    return handle_one
