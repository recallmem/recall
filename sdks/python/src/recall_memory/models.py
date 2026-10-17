"""Typed request/response models.

Response models accept (and keep) unknown fields so a newer server never breaks an older SDK.
Request-side configuration models have every field optional; unset fields are omitted from the
wire so the server's inheritance rules (message -> session -> workspace -> server) apply.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "BilledChat",
    "BilledLearning",
    "BilledQuestions",
    "ChatResponse",
    "Conclusion",
    "ConclusionCreateParams",
    "ConclusionResponse",
    "DialecticConfiguration",
    "DreamConfiguration",
    "Evidence",
    "EvidenceMessageRef",
    "EvidenceObservation",
    "EvidenceToolCall",
    "Message",
    "MessageConfiguration",
    "MessageCreateParams",
    "MessageResponse",
    "PeerCardConfiguration",
    "PeerConfig",
    "PeerContextResponse",
    "PeerResponse",
    "QueueStatusResponse",
    "ReasoningConfiguration",
    "ReasoningLevel",
    "ScopeBackfillJob",
    "ScopeResponse",
    "ScopeStatusResponse",
    "SessionConfiguration",
    "SessionPeerConfig",
    "SessionQueueStatus",
    "SessionResponse",
    "SessionSummaries",
    "Summary",
    "SummaryConfiguration",
    "Usage",
    "UsageBilled",
    "UsageItem",
    "UsageTotals",
    "WebhookEndpoint",
    "WorkspaceConfiguration",
    "WorkspaceResponse",
]

ReasoningLevel = Literal["minimal", "low", "medium", "high", "max"]
ConclusionLevel = Literal["explicit", "deductive", "inductive", "contradiction"]

T = TypeVar("T")


class _Base(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


# --------------------------------------------------------------------------------------
# Configuration (request bodies; all optional)
# --------------------------------------------------------------------------------------


class ReasoningConfiguration(_Base):
    enabled: bool | None = None
    custom_instructions: str | None = None


class PeerCardConfiguration(_Base):
    use: bool | None = None
    create: bool | None = None
    custom_instructions: str | None = None


class SummaryConfiguration(_Base):
    enabled: bool | None = None
    messages_per_short_summary: int | None = None
    messages_per_long_summary: int | None = None
    custom_instructions: str | None = None


class DreamConfiguration(_Base):
    enabled: bool | None = None
    custom_instructions: str | None = None


class DialecticConfiguration(_Base):
    custom_instructions: str | None = None


class SessionConfiguration(_Base):
    """Workspace and session configuration share one shape."""

    custom_instructions: str | None = None
    reasoning: ReasoningConfiguration | None = None
    peer_card: PeerCardConfiguration | None = None
    summary: SummaryConfiguration | None = None
    dream: DreamConfiguration | None = None
    dialectic: DialecticConfiguration | None = None


WorkspaceConfiguration = SessionConfiguration


class PeerConfig(_Base):
    """``observe_me=False`` opts a peer out of being modelled."""

    observe_me: bool | None = None


class SessionPeerConfig(_Base):
    observe_me: bool | None = None
    observe_others: bool | None = None


class MessageConfiguration(_Base):
    reasoning: ReasoningConfiguration | None = None


# --------------------------------------------------------------------------------------
# Resource responses
# --------------------------------------------------------------------------------------


class WorkspaceResponse(_Base):
    id: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    configuration: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class PeerResponse(_Base):
    id: str
    workspace_id: str | None = None
    created_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    configuration: dict[str, Any] = Field(default_factory=dict)


class SessionResponse(_Base):
    id: str
    is_active: bool = True
    workspace_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    configuration: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class MessageResponse(_Base):
    id: str
    content: str
    peer_id: str
    session_id: str
    workspace_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None
    token_count: int = 0


class Message(MessageResponse):
    """A stored message."""

    @classmethod
    def from_api_response(cls, response: MessageResponse | dict[str, Any]) -> Message:
        if isinstance(response, MessageResponse):
            return cls.model_validate(response.model_dump())
        return cls.model_validate(response)


class ScopeResponse(_Base):
    id: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime | None = None


class ScopeBackfillJob(_Base):
    state: Literal["pending", "completed", "failed"] | str
    updated_at: str | None = None
    docs_copied: int | None = None


class ScopeStatusResponse(_Base):
    backfill_status: dict[str, ScopeBackfillJob] = Field(default_factory=dict)


class ConclusionResponse(_Base):
    id: str
    content: str
    observer_id: str
    observed_id: str
    session_id: str | None = None
    level: ConclusionLevel | str = "explicit"
    source_ids: list[str] | None = None
    """Premise conclusions of a derived fact (empty for explicit ones)."""
    times_derived: int = 1
    created_at: datetime | None = None
    valid_from: datetime | None = None
    """When the fact started to hold: the time of the message it was learned from."""
    valid_to: datetime | None = None
    """When it stopped holding; ``None`` while it is current."""
    superseded_by: str | None = None
    """The id of the conclusion that replaced it, if one did."""
    message_ids: list[str] = Field(default_factory=list)
    """Ids of the messages it was learned from (empty for facts saved directly)."""
    event_start: str | None = None
    """When what the fact describes happened or began, as precise as it is known:
    ``2025-05-27``, ``2025-05`` or ``2025``. ``None`` when it has no time of its own."""
    event_end: str | None = None
    """The last day of a span (``2025-06-01``), or ``None``."""
    event_precision: Literal["day", "month", "year"] | str | None = None
    """How precise ``event_start`` is."""
    tags: list[str] = Field(default_factory=list)
    """What the fact is about: kinds of things and named entities, lowercase and singular."""
    pinned: bool = False
    """Set by a person: the reasoner and dreams never replace it; what disagrees is flagged."""
    expires_at: datetime | None = None
    """When the fact stops holding, if it has an end date."""


class Conclusion(ConclusionResponse):
    """A derived (or hand-written) fact: ``observer`` believes ``content`` about ``observed``."""


class ConclusionCreateParams(_Base):
    content: str
    session_id: str | None = None
    event_start: str | None = None
    """When it happened or began: ``YYYY``, ``YYYY-MM`` or ``YYYY-MM-DD``."""
    event_end: str | None = None
    """The last day of a span, in the same forms."""
    tags: list[str] | None = None
    pinned: bool | None = None
    expires_at: str | None = None
    """When the fact stops holding (ISO 8601)."""


class WebhookEndpoint(_Base):
    id: str
    workspace_id: str | None = None
    url: str
    created_at: datetime | None = None


# --------------------------------------------------------------------------------------
# Summaries and context
# --------------------------------------------------------------------------------------


class Summary(_Base):
    content: str
    message_id: str
    summary_type: str
    created_at: str
    token_count: int


class SessionSummaries(_Base):
    id: str
    short_summary: Summary | None = None
    long_summary: Summary | None = None

    @property
    def session_id(self) -> str:
        return self.id


class PeerContextResponse(_Base):
    peer_id: str
    target_id: str
    representation: str | None = None
    peer_card: list[str] | None = None


# --------------------------------------------------------------------------------------
# Chat
# --------------------------------------------------------------------------------------


class EvidenceObservation(_Base):
    id: str
    level: str
    content: str
    created_at: datetime | None = None
    session_id: str | None = None
    observer_id: str | None = None
    observed_id: str | None = None
    source_ids: list[str] = Field(default_factory=list)


class EvidenceMessageRef(_Base):
    id: str
    session_id: str
    peer_id: str
    created_at: datetime | None = None


class EvidenceToolCall(_Base):
    tool_name: str
    tool_input: dict[str, Any] = Field(default_factory=dict)


class Evidence(_Base):
    conclusions: list[EvidenceObservation] = Field(default_factory=list)
    messages: list[EvidenceMessageRef] = Field(default_factory=list)
    tool_calls: list[EvidenceToolCall] = Field(default_factory=list)
    reasoning_trace_id: str | None = None


class ChatResponse(_Base, Generic[T]):
    """Chat answer plus evidence. ``content`` is parsed when a Pydantic ``response_format`` was given.

    Recall servers also return ``citations`` (ids of the conclusions the answer rests on),
    ``confidence`` (0 to 1) and ``abstained`` (the memory had no grounded answer). They are
    ``None`` / empty against servers that do not send them.
    """

    content: T | None = None
    evidence: Evidence | None = None
    citations: list[str] = Field(default_factory=list)
    confidence: float | None = None
    abstained: bool | None = None


# --------------------------------------------------------------------------------------
# Queue, usage, turn
# --------------------------------------------------------------------------------------


class SessionQueueStatus(_Base):
    session_id: str | None = None
    total_work_units: int = 0
    completed_work_units: int = 0
    in_progress_work_units: int = 0
    pending_work_units: int = 0


class QueueStatusResponse(_Base):
    total_work_units: int = 0
    completed_work_units: int = 0
    in_progress_work_units: int = 0
    pending_work_units: int = 0
    sessions: dict[str, SessionQueueStatus] | None = None
    #: Recall extension, only present when the request used ``wait_ms``: whether the wait ended
    #: because the scope is idle (``True``) or because the wait ran out (``False``).
    idle: bool | None = None

    @property
    def is_idle(self) -> bool:
        """True when nothing is queued or running (according to these counts)."""
        return self.pending_work_units == 0 and self.in_progress_work_units == 0


class UsageTotals(_Base):
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    #: Provider cost in USD, on a server of your own. ``None`` on the hosted service, which does not
    #: report its provider cost: what you pay is in :attr:`Usage.billed`.
    cost_usd: float | None = None
    #: Calls to models with no known price (excluded from ``cost_usd``); ``None`` where it is.
    unpriced_calls: int | None = None


class UsageItem(UsageTotals):
    task: str
    #: ``None`` on the hosted service, which names its models by codename.
    provider: str | None = None
    model: str


class BilledQuestions(_Base):
    """Questions answered and what they were charged."""

    questions: int = 0
    billed_usd: float = 0.0


class BilledLearning(_Base):
    """Message tokens learned (each message counts as at least 50) and their charge."""

    message_tokens: int = 0
    billed_usd: float = 0.0


class BilledStorage(_Base):
    """Tokens stored without learning (messages no reasoning call reads, facts you add) and their charge."""

    tokens: int = 0
    billed_usd: float = 0.0


class BilledChat(BilledQuestions):
    """Questions answered, in all and per reasoning level."""

    by_level: dict[ReasoningLevel, BilledQuestions] = Field(default_factory=dict)


class UsageBilled(_Base):
    """What an account on prepaid credit (the hosted service) was charged, with the billable units."""

    #: Learning, storage and chat together, in USD. Charges given back are left out.
    billed_usd: float = 0.0
    learning: BilledLearning = Field(default_factory=BilledLearning)
    storage: BilledStorage = Field(default_factory=BilledStorage)
    chat: BilledChat = Field(default_factory=BilledChat)


class Usage(_Base):
    """Model calls and tokens of a workspace, in total, by task and by model.

    On a server of your own ``cost_usd`` is the provider cost. On the hosted service ``cost_usd`` is
    ``None`` and ``billed`` is what the workspace was charged.
    """

    workspace_id: str | None = None
    since: str | None = None
    until: str | None = None
    total: UsageTotals = Field(default_factory=UsageTotals)
    by_task: dict[str, UsageTotals] = Field(default_factory=dict)
    items: list[UsageItem] = Field(default_factory=list)
    billed: UsageBilled | None = None


# --------------------------------------------------------------------------------------
# Message construction
# --------------------------------------------------------------------------------------


class MessageCreateParams(_Base):
    """One message to add to a session. Plain dicts with the same keys are accepted everywhere."""

    content: str
    peer_id: str
    metadata: dict[str, Any] | None = None
    configuration: MessageConfiguration | dict[str, Any] | None = None
    created_at: datetime | str | None = None

    def __getitem__(self, key: str) -> Any:
        try:
            return getattr(self, key)
        except AttributeError:
            raise KeyError(key) from None

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)
