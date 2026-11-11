"""LLM providers behind one interface, plus a deterministic fake for tests and keyless local runs.

Wire formats: Groq uses the OpenAI-compatible chat completions API; Gemini uses generateContent;
Ollama uses /api/chat. These are exercised in tests only through mocked HTTP transports (no live calls,
no keys); see SETUP.md for how to enable the real ones.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from tenderline.config import Settings


class ProviderError(Exception):
    """Transport / API failure: the router should try the next provider."""


@dataclass(frozen=True)
class LlmResult:
    text: str
    input_tokens: int
    output_tokens: int
    provider: str
    model: str
    latency_ms: int


class LlmProvider(Protocol):
    name: str
    model: str

    def complete(self, system: str, user: str) -> LlmResult: ...


def _timed(fn: Any) -> tuple[Any, int]:
    start = time.monotonic()
    out = fn()
    return out, int((time.monotonic() - start) * 1000)


class OpenAICompatProvider:
    """Any OpenAI-compatible /chat/completions endpoint. Used for Groq."""

    def __init__(
        self,
        name: str,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float,
        transport: httpx.BaseTransport | None = None,
    ):
        self.name, self.model = name, model
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def complete(self, system: str, user: str) -> LlmResult:
        def call() -> httpx.Response:
            return self._http.post(
                "/chat/completions",
                json={
                    "model": self.model,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                    "response_format": {"type": "json_object"},
                    "temperature": 0,
                },
            )

        try:
            resp, ms = _timed(call)
            resp.raise_for_status()
            data = resp.json()
            usage = data.get("usage") or {}
            return LlmResult(
                data["choices"][0]["message"]["content"],
                int(usage.get("prompt_tokens", 0)),
                int(usage.get("completion_tokens", 0)),
                self.name,
                self.model,
                ms,
            )
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
            raise ProviderError(f"{self.name}: {type(exc).__name__}: {exc}") from exc


class GeminiProvider:
    def __init__(self, api_key: str, model: str, timeout: float, transport: httpx.BaseTransport | None = None):
        self.name, self.model = "gemini", model
        self._http = httpx.Client(
            base_url="https://generativelanguage.googleapis.com",
            timeout=timeout,
            transport=transport,
            headers={"x-goog-api-key": api_key},
        )

    def complete(self, system: str, user: str) -> LlmResult:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
        }
        try:
            resp, ms = _timed(lambda: self._http.post(f"/v1beta/models/{self.model}:generateContent", json=body))
            resp.raise_for_status()
            data = resp.json()
            usage = data.get("usageMetadata") or {}
            text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
            return LlmResult(
                text,
                int(usage.get("promptTokenCount", 0)),
                int(usage.get("candidatesTokenCount", 0)),
                self.name,
                self.model,
                ms,
            )
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
            raise ProviderError(f"gemini: {type(exc).__name__}: {exc}") from exc


class OllamaProvider:
    def __init__(self, base_url: str, model: str, timeout: float, transport: httpx.BaseTransport | None = None):
        self.name, self.model = "ollama", model
        self._http = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)

    def complete(self, system: str, user: str) -> LlmResult:
        body = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        try:
            resp, ms = _timed(lambda: self._http.post("/api/chat", json=body))
            resp.raise_for_status()
            data = resp.json()
            return LlmResult(
                data["message"]["content"],
                int(data.get("prompt_eval_count", 0)),
                int(data.get("eval_count", 0)),
                self.name,
                self.model,
                ms,
            )
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            raise ProviderError(f"ollama: {type(exc).__name__}: {exc}") from exc


_WORD = re.compile(r"[a-z0-9]{4,}")


def _days_left(deadline_at: str | None) -> float | None:
    if not deadline_at:
        return None
    from datetime import UTC, datetime

    try:
        dt = datetime.fromisoformat(deadline_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt - datetime.now(UTC)).total_seconds() / 86400


def _words(text: str) -> set[str]:
    return set(_WORD.findall(text.casefold()))


class FakeProvider:
    """Deterministic, offline. Scores fit from structured overlap only and ignores any instructions that
    appear inside the notice text, so tests can prove that embedded text cannot steer behaviour."""

    name, model = "fake", "fake-deterministic-1"

    def complete(self, system: str, user: str) -> LlmResult:
        start = time.monotonic()
        data = extract_input(user)
        notice, org = data["notice"], data["organisation"]
        score = 20
        reasons: list[str] = []
        risks: list[str] = []
        caps = {c.casefold() for c in org.get("capabilities", [])}
        hay = _words(f"{notice.get('title', '')} {notice.get('summary') or ''}")
        overlap = sorted({w for c in caps for w in _words(c)} & hay)
        if overlap:
            score += min(40, 15 * len(overlap))
            reasons.append(f"Notice wording overlaps with company capabilities: {', '.join(overlap[:5])}")
        if data.get("match_reasons", {}).get("cpv"):
            score += 25
            reasons.append("CPV codes match a saved search")
        v, lo, hi = notice.get("estimated_value"), org.get("min_contract_value"), org.get("max_contract_value")
        if v is not None and (lo is not None or hi is not None):
            if (lo is None or float(v) >= lo) and (hi is None or float(v) <= hi):
                score += 10
                reasons.append("Estimated value is within the company's usual contract range")
            else:
                score -= 15
                risks.append("Estimated value is outside the company's usual contract range")
        if notice.get("estimated_value") is None:
            risks.append("No estimated value published")
        if not notice.get("deadline_at"):
            risks.append("No tender deadline published")
        if org.get("regions") and notice.get("country") and notice["country"] not in org["regions"]:
            score -= 10
            risks.append("Buyer country is outside the company's regions")
        score = max(0, min(100, score))
        actions: list[dict[str, Any]] = []
        if score >= 60:
            actions.append({"type": "create_opportunity", "payload": {}, "rationale": "Strong fit; start tracking"})
            days_left = _days_left(notice.get("deadline_at"))
            lead = [d for d in (14, 7, 2) if days_left is not None and d < days_left]
            if not lead and days_left is not None and days_left > 1:
                lead = [1]
            if lead:
                actions.append(
                    {
                        "type": "add_deadline_reminders",
                        "payload": {"days_before": lead},
                        "rationale": "Remind the team ahead of the submission deadline",
                    }
                )
            reviewers = data.get("reviewers") or []
            if reviewers:
                actions.append(
                    {
                        "type": "assign_reviewer",
                        "payload": {"reviewer": reviewers[0]["label"]},
                        "rationale": "Assign a reviewer to check eligibility",
                    }
                )
        elif score >= 35:
            actions.append(
                {
                    "type": "draft_clarification_question",
                    "payload": {"question": "Please confirm the expected contract value and the evaluation weighting."},
                    "rationale": "Fit is uncertain; clarify scope before deciding",
                }
            )
        else:
            actions.append(
                {
                    "type": "mark_no_bid",
                    "payload": {"reason": "Low fit score against company profile"},
                    "rationale": "Weak match with capabilities and range",
                }
            )
        out = {
            "fit_score": score,
            "reasons": reasons or ["No strong signals"],
            "risks": risks,
            "proposed_actions": actions,
        }
        text = json.dumps(out)
        return LlmResult(
            text, len(user) // 4, len(text) // 4, self.name, self.model, int((time.monotonic() - start) * 1000)
        )


MARK_BEGIN, MARK_END = "<<<NOTICE_DATA_BEGIN>>>", "<<<NOTICE_DATA_END>>>"


def extract_input(user_prompt: str) -> dict[str, Any]:
    """Pull the JSON data block back out of the user prompt (used by the fake provider and by tests)."""
    start = user_prompt.index(MARK_BEGIN) + len(MARK_BEGIN)
    end = user_prompt.rindex(MARK_END)
    data: dict[str, Any] = json.loads(user_prompt[start:end])
    return data


def build_providers(settings: Settings) -> list[LlmProvider]:
    chain: list[LlmProvider] = []
    for name in settings.llm_chain:
        t = settings.llm_timeout_seconds
        if name == "groq":
            if not settings.groq_api_key:
                continue
            chain.append(
                OpenAICompatProvider("groq", settings.groq_base_url, settings.groq_api_key, settings.groq_model, t)
            )
        elif name == "gemini":
            if not settings.gemini_api_key:
                continue
            chain.append(GeminiProvider(settings.gemini_api_key, settings.gemini_model, t))
        elif name == "ollama":
            chain.append(OllamaProvider(settings.ollama_base_url, settings.ollama_model, t))
        elif name == "fake":
            chain.append(FakeProvider())
        else:
            raise ValueError(f"unknown LLM provider {name!r}; use groq, gemini, ollama or fake")
    if not chain:
        if settings.env == "prod":
            # In production a missing key must be loud. Silently scoring notices with the offline heuristic
            # would look like real agent output.
            raise RuntimeError(
                "No usable LLM provider: LLM_PROVIDER_CHAIN names only providers without credentials. "
                "Set the API keys, or add 'fake' or 'ollama' to the chain on purpose."
            )
        chain.append(FakeProvider())  # keyless default for local development and tests
    return chain
