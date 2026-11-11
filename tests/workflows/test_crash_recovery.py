"""Kill the worker process mid-workflow, restart it, and prove the work resumes and nothing runs twice.

Each test uses its own DBOS system database and real OS processes (killed with TerminateProcess or os._exit,
so there is no graceful shutdown).
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import psycopg
import pytest
from sqlalchemy import text

from tenderline.agent.providers import FakeProvider
from tenderline.agent.qualify import qualify_match
from tenderline.db import owner_session, tenant_session
from tenderline.opportunities import ensure_opportunity
from tests.conftest import _HOST, _PORT, _SUPER
from tests.helpers import raw_notice, reset_notice_tables, seed_match, set_profile, store, wait_for

pytestmark = pytest.mark.workflow
ROOT = Path(__file__).resolve().parents[2]


class Worker:
    def __init__(self, dbos_db: str, *args: str, fault: str | None = None) -> None:
        env = {**os.environ, "TEST_DBOS_DB": dbos_db, "PYTHONUNBUFFERED": "1"}
        env.pop("TENDERLINE_FAULT", None)
        if fault:
            env["TENDERLINE_FAULT"] = fault
        self.proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "tests.workflows.worker", *args],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            self.lines.put(line.rstrip())

    def wait_ready(self, timeout: float = 90) -> None:
        end = time.monotonic() + timeout
        seen: list[str] = []
        while time.monotonic() < end:
            try:
                line = self.lines.get(timeout=0.5)
            except queue.Empty:
                if self.proc.poll() is not None:
                    raise AssertionError(f"worker exited early ({self.proc.returncode}): {seen[-10:]}") from None
                continue
            seen.append(line)
            if line == "READY":
                return
        raise AssertionError(f"worker not ready: {seen[-10:]}")

    def kill(self) -> None:
        self.proc.kill()
        self.proc.wait(10)


@pytest.fixture()
def crash_db(migrated_db):
    name = f"tenderline_crash_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(_SUPER, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}" OWNER tenderline')
    workers: list[Worker] = []
    yield name, workers
    for w in workers:
        if w.proc.poll() is None:
            w.kill()
    with psycopg.connect(_SUPER, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def wf_status(db: str, wid: str) -> str | None:
    with psycopg.connect(f"postgresql://tenderline:tenderline@{_HOST}:{_PORT}/{db}") as c:
        row = c.execute("SELECT status FROM dbos.workflow_status WHERE workflow_uuid = %s", (wid,)).fetchone()
    return row[0] if row else None


def query_rows(sql, **p):
    with owner_session() as s:
        return s.execute(text(sql), p).all()


def test_opportunity_timer_survives_a_killed_process_and_fires_exactly_once(crash_db, make_org):
    db, workers = crash_db
    reset_notice_tables()
    org = make_org()
    n = store(raw_notice())
    with tenant_session(org["org_id"]) as s:
        opp, _ = ensure_opportunity(s, org["org_id"], n.notice_id, actor_type="human", actor_id="u")
        opp_id, wid = opp.id, opp.workflow_id
        s.execute(
            text(
                "INSERT INTO deadlines (organisation_id, opportunity_id, kind, due_at, note, source) VALUES "
                "(:o,:p,'reminder', now() + interval '25 seconds', 'crash-test','human')"
            ),
            {"o": org["org_id"], "p": opp_id},
        )
    a = Worker(db, "opp", str(org["org_id"]), str(opp_id), wid)
    workers.append(a)
    a.wait_ready()
    wait_for(lambda: wf_status(db, wid) == "PENDING", message="workflow pending")
    assert not query_rows("SELECT 1 FROM audit_log WHERE action='reminder.fired'")
    a.kill()  # process dies while the workflow sleeps toward the reminder
    assert wf_status(db, wid) == "PENDING"
    assert query_rows("SELECT fired_at IS NULL FROM deadlines WHERE kind='reminder'")[0][0] is True
    b = Worker(db, "serve")  # a brand-new process recovers the pending workflow on launch
    workers.append(b)
    b.wait_ready()
    wait_for(
        lambda: len(query_rows("SELECT 1 FROM audit_log WHERE action='reminder.fired'")) >= 1,
        timeout=60,
        message="reminder fired",
    )
    time.sleep(8)  # idle wake-ups after firing must not repeat it
    assert len(query_rows("SELECT 1 FROM audit_log WHERE action='reminder.fired'")) == 1
    assert query_rows("SELECT note, fired_at IS NOT NULL FROM deadlines WHERE kind='reminder'") == [
        ("crash-test", True)
    ]
    assert wf_status(db, wid) == "PENDING"  # still tracking the opportunity after recovery


def test_action_executes_exactly_once_when_the_process_dies_after_the_tool_commits(crash_db, make_org):
    db, workers = crash_db
    reset_notice_tables()
    org = make_org("Acme Hosting")
    set_profile(org["org_id"], capabilities=["cloud hosting"], regions=["IRL"])
    notice_id, match_id, _ = seed_match(org["org_id"])
    qualify_match(org["org_id"], match_id, [FakeProvider()])
    pid = query_rows("SELECT id FROM agent_proposals WHERE action_type='add_deadline_reminders'")[0][0]
    with owner_session() as s:  # a human approved it
        s.execute(text("UPDATE agent_proposals SET status='approved', decided_at=now() WHERE id=:i"), {"i": pid})
        s.execute(
            text(
                "INSERT INTO approvals (organisation_id, proposal_id, decision, decided_by) VALUES (:o,:i,'approved',:u)"
            ),
            {"o": org["org_id"], "i": pid, "u": org["user_id"]},
        )
    wid = f"exec-{pid}"
    a = Worker(db, "exec", str(org["org_id"]), str(pid), fault="after_tool_commit")
    workers.append(a)
    # The process commits the tool's writes, then dies before DBOS can checkpoint the step.
    assert a.proc.wait(timeout=120) == 86
    assert query_rows("SELECT status FROM agent_proposals WHERE id=:i", i=pid)[0][0] == "executed"
    assert query_rows("SELECT count(*) FROM deadlines WHERE kind='reminder'")[0][0] == 3
    assert wf_status(db, wid) == "PENDING"  # DBOS has not recorded the step as done
    b = Worker(db, "serve")  # recovery re-runs the step: it must find the work already done
    workers.append(b)
    b.wait_ready()
    wait_for(lambda: wf_status(db, wid) == "SUCCESS", timeout=90, message="workflow recovered and finished")
    assert query_rows("SELECT count(*) FROM deadlines WHERE kind='reminder'")[0][0] == 3  # not 6
    assert query_rows("SELECT count(*) FROM audit_log WHERE action='proposal.executed'")[0][0] == 1
    assert query_rows("SELECT count(*) FROM opportunities")[0][0] == 1
    # recovery also started the opportunity workflow exactly once
    opp_id = query_rows("SELECT id FROM opportunities")[0][0]
    wait_for(
        lambda: wf_status(db, f"opp-{opp_id}") in ("PENDING", "SUCCESS"), timeout=30, message="opportunity workflow"
    )
    assert notice_id is not None
