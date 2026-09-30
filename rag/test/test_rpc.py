"""JSON-RPC 2.0 и подмножество MCP — форма ответов и границы разбора.

Образец проверок — `mcpnews/test/rpc.test.js`: та же ревизия протокола, те же
коды, тот же `isError`. Здесь дополнительно держится то, чего в той единице
нет: незапланированное исключение инструмента не пересказывается наружу.
"""

import io
import json
import sys
import unittest

import rpc


def make(tools=None):
    return rpc.create_rpc({"name": "rag", "version": "0"}, tools or [])


def echo_tool(**over):
    kwargs = {
        "name": "t.echo",
        "title": "Эхо",
        "description": "возвращает аргумент",
        "input_schema": {"type": "object", "properties": {"x": {"type": "string"}}},
        "parse": lambda args: (True, args.get("x", "")) if "x" in args else (False, "нужен x"),
        "run": lambda value: {"x": value},
    }
    kwargs.update(over)
    return rpc.Tool(**kwargs)


def payload(answer: dict) -> dict:
    """Распаковать `content[0].text` результата инструмента."""
    return json.loads(answer["result"]["content"][0]["text"])


class ProtocolTest(unittest.TestCase):
    def test_initialize_отдаёт_одну_ревизию_и_не_согласовывает_её(self):
        answer = make()({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
        self.assertEqual(answer["result"]["protocolVersion"], rpc.PROTOCOL_VERSION)
        self.assertEqual(answer["id"], 1)

    def test_ping_отвечает_пустым_результатом(self):
        self.assertEqual(make()({"jsonrpc": "2.0", "id": "p", "method": "ping"}), {"jsonrpc": "2.0", "id": "p", "result": {}})

    def test_список_инструментов_в_порядке_определения(self):
        handle = make([echo_tool(name="b.one"), echo_tool(name="a.two")])
        names = [t["name"] for t in handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]]
        self.assertEqual(names, ["b.one", "a.two"])

    def test_уведомление_ответа_не_даёт_ни_при_каком_методе(self):
        handle = make()
        self.assertIsNone(handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertIsNone(handle({"jsonrpc": "2.0", "method": "нет-такого-метода"}))

    def test_неизвестный_метод_запроса_это_ошибка_протокола(self):
        answer = make()({"jsonrpc": "2.0", "id": 7, "method": "нет-такого"})
        self.assertEqual(answer["error"]["code"], rpc.METHOD_NOT_FOUND)

    def test_не_объект_это_негодный_запрос(self):
        self.assertEqual(make()(["не объект"])["error"]["code"], rpc.INVALID_REQUEST)
        self.assertEqual(make()(None)["error"]["code"], rpc.INVALID_REQUEST)


class ToolCallTest(unittest.TestCase):
    def test_неизвестный_инструмент_это_ошибка_запроса_а_не_инструмента(self):
        answer = make([echo_tool()])({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "нет"}})
        self.assertEqual(answer["error"]["code"], rpc.INVALID_PARAMS)
        self.assertNotIn("result", answer)

    def test_имя_инструмента_в_ответе_обрезано(self):
        long = "щ" * 500
        answer = make([echo_tool()])({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": long}})
        self.assertLessEqual(len(answer["error"]["message"]), len("unknown tool: ") + 64)

    def test_негодный_аргумент_это_отказ_инструмента_а_не_разрыв_протокола(self):
        answer = make([echo_tool()])({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "t.echo", "arguments": {}}})
        self.assertNotIn("error", answer)
        self.assertTrue(answer["result"]["isError"])
        self.assertEqual(payload(answer)["error"], "нужен x")

    def test_удачный_вызов_несёт_результат_текстом(self):
        answer = make([echo_tool()])(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "t.echo", "arguments": {"x": "да"}}}
        )
        self.assertEqual(payload(answer), {"x": "да"})
        self.assertNotIn("isError", answer["result"])

    def test_свой_отказ_инструмента_доходит_до_вызывающего_текстом(self):
        def boom(_value):
            raise rpc.ToolError("индекс ещё не собран")

        answer = make([echo_tool(run=boom)])(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "t.echo", "arguments": {"x": "y"}}}
        )
        self.assertEqual(payload(answer)["error"], "индекс ещё не собран")

    def test_чужое_исключение_наружу_не_пересказывается(self):
        # Тем же доводом, что закрытый набор причин у /healthz: набор строк у
        # `str(err)` неограничен, а в отказе клиента Ollama там стоит адрес
        # службы. Подробность обязана уйти в журнал, а не в ответ.
        def boom(_value):
            raise RuntimeError("/api/embed: нет связи с http://ollama:11434")

        stderr, sys.stderr = sys.stderr, io.StringIO()
        try:
            answer = make([echo_tool(run=boom)])(
                {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "t.echo", "arguments": {"x": "y"}}}
            )
            journal = sys.stderr.getvalue()
        finally:
            sys.stderr = stderr
        raw = json.dumps(answer, ensure_ascii=False)
        self.assertNotIn("ollama", raw)
        self.assertNotIn("11434", raw)
        self.assertEqual(payload(answer)["error"], rpc.INTERNAL_TOOL_ERROR)
        # И не теряется: иначе владельцу нечем было бы разобраться.
        self.assertIn("11434", journal)


class BodyCountTest(unittest.TestCase):
    """Чем считает лимитер — он читает сырое тело, до разбора."""

    def test_одиночный_вызов_считается_за_один(self):
        self.assertEqual(rpc.count_tool_calls({"method": "tools/call"}), 1)

    def test_пачка_считается_поштучно_и_не_по_длине(self):
        batch = [{"method": "tools/call"}, {"method": "tools/list"}, {"method": "tools/call"}]
        self.assertEqual(rpc.count_tool_calls(batch), 2)

    def test_тело_без_вызовов_не_занимает_слотов(self):
        self.assertEqual(rpc.count_tool_calls({"method": "initialize"}), 0)
        self.assertEqual(rpc.count_tool_calls(["мусор", 5, None]), 0)

    def test_первый_id_берётся_для_ответа_на_отказ_лимитера(self):
        self.assertEqual(rpc.first_id([{"method": "x"}, {"id": 9, "method": "tools/call"}]), 9)
        self.assertIsNone(rpc.first_id({"method": "tools/call"}))


if __name__ == "__main__":
    unittest.main()
