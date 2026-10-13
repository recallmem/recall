"""LangChain and LangGraph integration for Recall, long-term memory for AI agents.

* ``RecallMiddleware``: memory for ``create_agent`` agents (needs ``langchain``:
  ``pip install "langchain-recall[agents]"``; it is imported on first use).
* ``RecallToolkit`` (``RecallSearchTool``, ``RecallAskTool``, ``RecallRememberTool``): tools.
* ``RecallRetriever``: facts Recall learned about a person, and their messages, as documents.
* ``RecallChatMessageHistory``: a chat history kept in a Recall session.

Docs: https://recallmem.dev/docs
"""

from typing import TYPE_CHECKING, Any

from ._version import __version__
from .chat_history import RecallChatMessageHistory
from .retrievers import RecallRetriever
from .tools import RecallAskTool, RecallRememberTool, RecallSearchTool, RecallToolkit

if TYPE_CHECKING:
    from .middleware import RecallMiddleware as RecallMiddleware

__all__ = [
    "RecallAskTool",
    "RecallChatMessageHistory",
    "RecallRememberTool",
    "RecallRetriever",
    "RecallSearchTool",
    "RecallToolkit",
    "__version__",
]


def __getattr__(name: str) -> Any:
    # RecallMiddleware needs the `langchain` package, which the rest does not: import it lazily.
    if name == "RecallMiddleware":
        from .middleware import RecallMiddleware

        return RecallMiddleware
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
