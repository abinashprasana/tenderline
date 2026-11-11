"""Contract tests for the TED client against recorded real responses. No live calls."""

import json
from pathlib import Path

import httpx
import pytest

from tenderline.ted.client import TedClient, TedError, TedExpiredToken, parse_retry_after

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "ted"


def fixture(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


class Recorder:
    """httpx transport that replays queued responses and records what the client sent."""

    def __init__(self, *responses):
        self.queue = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request):
        self.requests.append(request)
        item = self.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def bodies(self):
        return [json.loads(r.content) for r in self.requests]


def client(rec, sleeps=None, **kw):
    sleeps = sleeps if sleeps is not None else []
    clock = {"t": 0.0}

    def sleep(s):
        sleeps.append(s)
        clock["t"] += s

    return TedClient(
        transport=httpx.MockTransport(rec), sleep=sleep, monotonic=lambda: clock["t"], rand=lambda: 0.5, **kw
    ), sleeps


def ok(name):
    return httpx.Response(200, json=fixture(name))


def test_request_shape_matches_documented_iteration_mode():
    rec = Recorder(ok("cn_recent_page1.json"))
    c, _ = client(rec, page_size=2)
    page = c.search_page("buyer-country=IRL")
    req = rec.requests[0]
    assert req.method == "POST" and req.url.path == "/v3/notices/search" and "api.ted.europa.eu" in str(req.url)
    body = rec.bodies()[0]
    assert body["paginationMode"] == "ITERATION" and body["limit"] == 2 and "iterationNextToken" not in body
    assert "publication-number" in body["fields"] and body["query"] == "buyer-country=IRL"
    assert len(page.notices) == 2 and page.next_token and page.total


def test_iteration_follows_token_until_empty_page():
    p1, p2 = fixture("cn_recent_page1.json"), fixture("cn_recent_page2.json")
    empty = {"notices": [], "totalNoticeCount": p1["totalNoticeCount"], "timedOut": False}
    rec = Recorder(ok("cn_recent_page1.json"), ok("cn_recent_page2.json"), httpx.Response(200, json=empty))
    c, _ = client(rec, page_size=2)
    pages = list(c.iterate("q"))
    assert [len(p.notices) for p in pages] == [2, 2]
    bodies = rec.bodies()
    assert "iterationNextToken" not in bodies[0]
    assert bodies[1]["iterationNextToken"] == p1["iterationNextToken"]
    assert bodies[2]["iterationNextToken"] == p2["iterationNextToken"]


def test_resume_from_saved_token():
    rec = Recorder(ok("cn_recent_page2.json"))
    c, _ = client(rec, page_size=2)
    next(c.iterate("q", token="saved-token", max_pages=1))
    assert rec.bodies()[0]["iterationNextToken"] == "saved-token"


def test_max_pages_stops_iteration():
    rec = Recorder(ok("cn_recent_page1.json"), ok("cn_recent_page2.json"))
    c, _ = client(rec, page_size=2)
    assert len(list(c.iterate("q", max_pages=1))) == 1 and len(rec.requests) == 1


def test_retry_after_seconds_is_honoured_on_429():
    rec = Recorder(httpx.Response(429, headers={"Retry-After": "17"}), ok("cn_recent_page1.json"))
    c, sleeps = client(rec)
    assert c.search_page("q").notices
    assert 17.0 in sleeps and len(rec.requests) == 2


def test_retry_after_http_date_parses():
    assert parse_retry_after("120") == 120.0
    assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=1445412480 - 30) == 30.0
    assert parse_retry_after(None) is None and parse_retry_after("soon") is None


def test_exponential_backoff_with_jitter_when_no_retry_after():
    rec = Recorder(httpx.Response(503), httpx.Response(503), httpx.Response(500), ok("cn_recent_page1.json"))
    c, sleeps = client(rec, backoff_base=2.0, max_requests_per_minute=600)
    assert c.search_page("q").notices
    waits = [s for s in sleeps if s >= 1.0]  # rand fixed at 0.5 -> 0.5 * min(cap, 2 * 2**attempt): doubles each attempt
    assert waits == [1.0, 2.0, 4.0]


def test_network_errors_are_retried_then_give_up():
    boom = httpx.ConnectError("down")
    rec = Recorder(*[boom] * 3)
    c, _ = client(rec, max_attempts=3)
    with pytest.raises(TedError, match="retries exhausted"):
        c.search_page("q")
    assert len(rec.requests) == 3


def test_client_error_is_not_retried():
    rec = Recorder(httpx.Response(400, text='{"error":{"type":"QUERY_SYNTAX_ERROR"}}'))
    c, _ = client(rec)
    with pytest.raises(TedError, match="HTTP 400"):
        c.search_page("bad query")
    assert len(rec.requests) == 1


def test_expired_iteration_token_is_distinguished():
    rec = Recorder(
        httpx.Response(400, text='{"error":{"type":"EXPIRED_ITERATION_TOKEN"},"m":"ExpiredIterationTokenError"}')
    )
    c, _ = client(rec)
    with pytest.raises(TedExpiredToken):
        c.search_page("q", token="old")


def test_requests_are_paced_well_below_the_fair_use_limit():
    rec = Recorder(*[ok("cn_recent_page1.json") for _ in range(4)])
    c, sleeps = client(rec, max_requests_per_minute=60)
    for _ in range(4):
        c.search_page("q")
    # 60 req/min => at least 1s between requests; 3 gaps after the first request.
    assert sum(sleeps) >= 3.0


def test_refuses_configurations_that_could_breach_fair_use():
    with pytest.raises(ValueError):
        TedClient(max_requests_per_minute=700)
    with pytest.raises(ValueError):
        TedClient(page_size=251)
