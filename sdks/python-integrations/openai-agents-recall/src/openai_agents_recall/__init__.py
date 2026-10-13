"""OpenAI Agents SDK integration for Recall, long-term memory for AI agents.

* ``RecallSession``: a session (conversation history) kept in a Recall session.
* ``recall_tools()``: ``recall_search``, ``recall_ask`` and ``recall_remember`` function tools.
* ``recall_instructions()``: agent instructions plus what Recall knows about the user.

Docs: https://recallmem.dev/docs
"""

from ._version import __version__
from .session import RecallSession
from .tools import recall_instructions, recall_tools

__all__ = ["RecallSession", "__version__", "recall_instructions", "recall_tools"]
