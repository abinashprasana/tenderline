// Read path: the endpoints a bid manager hits all day. Run: scripts/loadtest.sh
import { sleep, group } from 'k6';
import http from 'k6/http';
import { BASE, ctxFor, headers, ok, pick, summary } from './lib.js';

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  stages: [
    { duration: '15s', target: 10 },
    { duration: '45s', target: 25 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const { org, base } = ctxFor(__VU);
  const h = headers(org.tokens.viewer);

  group('notices (shared data)', () => {
    ok(http.get(`${BASE}/v1/notices?limit=50`, { headers: h, tags: { name: 'GET /v1/notices' } }), 'notices list');
    ok(http.get(`${BASE}/v1/notices?cpv=72&country=IRL&limit=25`, { headers: h, tags: { name: 'GET /v1/notices?filter' } }), 'notices filter');
    ok(http.get(`${BASE}/v1/notices/${pick(org.notice_ids)}`, { headers: h, tags: { name: 'GET /v1/notices/{id}' } }), 'notice detail');
  });
  group('tenant data', () => {
    ok(http.get(`${base}/matches?limit=50`, { headers: h, tags: { name: 'GET matches' } }), 'matches');
    ok(http.get(`${base}/agent-proposals?status=pending&limit=50`, { headers: h, tags: { name: 'GET agent-proposals' } }), 'proposals');
    ok(http.get(`${base}/opportunities?limit=50`, { headers: h, tags: { name: 'GET opportunities' } }), 'opportunities');
    ok(http.get(`${base}/opportunities/${pick(org.opportunity_ids)}`, { headers: h, tags: { name: 'GET opportunities/{id}' } }), 'opportunity detail');
    ok(http.get(`${base}/deadlines?within_days=60`, { headers: h, tags: { name: 'GET deadlines' } }), 'deadlines');
    ok(http.get(`${base}/audit-log?limit=50`, { headers: h, tags: { name: 'GET audit-log' } }), 'audit');
  });
  sleep(0.5 + Math.random());
}

export function handleSummary(data) {
  return summary('read', data);
}
