"""CPV code labels for the code picker.

The source is the official CPV 2008 list adopted by Regulation (EC) No 213/2008, published by the Publications
Office of the EU on TED (https://ted.europa.eu/en/simap/cpv, the "XML" download, a zip containing
cpv_2008.xml). TED notices carry codes without labels, so labels come from this list.

The repository ships `data/cpv/cpv_2008_en.csv` (code and English label, extracted from that file with
`tenderline cpv-load cpv_2008.xml --write-csv data/cpv/cpv_2008_en.csv`), so the picker works without a
download. `tenderline migrate` loads it when the table has no labels yet.
"""

from __future__ import annotations

import csv
import xml.etree.ElementTree as ET  # noqa: S405 - parses the official EU file, not user input
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from tenderline.db import owner_session, public_session
from tenderline.models import CpvCode

BUNDLED_CSV = Path(__file__).resolve().parents[2] / "data" / "cpv" / "cpv_2008_en.csv"
INSTALLED_CSV = Path("/app/data/cpv/cpv_2008_en.csv")


def read_official_xml(path: Path) -> Iterator[tuple[str, str]]:
    """Yield (8-digit code, English label) from the official cpv_2008.xml.

    Codes are written there with their check digit, e.g. "03000000-1"; we store the 8 digits only, which is
    how TED notices carry them.
    """
    for _, element in ET.iterparse(path, events=("end",)):  # noqa: S314
        if element.tag != "CPV":
            continue
        code = (element.get("CODE") or "").split("-")[0]
        label = next((t.text for t in element.findall("TEXT") if t.get("LANG") == "EN"), None)
        if len(code) == 8 and code.isdigit() and label:
            yield code, label.strip()
        element.clear()


def read_csv(path: Path) -> Iterator[tuple[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            yield row["code"], row["label"]


def write_csv(rows: list[tuple[str, str]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["code", "label"])
        writer.writerows(rows)


def store_labels(rows: list[tuple[str, str]]) -> int:
    """Insert or relabel CPV codes. Returns how many rows were written."""
    with owner_session() as db:
        for start in range(0, len(rows), 1000):
            chunk = rows[start : start + 1000]
            insert = pg_insert(CpvCode).values(
                [{"code": code, "division": code[:2], "description": label[:300]} for code, label in chunk]
            )
            db.execute(
                insert.on_conflict_do_update(index_elements=["code"], set_={"description": insert.excluded.description})
            )
    return len(rows)


def labelled_count() -> int:
    with public_session() as db:
        return int(db.scalar(select(func.count()).select_from(CpvCode).where(CpvCode.description.is_not(None))) or 0)


def ensure_labels_loaded() -> int:
    """Load the bundled labels if the table has (almost) none. Cheap to call on every start-up."""
    if labelled_count() >= 1000:
        return 0
    source = next((path for path in (BUNDLED_CSV, INSTALLED_CSV) if path.exists()), None)
    return store_labels(list(read_csv(source))) if source else 0
