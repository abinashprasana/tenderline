"""Seed realistic *synthetic* data for load tests and demos.

Notices are marked source='seed' and carry synthetic titles (no real buyer text). Organisations are new on
every run (audit history is append-only, so old seed organisations are left in place). The output JSON feeds k6.
"""

from __future__ import annotations

import json
import random
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import text

from tenderline.agent.providers import FakeProvider
from tenderline.agent.qualify import qualify_match
from tenderline.db import owner_session, tenant_session
from tenderline.matching import load_notice_view, match_notice_for_org
from tenderline.opportunities import change_status, ensure_opportunity
from tenderline.security import create_token

CPVS = [
    ("72000000", "IT services"),
    ("72200000", "Software programming and consultancy"),
    ("72500000", "Computer-related services"),
    ("48000000", "Software packages"),
    ("45000000", "Construction work"),
    ("45210000", "Building construction work"),
    ("50000000", "Repair and maintenance services"),
    ("79000000", "Business services"),
    ("80000000", "Education and training"),
    ("85000000", "Health and social work"),
    ("90000000", "Sewage, refuse, cleaning"),
    ("30200000", "Computer equipment"),
    ("71000000", "Architectural and engineering"),
    ("73000000", "Research and development"),
    ("60000000", "Transport services"),
    ("34000000", "Transport equipment"),
]
BUYERS = [
    "Dublin City Council",
    "Cork County Council",
    "Health Service Executive",
    "Office of Public Works",
    "Transport Infrastructure Ireland",
    "Irish Water",
    "Department of Education",
    "An Garda Siochana",
    "Galway County Council",
    "National Shared Services Office",
    "Revenue Commissioners",
    "Limerick City and County Council",
    "Munster Technological University",
    "Enterprise Ireland",
]
VERBS = ["Provision of", "Supply of", "Framework for", "Delivery of", "Managed service for", "Upgrade of"]
THINGS = [
    "cloud hosting",
    "cyber security services",
    "software development",
    "building maintenance",
    "training programme",
    "ICT equipment",
    "cleaning services",
    "engineering consultancy",
    "data platform",
    "transport services",
    "research services",
    "digital transformation",
]
PROFILE = {
    "description": "Synthetic seed organisation",
    "capabilities": ["cloud hosting", "software development", "cyber security", "digital transformation"],
    "regions": ["IRL"],
    "min_contract_value": 10000,
    "max_contract_value": 1_000_000,
}


def seed_notices(n: int, rng: random.Random) -> list[uuid.UUID]:
    now = datetime.now(UTC)
    ids: list[uuid.UUID] = []
    with owner_session() as s:
        for code, desc in CPVS:
            s.execute(
                text("INSERT INTO cpv_codes (code, division, description) VALUES (:c,:d,:t) ON CONFLICT DO NOTHING"),
                {"c": code, "d": code[:2], "t": desc},
            )
        buyer_ids = {}
        for b in BUYERS:
            norm = b.casefold()
            buyer_ids[b] = s.execute(
                text(
                    "INSERT INTO buyers (name, normalised_name, country) VALUES (:n,:m,'IRL') "
                    "ON CONFLICT (normalised_name, country) DO UPDATE SET name=EXCLUDED.name RETURNING id"
                ),
                {"n": b, "m": norm},
            ).scalar_one()
        for i in range(n):
            code, desc = rng.choice(CPVS)
            thing = rng.choice(THINGS)
            buyer = rng.choice(BUYERS)
            title = f"{rng.choice(VERBS)} {thing} ({desc.lower()}) - lot {i % 7 + 1}"
            value = rng.choice([25_000, 60_000, 120_000, 250_000, 480_000, 900_000, 2_000_000])
            deadline = now + timedelta(days=rng.randint(5, 90))
            sid = f"SEED-{i + 1:06d}"
            nid = s.execute(
                text(
                    "INSERT INTO notices (source, source_id, source_url, notice_type, title, summary, buyer_id, country, "
                    "publication_date, deadline_at, estimated_value, currency, current_version, status) "
                    "VALUES ('seed', :sid, NULL, 'cn-standard', :t, :sm, :b, 'IRL', :p, :d, :v, 'EUR', 1, 'open') "
                    "ON CONFLICT (source, source_id) DO UPDATE SET deadline_at=EXCLUDED.deadline_at RETURNING id"
                ),
                {
                    "sid": sid,
                    "t": title,
                    "sm": f"Synthetic seed notice about {thing}.",
                    "b": buyer_ids[buyer],
                    "p": (now - timedelta(days=rng.randint(0, 20))).date(),
                    "d": deadline,
                    "v": value,
                },
            ).scalar_one()
            s.execute(
                text(
                    "INSERT INTO notice_cpv (notice_id, cpv_code, is_main) VALUES (:n,:c,true) ON CONFLICT DO NOTHING"
                ),
                {"n": nid, "c": code},
            )
            s.execute(
                text(
                    "INSERT INTO notice_versions (notice_id, version, content_hash, raw, fields) "
                    "VALUES (:n,1,:h,CAST('{\"seed\": true}' AS jsonb),CAST('{}' AS jsonb)) ON CONFLICT DO NOTHING"
                ),
                {"n": nid, "h": f"seed-{sid}"},
            )
            ids.append(nid)
    return ids


def seed(
    orgs: int = 3,
    notices: int = 600,
    proposals_per_org: int = 120,
    out: Path = Path("k6/seed.json"),
    base_url: str = "http://localhost:8000",
    seed_value: int = 42,
) -> dict[str, Any]:
    rng = random.Random(seed_value)  # noqa: S311 - synthetic data, not security
    notice_ids = seed_notices(notices, rng)
    result: dict[str, Any] = {"base_url": base_url, "created_at": datetime.now(UTC).isoformat(), "orgs": []}
    stamp = uuid.uuid4().hex[:6]
    for k in range(orgs):
        org_id = uuid.uuid4()
        users: dict[str, uuid.UUID] = {}
        with owner_session() as s:
            s.execute(
                text("INSERT INTO organisations (id, name, slug, profile) VALUES (:i,:n,:s,CAST(:p AS jsonb))"),
                {
                    "i": org_id,
                    "n": f"Seed Org {k + 1} ({stamp})",
                    "s": f"seed-org-{k + 1}-{stamp}",
                    "p": json.dumps(PROFILE),
                },
            )
            for role in ("owner", "bid_manager", "reviewer", "viewer"):
                uid = uuid.uuid4()
                s.execute(
                    text("INSERT INTO users (id, login, name) VALUES (:i,:l,:l)"),
                    {"i": uid, "l": f"seed-{role}-{k + 1}-{stamp}"},
                )
                s.execute(
                    text("INSERT INTO memberships (organisation_id, user_id, role) VALUES (:o,:u,:r)"),
                    {"o": org_id, "u": uid, "r": role},
                )
                users[role] = uid
        search_ids = []
        with tenant_session(org_id) as db:
            for cpvs in (["72000000", "48000000"], ["71000000", "73000000"], ["79000000"]):
                sid = uuid.uuid4()
                db.execute(
                    text(
                        "INSERT INTO saved_searches (id, organisation_id, name, cpv_codes, countries) "
                        "VALUES (:i,:o,:n,:c,ARRAY['IRL'])"
                    ),
                    {"i": sid, "o": org_id, "n": f"search {cpvs[0]}", "c": cpvs},
                )
                search_ids.append(sid)
        match_ids: list[uuid.UUID] = []
        for nid in notice_ids:
            view = load_notice_view(nid)
            if view is not None:
                match_ids.extend(match_notice_for_org(org_id, view))
        for mid in match_ids[:proposals_per_org]:
            qualify_match(org_id, mid, [FakeProvider()])
        opp_ids: list[uuid.UUID] = []
        with tenant_session(org_id) as db:
            for nid in notice_ids[:40]:
                opp, _ = ensure_opportunity(db, org_id, nid, actor_type="agent", actor_id="seed")
                if len(opp_ids) % 3 == 0:
                    change_status(db, org_id, opp, "bid", actor_type="agent", actor_id="seed")
                opp_ids.append(opp.id)
        with owner_session() as s:
            pending = [
                r[0]
                for r in s.execute(
                    text(
                        "SELECT id FROM agent_proposals WHERE organisation_id=:o AND status='pending' "
                        "ORDER BY created_at"
                    ),
                    {"o": org_id},
                )
            ]
        ttl = 24 * 60
        result["orgs"].append(
            {
                "org_id": str(org_id),
                "tokens": {role: create_token(uid, ttl) for role, uid in users.items()},
                "saved_search_ids": [str(i) for i in search_ids],
                "notice_ids": [str(i) for i in notice_ids[:200]],
                "match_ids": [str(i) for i in match_ids[:100]],
                "pending_proposal_ids": [str(i) for i in pending],
                "opportunity_ids": [str(i) for i in opp_ids],
            }
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    return result
