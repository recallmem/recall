"""Tests for the Recall memory provider for Hermes Agent.

Settings tests run anywhere. The rest need a Recall server: set RECALL_TEST_URL
(Recall's own test suite starts one and runs this file).
When Hermes Agent is importable (run with its Python), the provider is also
loaded through Hermes' own plugin loader and driven by its MemoryManager.

    RECALL_TEST_URL=http://127.0.0.1:8000 python3 integrations/hermes/tests/test_recall_provider.py -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROVIDER_DIR = HERE.parent / "recall"
SERVER = os.environ.get("RECALL_TEST_URL", "").rstrip("/")

try:
    import agent.memory_manager  # noqa: F401  (Hermes Agent)

    HAS_HERMES = True
except ImportError:
    HAS_HERMES = False


def load_module():
    spec = importlib.util.spec_from_file_location("recall_hermes_provider", PROVIDER_DIR / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


recall = load_module()


def api(method, path, body=None):
    req = urllib.request.Request(
        SERVER + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def messages(workspace, session):
    try:
        return api("POST", f"/v3/workspaces/{workspace}/sessions/{session}/messages/list", {})["items"]
    except Exception:  # noqa: BLE001
        return []


def closed_url():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"http://127.0.0.1:{port}"


class TempHome(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="recall-hermes-"))
        self.hermes_home = self.home / ".hermes"
        self.hermes_home.mkdir()

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def env(self, **extra):
        base = {"HOME": str(self.home), "HERMES_HOME": str(self.hermes_home)}
        base.update(extra)
        return base


class SettingsTest(TempHome):
    def test_environment_then_hermes_config_then_shared_config(self):
        (self.home / ".recall").mkdir()
        (self.home / ".recall" / "config.json").write_text(
            json.dumps(
                {
                    "url": "http://shared:1",
                    "apiKey": "${SHARED_KEY}",
                    "workspace": "shared",
                    "peer": "shared-peer",
                    "hosts": {"hermes": {"workspace": "hermes-ws"}},
                }
            )
        )
        s = recall.load_settings(str(self.hermes_home), self.env(SHARED_KEY="k1"))
        self.assertEqual(s["url"], "http://shared:1")
        self.assertEqual(s["api_key"], "k1")
        self.assertEqual(s["workspace"], "hermes-ws")
        self.assertEqual(s["peer"], "shared-peer")
        self.assertEqual(s["assistant_peer"], "hermes")

        (self.hermes_home / "recall.json").write_text(json.dumps({"peer": "own peer", "lookup": "off"}))
        s = recall.load_settings(str(self.hermes_home), self.env(RECALL_URL="http://env:2/"))
        self.assertEqual(s["url"], "http://env:2")
        self.assertEqual(s["peer"], "own-peer")
        self.assertEqual(s["lookup"], "off")

    def test_defaults_and_save_config(self):
        s = recall.load_settings(str(self.hermes_home), self.env(USER="ana"))
        self.assertEqual(s["url"], "https://api.recallmem.dev")
        self.assertEqual(s["workspace"], "default")
        self.assertEqual(s["session_strategy"], "per-session")
        self.assertTrue(s["record"])

        provider = recall.RecallMemoryProvider(env=self.env())
        provider.save_config({"url": "http://saved:3", "workspace": "w1", "peer": ""}, str(self.hermes_home))
        provider.save_config({"peer": "ana"}, str(self.hermes_home))
        saved = json.loads((self.hermes_home / "recall.json").read_text())
        self.assertEqual(saved, {"url": "http://saved:3", "workspace": "w1", "peer": "ana"})
        provider.initialize("s1", hermes_home=str(self.hermes_home), platform="cli")
        self.assertEqual(provider.settings["url"], "http://saved:3")
        self.assertTrue(provider.is_available())
        keys = [f["key"] for f in provider.get_config_schema()]
        self.assertEqual(keys, ["url", "api_key", "workspace", "peer"])
        self.assertEqual(provider.get_config_schema()[1]["env_var"], "RECALL_API_KEY")

    def test_tool_schemas_are_openai_functions(self):
        names = []
        for schema in recall.RecallMemoryProvider().get_tool_schemas():
            self.assertEqual(set(schema), {"name", "description", "parameters"})
            self.assertEqual(schema["parameters"]["type"], "object")
            names.append(schema["name"])
        self.assertEqual(names, ["recall_search", "recall_ask", "recall_remember", "recall_forget"])


@unittest.skipUnless(SERVER, "set RECALL_TEST_URL to a Recall server")
class ProviderTest(TempHome):
    def make(self, **settings):
        self.workspace = f"hm{uuid.uuid4().hex[:8]}"
        config = {"url": SERVER, "workspace": self.workspace, "peer": "lucas"}
        config.update(settings)
        (self.hermes_home / "recall.json").write_text(json.dumps(config))
        provider = recall.RecallMemoryProvider(env=self.env())
        return provider

    def tool(self, provider, name, **args):
        return json.loads(provider.handle_tool_call(name, args))

    def test_recall_tools_and_prefetch(self):
        p = self.make()
        p.initialize("s1", hermes_home=str(self.hermes_home), platform="cli")
        self.assertEqual(p.prefetch("anything"), "")
        # Nothing stored yet: the unknown workspace answers 404, which is no answer, not an error.
        self.assertEqual(self.tool(p, "recall_ask", question="What does Lucas drink?"), {"answer": "Memory has no answer to that."})
        saved = self.tool(p, "recall_remember", facts=["Lucas drinks oat flat whites", " "])
        self.assertEqual([f["content"] for f in saved["saved"]], ["Lucas drinks oat flat whites"])
        fact_id = saved["saved"][0]["id"]

        context = p.prefetch("coffee")
        self.assertIn('about the user ("lucas")', context)
        self.assertIn("Lucas drinks oat flat whites", context)
        self.assertNotIn("<memory-context>", context)  # Hermes adds the fence itself

        found = self.tool(p, "recall_search", query="flat white")
        self.assertIn(fact_id, [f["id"] for f in found["facts"]])
        self.assertTrue(self.tool(p, "recall_ask", question="What does Lucas drink?")["answer"])
        self.assertEqual(self.tool(p, "recall_forget", id=fact_id), {"deleted": fact_id})
        self.assertIn("error", self.tool(p, "recall_forget", id=fact_id))
        self.assertIn("error", self.tool(p, "recall_search", query=""))

        off = self.make(lookup="off")
        off.initialize("s1", hermes_home=str(self.hermes_home))
        self.assertEqual(off.prefetch("coffee"), "")

    def test_records_turns_in_order_once_with_the_assistant_unobserved(self):
        p = self.make()
        p.initialize("20261009_1", hermes_home=str(self.hermes_home), platform="telegram")
        p.sync_turn("I moved to Utrecht", "Welcome to Utrecht!")
        p.sync_turn("I moved to Utrecht", "Welcome to Utrecht!")  # same turn again
        p.sync_turn("Book a table for two", "Done: 19:30 at De Rechtbank.")
        self.assertTrue(p.flush(10))
        stored = messages(self.workspace, "hermes-20261009_1")
        self.assertEqual(
            [(m["peer_id"], m["content"]) for m in stored],
            [
                ("lucas", "I moved to Utrecht"),
                ("hermes", "Welcome to Utrecht!"),
                ("lucas", "Book a table for two"),
                ("hermes", "Done: 19:30 at De Rechtbank."),
            ],
        )
        self.assertEqual(stored[0]["metadata"], {"source": "hermes", "platform": "telegram"})
        config = api("GET", f"/v3/workspaces/{self.workspace}/sessions/hermes-20261009_1/peers/hermes/config")
        self.assertFalse(config["observe_me"])

        # After /new the next turn goes to the new session.
        p.on_session_switch("20261009_2", reset=True)
        p.sync_turn("Second session", "Noted.")
        p.on_session_end([])
        self.assertEqual(len(messages(self.workspace, "hermes-20261009_2")), 2)
        p.shutdown()

    def test_mirrors_user_facts_and_skips_non_primary_contexts(self):
        p = self.make()
        p.initialize("s2", hermes_home=str(self.hermes_home), platform="cli")
        p.on_memory_write("add", "user", "Lucas has a dog named Bo")
        p.on_memory_write("add", "memory", "The repo uses pnpm")
        p.on_memory_write("remove", "user", "Lucas has a cat")
        self.assertTrue(p.flush(10))
        found = self.tool(p, "recall_search", query="dog")
        self.assertEqual([f["content"] for f in found["facts"]], ["Lucas has a dog named Bo"])

        cron = self.make()
        cron.initialize("s3", hermes_home=str(self.hermes_home), agent_context="cron")
        cron.sync_turn("cron prompt", "cron output")
        cron.on_memory_write("add", "user", "should not be saved")
        self.assertTrue(cron.flush(5))
        self.assertEqual(messages(self.workspace, "hermes-s3"), [])

    def test_session_strategies_and_gateway_users(self):
        p = self.make(session_strategy="per-chat", peer_from_user=True)
        p.initialize(
            "s4",
            hermes_home=str(self.hermes_home),
            platform="telegram",
            user_id="12345",
            gateway_session_key="agent:main:telegram:dm:12345",
        )
        p.sync_turn("Hi, I am Sam", "Hi Sam!")
        self.assertTrue(p.flush(10))
        stored = messages(self.workspace, "hermes-chat-agent-main-telegram-dm-12345")
        self.assertEqual([m["peer_id"] for m in stored], ["telegram-12345", "hermes"])

    def test_survives_an_outage_and_delivers_in_order_afterwards(self):
        p = self.make(url=closed_url(), timeout=1)
        p.initialize("s5", hermes_home=str(self.hermes_home))
        started = time.monotonic()
        self.assertEqual(p.prefetch("hello"), "")
        p.sync_turn("first", "1")
        self.assertFalse(p.flush(5))  # kept, not lost
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("error", self.tool(p, "recall_search", query="x"))

        p.settings["url"] = SERVER
        p._client = None
        p._breaker_until = 0
        p.sync_turn("second", "2")
        self.assertTrue(p.flush(10))
        self.assertEqual([m["content"] for m in messages(self.workspace, "hermes-s5")], ["first", "1", "second", "2"])
        p.shutdown()


@unittest.skipUnless(SERVER and HAS_HERMES, "needs RECALL_TEST_URL and Hermes Agent installed")
class HermesRuntimeTest(TempHome):
    def test_loaded_and_driven_by_hermes(self):
        from agent.memory_manager import MemoryManager
        from agent.memory_provider import MemoryProvider

        workspace = f"hm{uuid.uuid4().hex[:8]}"
        os.environ["HERMES_HOME"] = str(self.hermes_home)
        shutil.copytree(PROVIDER_DIR, self.hermes_home / "plugins" / "recall")
        (self.hermes_home / "recall.json").write_text(
            json.dumps({"url": SERVER, "workspace": workspace, "peer": "lucas"})
        )
        from plugins.memory import discover_memory_providers, load_memory_provider

        self.assertIn("recall", [name for name, _desc, available in discover_memory_providers() if available])
        provider = load_memory_provider("recall")
        self.assertIsInstance(provider, MemoryProvider)

        manager = MemoryManager()
        manager.add_provider(provider)
        manager.initialize_all(session_id="hermes-run", platform="cli")
        self.assertEqual(
            sorted(manager.get_all_tool_names()),
            ["recall_ask", "recall_forget", "recall_remember", "recall_search"],
        )
        saved = json.loads(manager.handle_tool_call("recall_remember", {"facts": ["Lucas lives in Utrecht"]}))
        self.assertEqual(len(saved["saved"]), 1)
        self.assertIn("Lucas lives in Utrecht", manager.prefetch_all("where do I live?"))
        manager.sync_all("I moved to Utrecht", "Welcome!")
        manager.on_memory_write("add", "user", "Lucas has a dog named Bo")
        manager.shutdown_all()
        self.assertEqual(
            [m["content"] for m in messages(workspace, "hermes-hermes-run")],
            ["I moved to Utrecht", "Welcome!"],
        )


if __name__ == "__main__":
    unittest.main()
