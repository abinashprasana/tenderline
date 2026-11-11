"""A DBOS worker process for crash-recovery tests. Usage:

    python -m tests.workflows.worker serve
    python -m tests.workflows.worker opp <org_id> <opp_id> <workflow_id>
    python -m tests.workflows.worker exec <org_id> <proposal_id>

The test kills the process (TerminateProcess / os._exit) and starts a fresh one to prove recovery.
"""

from __future__ import annotations

import sys
import time
import uuid

import tests.conftest  # noqa: F401  (sets the test environment variables)


def main() -> None:
    from tenderline.workflows import runtime

    cmd = sys.argv[1]
    runtime.start_runtime()
    if cmd == "opp":
        runtime.start_opportunity_workflow(uuid.UUID(sys.argv[2]), uuid.UUID(sys.argv[3]), sys.argv[4])
    elif cmd == "exec":
        runtime.start_execution(uuid.UUID(sys.argv[2]), uuid.UUID(sys.argv[3]))
    print("READY", flush=True)
    while True:
        time.sleep(0.5)


if __name__ == "__main__":
    main()
