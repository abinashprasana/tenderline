"""Score the agent's fit_score against a labelled JSONL file.

File format (one JSON object per line). An optional first line {"_meta": {...}} describes the file; set
"synthetic": true in it when the labels were not produced by real reviewers (the sample file is synthetic).

  {"id": "ex-01",
   "organisation": {"name": "...", "capabilities": [...], "regions": [...], "min_contract_value": 1000, ...},
   "notice": {"title": "...", "summary": "...", "buyer": "...", "country": "IRL", "cpv_codes": [...],
              "estimated_value": "100000", "deadline_at": "2031-01-01T00:00:00+00:00"},
   "match_reasons": {"cpv": ["72200000"]},        # optional
   "label_fit": 85}                                # human fit rating, 0-100
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from tenderline.agent.providers import LlmProvider, ProviderError
from tenderline.agent.qualify import SYSTEM_PROMPT, build_user_prompt, parse_output

THRESHOLD = 60  # fit >= 60 means "worth pursuing"


@dataclass
class EvalResult:
    n: int = 0
    scored: int = 0
    invalid: int = 0
    errors: int = 0
    mae: float | None = None
    rmse: float | None = None
    pearson: float | None = None
    spearman: float | None = None
    accuracy: float | None = None
    precision: float | None = None
    recall: float | None = None
    synthetic: bool = False
    rows: list[dict[str, Any]] = field(default_factory=list)


def load_labelled(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    meta: dict[str, Any] = {}
    records: list[dict[str, Any]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        obj = json.loads(line)
        if "_meta" in obj:
            meta = obj["_meta"]
            continue
        for key in ("id", "organisation", "notice", "label_fit"):
            if key not in obj:
                raise ValueError(f"line {lineno}: missing '{key}'")
        if not 0 <= float(obj["label_fit"]) <= 100:
            raise ValueError(f"line {lineno}: label_fit must be 0-100")
        records.append(obj)
    if not records:
        raise ValueError("no labelled records found")
    return meta, records


def _ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / (sx * sy)


def spearman(xs: list[float], ys: list[float]) -> float | None:
    return pearson(_ranks(xs), _ranks(ys))


def evaluate(path: Path, providers: list[LlmProvider]) -> EvalResult:
    meta, records = load_labelled(path)
    res = EvalResult(n=len(records), synthetic=bool(meta.get("synthetic")))
    preds: list[float] = []
    labels: list[float] = []
    for rec in records:
        data = {
            "organisation": rec["organisation"],
            "notice": rec["notice"],
            "match_reasons": rec.get("match_reasons", {}),
            "reviewers": [],
        }
        prompt = build_user_prompt(data)
        score: int | None = None
        status = "error"
        for p in providers:
            try:
                out = p.complete(SYSTEM_PROMPT, prompt)
            except ProviderError:
                continue
            try:
                score = parse_output(out.text).fit_score
                status = "ok"
                break
            except (ValidationError, ValueError):
                status = "invalid"
        if score is None:
            res.invalid += status == "invalid"
            res.errors += status == "error"
        else:
            preds.append(float(score))
            labels.append(float(rec["label_fit"]))
        res.rows.append({"id": rec["id"], "label": rec["label_fit"], "predicted": score, "status": status})
    res.scored = len(preds)
    if preds:
        errs = [p - y for p, y in zip(preds, labels, strict=True)]
        res.mae = sum(abs(e) for e in errs) / len(errs)
        res.rmse = math.sqrt(sum(e * e for e in errs) / len(errs))
        res.pearson, res.spearman = pearson(preds, labels), spearman(preds, labels)
        pos_p = [p >= THRESHOLD for p in preds]
        pos_l = [y >= THRESHOLD for y in labels]
        tp = sum(a and b for a, b in zip(pos_p, pos_l, strict=True))
        res.accuracy = sum(a == b for a, b in zip(pos_p, pos_l, strict=True)) / len(preds)
        res.precision = tp / sum(pos_p) if sum(pos_p) else None
        res.recall = tp / sum(pos_l) if sum(pos_l) else None
    return res
