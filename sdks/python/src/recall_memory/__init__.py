"""Python SDK for Recall: reasoning memory for AI agents.

Recall speaks the v3 memory REST API. With no ``base_url`` the client talks to Recall's hosted
API (get a key at https://app.recallmem.dev/keys); to use a server you run yourself pass
``base_url="http://localhost:8000"`` or set ``RECALL_URL``::

    from recall_memory import Recall

    recall = Recall(api_key="...", workspace_id="my-app")  # hosted: https://api.recallmem.dev
    alice = recall.peer("alice")
    session = recall.session("chat-1")
    session.add_messages([alice.message("I moved to Utrecht last month.")])
    recall.wait_for_idle()
    print(alice.chat("Where does Alice live?"))
"""

from ._version import __version__
from .client import AsyncRecall, Recall, RecallAio, RecallBase
from .conclusions import (
    ConclusionScope,
    ConclusionScopeAio,
    ConclusionsView,
    ConclusionsViewAio,
    WorkspaceConclusions,
    WorkspaceConclusionsAio,
)
from .context import SessionContext, TurnResult
from .errors import (
    APIError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    RecallConnectionError,
    RecallError,
    RecallTimeoutError,
    ServerError,
    UnprocessableEntityError,
)
from .errors import (
    ConnectionError as ConnectionError,  # short name; kept out of __all__ so `import *` can't shadow the builtin
)
from .errors import (
    TimeoutError as TimeoutError,  # short name; kept out of __all__ so `import *` can't shadow the builtin
)
from .models import (
    BilledChat,
    BilledLearning,
    BilledQuestions,
    ChatResponse,
    Conclusion,
    ConclusionCreateParams,
    ConclusionResponse,
    DialecticConfiguration,
    DreamConfiguration,
    Evidence,
    EvidenceMessageRef,
    EvidenceObservation,
    EvidenceToolCall,
    Message,
    MessageConfiguration,
    MessageCreateParams,
    MessageResponse,
    PeerCardConfiguration,
    PeerConfig,
    PeerContextResponse,
    PeerResponse,
    QueueStatusResponse,
    ReasoningConfiguration,
    ScopeBackfillJob,
    ScopeResponse,
    ScopeStatusResponse,
    SessionConfiguration,
    SessionPeerConfig,
    SessionQueueStatus,
    SessionResponse,
    SessionSummaries,
    Summary,
    SummaryConfiguration,
    Usage,
    UsageBilled,
    UsageItem,
    UsageTotals,
    WebhookEndpoint,
    WorkspaceConfiguration,
    WorkspaceResponse,
)
from .pagination import AsyncPage, Page, SyncPage
from .peer import Peer, PeerAio, PeerBase
from .scope import Scope, ScopeAio, ScopeBase
from .session import Session, SessionAio, SessionBase
from .streaming import AsyncDialecticStreamResponse, DialecticStreamResponse
from .webhooks import (
    WebhookEvent,
    Webhooks,
    WebhooksAio,
    construct_webhook_event,
    verify_webhook_signature,
)

__all__ = [
    "APIError",
    "AsyncDialecticStreamResponse",
    "AsyncPage",
    "AsyncRecall",
    "AuthenticationError",
    "BadRequestError",
    "BilledChat",
    "BilledLearning",
    "BilledQuestions",
    "ChatResponse",
    "Conclusion",
    "ConclusionCreateParams",
    "ConclusionResponse",
    "ConclusionScope",
    "ConclusionScopeAio",
    "ConclusionsView",
    "ConclusionsViewAio",
    "ConflictError",
    "DialecticConfiguration",
    "DialecticStreamResponse",
    "DreamConfiguration",
    "Evidence",
    "EvidenceMessageRef",
    "EvidenceObservation",
    "EvidenceToolCall",
    "Message",
    "MessageConfiguration",
    "MessageCreateParams",
    "MessageResponse",
    "NotFoundError",
    "Page",
    "Recall",
    "RecallAio",
    "RecallBase",
    "RecallConnectionError",
    "RecallError",
    "RecallTimeoutError",
    "Peer",
    "PeerAio",
    "PeerBase",
    "PeerCardConfiguration",
    "PeerConfig",
    "PeerContextResponse",
    "PeerResponse",
    "PermissionDeniedError",
    "QueueStatusResponse",
    "RateLimitError",
    "ReasoningConfiguration",
    "Scope",
    "ScopeAio",
    "ScopeBackfillJob",
    "ScopeBase",
    "ScopeResponse",
    "ScopeStatusResponse",
    "ServerError",
    "Session",
    "SessionAio",
    "SessionBase",
    "SessionConfiguration",
    "SessionContext",
    "SessionPeerConfig",
    "SessionQueueStatus",
    "SessionResponse",
    "SessionSummaries",
    "Summary",
    "SummaryConfiguration",
    "SyncPage",
    "TurnResult",
    "UnprocessableEntityError",
    "Usage",
    "UsageBilled",
    "UsageItem",
    "UsageTotals",
    "WebhookEndpoint",
    "WebhookEvent",
    "Webhooks",
    "WebhooksAio",
    "WorkspaceConclusions",
    "WorkspaceConclusionsAio",
    "WorkspaceConfiguration",
    "WorkspaceResponse",
    "__version__",
    "construct_webhook_event",
    "verify_webhook_signature",
]
