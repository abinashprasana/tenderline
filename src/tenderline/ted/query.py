"""Build TED expert-search queries. Syntax verified live: field=value, `*` wildcards, AND/OR/parentheses,
`publication-date>=YYYYMMDD`, and `SORT BY <field> [DESC]` (ascending is the default; `ASC` is a syntax error)."""

from __future__ import annotations

import re
from datetime import date

_CPV = re.compile(r"^\d{2,8}$")


def build_ingest_query(country: str, since: date, cpv_prefixes: list[str] | None = None) -> str:
    """Irish buyers, plus EU-wide notices in the configured CPV prefixes, published on/after `since`."""
    if not re.fullmatch(r"[A-Z]{3}", country):
        raise ValueError("country must be an ISO 3166-1 alpha-3 code, e.g. IRL")
    clauses = [f"buyer-country={country}"]
    for prefix in cpv_prefixes or []:
        if not _CPV.fullmatch(prefix):
            raise ValueError(f"invalid CPV prefix {prefix!r}")
        clauses.append(f"classification-cpv={prefix}*")
    scope = clauses[0] if len(clauses) == 1 else "(" + " OR ".join(clauses) + ")"
    return f"{scope} AND publication-date>={since:%Y%m%d} SORT BY publication-date"
