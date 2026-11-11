"""Typed contracts for the qualification agent.

The agent can only *propose* one of five typed actions. Every model is `extra="forbid"`, so output that adds
fields, invents action types, or changes the schema fails validation and creates nothing.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

ACTION_TYPES = (
    "create_opportunity",
    "add_deadline_reminders",
    "assign_reviewer",
    "draft_clarification_question",
    "mark_no_bid",
)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CreateOpportunity(_Strict):
    note: str = Field(default="", max_length=500)


class AddDeadlineReminders(_Strict):
    days_before: list[Annotated[int, Field(ge=1, le=90)]] = Field(min_length=1, max_length=6)

    @field_validator("days_before")
    @classmethod
    def _unique_sorted(cls, v: list[int]) -> list[int]:
        return sorted(set(v), reverse=True)


class AssignReviewer(_Strict):
    user_id: uuid.UUID


class DraftClarificationQuestion(_Strict):
    question: str = Field(min_length=10, max_length=1000)


class MarkNoBid(_Strict):
    reason: str = Field(min_length=3, max_length=500)


PAYLOAD_MODELS: dict[str, type[_Strict]] = {
    "create_opportunity": CreateOpportunity,
    "add_deadline_reminders": AddDeadlineReminders,
    "assign_reviewer": AssignReviewer,
    "draft_clarification_question": DraftClarificationQuestion,
    "mark_no_bid": MarkNoBid,
}


def validate_payload(action_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate (and normalise) a payload for an action type. Raises pydantic.ValidationError / KeyError."""
    model = PAYLOAD_MODELS[action_type]
    return model.model_validate(payload).model_dump(mode="json")


class ProposedAction(_Strict):
    type: Literal[
        "create_opportunity",
        "add_deadline_reminders",
        "assign_reviewer",
        "draft_clarification_question",
        "mark_no_bid",
    ]
    payload: dict[str, Any] = Field(default_factory=dict)
    rationale: str = Field(default="", max_length=600)

    def model_post_init(self, __context: Any) -> None:
        # Validate the payload against the typed tool schema for this action.
        validate_payload(self.type, self.payload)


class QualificationOutput(_Strict):
    fit_score: int = Field(ge=0, le=100)
    reasons: list[Annotated[str, Field(max_length=400)]] = Field(max_length=8)
    risks: list[Annotated[str, Field(max_length=400)]] = Field(max_length=8)
    proposed_actions: list[ProposedAction] = Field(max_length=5)


OUTPUT_ADAPTER = TypeAdapter(QualificationOutput)
OUTPUT_JSON_SCHEMA: dict[str, Any] = QualificationOutput.model_json_schema()
