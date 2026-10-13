"""CrewAI integration for Recall, long-term memory for AI agents.

* ``RecallSearchTool``, ``RecallAskTool``, ``RecallRememberTool`` (or ``recall_tools()``):
  tools that look up and save what Recall knows about a person.
* ``recall_context()``: that knowledge as text, for a task or an agent's backstory.

Docs: https://recallmem.dev/docs
"""

from ._version import __version__
from .tools import (
    RecallAskTool,
    RecallRememberTool,
    RecallSearchTool,
    recall_context,
    recall_tools,
)

__all__ = [
    "RecallAskTool",
    "RecallRememberTool",
    "RecallSearchTool",
    "__version__",
    "recall_context",
    "recall_tools",
]
