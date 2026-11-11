"""A local stand-in for the TED API serving the recorded fixtures (so no test touches the real service)."""

from __future__ import annotations

import copy
import json
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "ted"


def _load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIX / name).read_text(encoding="utf-8"))
    return data


class FakeTed:
    """Serves page1 -> page2 -> empty using the recorded iteration tokens. Deadlines are moved into the future
    so the notices stay 'open' however old the fixtures get."""

    def __init__(self, fail_with: int | None = None) -> None:
        self.p1, self.p2 = _load("cn_recent_page1.json"), _load("cn_recent_page2.json")
        self.requests: list[dict[str, Any]] = []
        self.fail_with = fail_with
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def start(self) -> FakeTed:
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def _future(self, page: dict[str, Any]) -> dict[str, Any]:
        page = copy.deepcopy(page)
        due = (datetime.now(UTC) + timedelta(days=30)).strftime("%Y-%m-%dZ")
        for n in page["notices"]:
            n["deadline-receipt-tender-date-lot"] = [due]
        return page

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(body)
                if outer.fail_with:
                    self.send_response(outer.fail_with)
                    self.end_headers()
                    self.wfile.write(b'{"message":"nope"}')
                    return
                token = body.get("iterationNextToken")
                if token is None:
                    page = outer._future(outer.p1)
                elif token == outer.p1["iterationNextToken"]:
                    page = outer._future(outer.p2)
                else:
                    page = {"notices": [], "totalNoticeCount": outer.p1["totalNoticeCount"], "timedOut": False}
                data = json.dumps(page).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:
                return

        return Handler
