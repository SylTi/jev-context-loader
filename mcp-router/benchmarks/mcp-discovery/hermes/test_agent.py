import io
import json
import unittest
from unittest.mock import patch

from agent import make_handler, request_tools


class FixtureContractTest(unittest.TestCase):
    def test_passes_arguments_without_dispatcher_context(self):
        with patch("agent.emit") as send, patch("agent.sys.stdin", io.StringIO('{"receipt":"r1"}\n')):
            result = make_handler("mcp__linear__get_issue")({"id": "ENG-123"}, session_id="runtime-session", task_id="runtime-task")
        send.assert_called_once_with({"event": "call", "name": "mcp__linear__get_issue", "args": {"id": "ENG-123"}})
        self.assertEqual(json.loads(result), {"receipt": "r1"})

    def test_observes_sdk_body_tools_instead_of_empty_typed_slots(self):
        tool = {"type": "function", "function": {"name": "fixture"}}
        self.assertEqual(request_tools({"tools": [], "extra_body": {"tools": [tool]}}), [tool])
        self.assertEqual(request_tools({"tools": [tool]}), [tool])


if __name__ == "__main__":
    unittest.main()
