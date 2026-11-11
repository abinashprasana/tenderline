"""Record real TED responses as test fixtures (run manually; tests never call the live API).

uv run python scripts/record_ted_fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path

from tenderline.ted.client import SEARCH_FIELDS, TedClient

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ted"

CASES = {
    # name: (query, limit)
    "cn_recent_page1": (
        "buyer-country=IRL AND notice-type=cn-standard AND publication-date>=20261101 SORT BY publication-date",
        2,
    ),
    "can_recent_page1": (
        "buyer-country=IRL AND notice-type=can-standard AND publication-date>=20261101 SORT BY publication-date",
        2,
    ),
}


def strip_links(page: dict) -> dict:
    for n in page.get("notices", []):
        n.pop("links", None)
    return page


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with TedClient(max_requests_per_minute=20, page_size=2) as client:
        for name, (query, _limit) in CASES.items():
            body = {"query": query, "fields": SEARCH_FIELDS, "limit": 2, "paginationMode": "ITERATION"}
            data = client._post(body)  # noqa: SLF001 - recording raw payloads
            (OUT / f"{name}.json").write_text(
                json.dumps(strip_links(data), indent=2, ensure_ascii=False), encoding="utf-8"
            )
            print(name, len(data.get("notices", [])), "notices; token:", bool(data.get("iterationNextToken")))
        # second page of the first case, to record token-based continuation
        q = CASES["cn_recent_page1"][0]
        first = client._post({"query": q, "fields": SEARCH_FIELDS, "limit": 2, "paginationMode": "ITERATION"})  # noqa: SLF001
        second = client._post(  # noqa: SLF001
            {
                "query": q,
                "fields": SEARCH_FIELDS,
                "limit": 2,
                "paginationMode": "ITERATION",
                "iterationNextToken": first["iterationNextToken"],
            }
        )
        (OUT / "cn_recent_page2.json").write_text(
            json.dumps(strip_links(second), indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print("cn_recent_page2", len(second.get("notices", [])), "notices")


if __name__ == "__main__":
    main()
