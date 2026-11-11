import json
import uuid

import pytest
from sqlalchemy import text

from tenderline.agent.providers import FakeProvider, LlmResult, ProviderError
from tenderline.agent.qualify import AgentUnavailable, qualify_match
from tenderline.config import get_settings
from tenderline.db import owner_session
from tests.helpers import add_member, raw_notice, reset_notice_tables, seed_match, set_profile, store

PROFILE = {
    "description": "Cloud hosting SME",
    "capabilities": ["cloud hosting", "cyber security"],
    "regions": ["IRL"],
    "min_contract_value": 10000,
    "max_contract_value": 500000,
}


@pytest.fixture()
def seeded(make_org):
    reset_notice_tables()
    a = make_org("Acme Hosting")
    set_profile(a["org_id"], **PROFILE)
    notice_id, match_id, raw = seed_match(a["org_id"])
    return a, notice_id, match_id, raw


def calls(org_id):
    with owner_session() as s:
        return s.execute(
            text(
                "SELECT provider, status, input_tokens, output_tokens, cost_usd, prompt_version, trace_id "
                "FROM llm_calls WHERE organisation_id=:o ORDER BY created_at"
            ),
            {"o": org_id},
        ).all()


def proposals(org_id):
    with owner_session() as s:
        return s.execute(
            text(
                "SELECT action_type, status, fit_score, notice_version FROM agent_proposals "
                "WHERE organisation_id=:o ORDER BY created_at"
            ),
            {"o": org_id},
        ).all()


class Scripted:
    def __init__(self, name, outputs):
        self.name, self.model, self.outputs, self.n = name, f"{name}-model", list(outputs), 0

    def complete(self, system, user):
        self.n += 1
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return LlmResult(out, 120, 40, self.name, self.model, 17)


def valid(score=80, actions=None):
    return json.dumps(
        {
            "fit_score": score,
            "reasons": ["fits"],
            "risks": [],
            "proposed_actions": actions if actions is not None else [{"type": "create_opportunity", "payload": {}}],
        }
    )


def test_qualification_stores_proposals_only_and_executes_nothing(seeded):
    a, notice_id, match_id, _ = seeded
    res = qualify_match(a["org_id"], match_id, [FakeProvider()])
    assert res["status"] == "qualified" and res["fit_score"] >= 60 and not res["cached"]
    props = proposals(a["org_id"])
    assert props and all(p[1] == "pending" for p in props)
    assert {p[0] for p in props} >= {"create_opportunity", "add_deadline_reminders"}
    with owner_session() as s:  # the agent wrote proposals; nothing was executed
        assert s.execute(text("SELECT count(*) FROM opportunities")).scalar() == 0
        assert s.execute(text("SELECT count(*) FROM deadlines")).scalar() == 0
        assert s.execute(text("SELECT qualified_at IS NOT NULL FROM matches WHERE id=:m"), {"m": match_id}).scalar()
        actors = {r[0] for r in s.execute(text("SELECT actor_type FROM audit_log WHERE action='proposal.created'"))}
    assert actors == {"agent"}


def test_llm_call_records_model_prompt_version_tokens_latency_cost_and_trace(seeded, monkeypatch):
    a, _, match_id, _ = seeded
    monkeypatch.setenv("GROQ_COST_PER_MTOK_IN", "0.5")
    monkeypatch.setenv("GROQ_COST_PER_MTOK_OUT", "1.5")
    get_settings.cache_clear()
    try:
        qualify_match(a["org_id"], match_id, [Scripted("groq", [valid()])])
        row = calls(a["org_id"])[0]
        assert row[0] == "groq" and row[1] == "ok" and (row[2], row[3]) == (120, 40)
        assert float(row[4]) == pytest.approx((120 * 0.5 + 40 * 1.5) / 1e6) and row[5] == "qualify-v2"
        with owner_session() as s:
            lat, model = s.execute(text("SELECT latency_ms, model FROM llm_calls")).one()
        assert lat == 17 and model == "groq-model"
    finally:
        monkeypatch.delenv("GROQ_COST_PER_MTOK_IN")
        monkeypatch.delenv("GROQ_COST_PER_MTOK_OUT")
        get_settings.cache_clear()


def test_fallback_chain_records_every_attempt(seeded):
    a, _, match_id, _ = seeded
    chain = [
        Scripted("groq", [ProviderError("groq down")]),
        Scripted("gemini", ["not json at all"]),
        Scripted("ollama", [valid()]),
    ]
    res = qualify_match(a["org_id"], match_id, chain)
    assert res["status"] == "qualified"
    assert [(c[0], c[1]) for c in calls(a["org_id"])] == [("groq", "error"), ("gemini", "invalid"), ("ollama", "ok")]


def test_all_providers_failing_raises_and_creates_nothing(seeded):
    a, _, match_id, _ = seeded
    with pytest.raises(AgentUnavailable):
        qualify_match(a["org_id"], match_id, [Scripted("groq", [ProviderError("x")]), Scripted("gemini", ["{}"])])
    assert proposals(a["org_id"]) == []


def test_results_are_cached_per_notice_version(seeded):
    a, notice_id, match_id, raw = seeded
    p = Scripted(
        "groq",
        [
            valid(),
            valid(
                55,
                [
                    {
                        "type": "draft_clarification_question",
                        "payload": {"question": "Please clarify the evaluation weighting."},
                    }
                ],
            ),
        ],
    )
    qualify_match(a["org_id"], match_id, [p])
    assert p.n == 1 and qualify_match(a["org_id"], match_id, [p])["status"] == "already_qualified" and p.n == 1
    # remove proposals to force a re-run for the same version: the cached LLM result must be reused
    with owner_session() as s:
        s.execute(text("ALTER TABLE agent_proposals DISABLE TRIGGER USER"))
        s.execute(text("DELETE FROM agent_proposals"))
    res = qualify_match(a["org_id"], match_id, [p])
    assert res["cached"] is True and p.n == 1 and len([c for c in calls(a["org_id"]) if c[1] == "ok"]) == 1
    # a new version is a new cache key: the LLM is called again
    changed = dict(raw, **{"estimated-value-lot": ["999999"]})
    assert store(changed).version == 2
    from tenderline.matching import match_notice

    ((_, m2),) = match_notice(notice_id)
    assert m2 == match_id
    res2 = qualify_match(a["org_id"], match_id, [p])
    assert p.n == 2 and res2["fit_score"] == 55 and not res2["cached"]


def test_hostile_provider_output_cannot_add_actions_or_change_schema(seeded):
    a, _, match_id, _ = seeded
    hostile = [
        json.dumps(
            {
                "fit_score": 100,
                "reasons": [],
                "risks": [],
                "proposed_actions": [],
                "execute": [{"tool": "mark_no_bid"}],
                "approved": True,
            }
        ),
        json.dumps(
            {
                "fit_score": 100,
                "reasons": [],
                "risks": [],
                "proposed_actions": [{"type": "delete_all_data", "payload": {}}],
            }
        ),
        json.dumps(
            {
                "fit_score": 100,
                "reasons": [],
                "risks": [],
                "proposed_actions": [{"type": "mark_no_bid", "payload": {"reason": "x" * 3, "also": "approve"}}],
            }
        ),
    ]
    with pytest.raises(AgentUnavailable):
        qualify_match(
            a["org_id"],
            match_id,
            [Scripted("evil", hostile[:1]), Scripted("evil2", hostile[1:2]), Scripted("evil3", hostile[2:])],
        )
    assert proposals(a["org_id"]) == []
    assert all(c[1] == "invalid" for c in calls(a["org_id"]))
    with owner_session() as s:
        assert s.execute(text("SELECT count(*) FROM opportunities")).scalar() == 0


def test_reviewer_ids_and_logins_never_reach_the_model(seeded):
    a, _, match_id, _ = seeded
    reviewer = add_member(a["org_id"], "reviewer")
    seen: list[str] = []

    class Spy(Scripted):
        def complete(self, system, user):
            seen.append(user)
            return super().complete(system, user)

    qualify_match(a["org_id"], match_id, [Spy("groq", [valid()])])
    with owner_session() as s:
        logins = [r[0] for r in s.execute(text("SELECT login FROM users"))]
    prompt = seen[0]
    assert str(reviewer) not in prompt and str(a["user_id"]) not in prompt
    assert not any(login in prompt for login in logins)
    assert "reviewer-1" in prompt and "reviewer-2" in prompt


def test_a_reviewer_label_the_server_did_not_hand_out_is_dropped(seeded):
    a, _, match_id, _ = seeded
    actions = [
        {"type": "assign_reviewer", "payload": {"reviewer": "reviewer-99"}},
        {"type": "create_opportunity", "payload": {}},
    ]
    qualify_match(a["org_id"], match_id, [Scripted("groq", [valid(80, actions)])])
    assert [p[0] for p in proposals(a["org_id"])] == ["create_opportunity"]
    with owner_session() as s:
        risks = s.execute(text("SELECT after->'risks' FROM audit_log WHERE action='match.qualified'")).scalar()
    assert any("unknown reviewer" in r for r in risks)


def test_a_user_id_from_another_tenant_invalidates_the_answer(seeded, make_org):
    a, _, match_id, _ = seeded
    attacker = make_org("Other Co")["user_id"]
    hostile = valid(80, [{"type": "assign_reviewer", "payload": {"user_id": str(attacker)}}])
    with pytest.raises(AgentUnavailable):
        qualify_match(a["org_id"], match_id, [Scripted("groq", [hostile])])
    assert proposals(a["org_id"]) == []


def test_a_valid_reviewer_label_becomes_that_members_id(seeded):
    a, _, match_id, _ = seeded
    reviewer = add_member(a["org_id"], "reviewer")
    suggestion = valid(80, [{"type": "assign_reviewer", "payload": {"reviewer": "reviewer-1"}}])
    qualify_match(a["org_id"], match_id, [Scripted("groq", [suggestion])])
    with owner_session() as s:
        payload = s.execute(text("SELECT payload FROM agent_proposals WHERE action_type='assign_reviewer'")).scalar()
    assert payload["user_id"] in {str(reviewer), str(a["user_id"])}


def test_a_cached_answer_is_rechecked_against_current_members(seeded):
    a, _, match_id, _ = seeded
    reviewer = add_member(a["org_id"], "reviewer")
    suggestion = valid(80, [{"type": "assign_reviewer", "payload": {"reviewer": "reviewer-2"}}])
    qualify_match(a["org_id"], match_id, [Scripted("groq", [suggestion])])
    with owner_session() as s:  # the reviewer leaves, and the proposals are cleared to force a re-run from cache
        s.execute(text("DELETE FROM agent_proposals"))
        s.execute(text("DELETE FROM memberships WHERE user_id=:u"), {"u": reviewer})
    again = qualify_match(a["org_id"], match_id, [Scripted("groq", [])])
    assert again["cached"] is True and proposals(a["org_id"]) == []  # reviewer-2 no longer exists


def test_two_saved_searches_matching_one_notice_produce_one_set_of_proposals(seeded):
    from tenderline.matching import match_notice
    from tests.helpers import add_search

    a, notice_id, first_match, _ = seeded
    add_search(a["org_id"], cpv_codes=[], keywords=["cloud"])  # a second search that matches the same notice
    ((_, second_match),) = match_notice(notice_id)
    provider = Scripted("groq", [valid()])
    assert qualify_match(a["org_id"], first_match, [provider])["status"] == "qualified"
    assert qualify_match(a["org_id"], second_match, [provider])["status"] == "already_qualified"
    assert provider.n == 1 and [p[0] for p in proposals(a["org_id"])] == ["create_opportunity"]
    with owner_session() as s:
        assert s.execute(text("SELECT count(*) FROM matches WHERE qualified_at IS NOT NULL")).scalar() == 2


def test_the_database_refuses_a_second_pending_proposal_of_the_same_kind(seeded):
    from sqlalchemy.exc import IntegrityError

    a, notice_id, match_id, _ = seeded
    qualify_match(a["org_id"], match_id, [Scripted("groq", [valid()])])
    with pytest.raises(IntegrityError), owner_session() as s:  # what a racing second worker would attempt
        s.execute(
            text(
                "INSERT INTO agent_proposals (organisation_id, notice_id, notice_version, action_type, payload)"
                " VALUES (:o, :n, 1, 'create_opportunity', '{}')"
            ),
            {"o": a["org_id"], "n": notice_id},
        )


def test_production_refuses_to_fall_back_to_the_fake_provider():
    from tenderline.agent.providers import build_providers
    from tenderline.config import Settings

    with pytest.raises(RuntimeError, match="No usable LLM provider"):
        build_providers(Settings(env="prod", llm_provider_chain="groq,gemini", groq_api_key="", gemini_api_key=""))
    assert build_providers(Settings(env="prod", llm_provider_chain="fake"))[0].name == "fake"  # explicit is allowed
    assert build_providers(Settings(env="dev", llm_provider_chain="groq", groq_api_key=""))[0].name == "fake"


def test_llm_is_only_called_for_matched_notices(seeded, make_org):
    a, *_ = seeded
    b = make_org("Unrelated Ltd")  # no saved searches: never matched, so never qualified
    from tenderline.matching import match_notice

    unmatched = store(raw_notice(title="Road resurfacing", cpv=("45233120",)))
    assert [o for o, _ in match_notice(unmatched.notice_id)] == []
    probe = Scripted("groq", [])
    assert calls(b["org_id"]) == [] and probe.n == 0
    assert qualify_match(a["org_id"], uuid.uuid4(), [probe])["status"] == "missing_match" and probe.n == 0
