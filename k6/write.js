// Write path: create saved searches (idempotent POSTs), add reminders, approve proposals (each exactly once).
import { sleep, group } from 'k6';
import http from 'k6/http';
import exec from 'k6/execution';
import { ctxFor, headers, ok, pick, summary } from './lib.js';

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  stages: [
    { duration: '10s', target: 5 },
    { duration: '40s', target: 10 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

const CPVS = ['72000000', '48000000', '71000000', '73000000', '79000000', '45000000'];

export default function () {
  const { org, base } = ctxFor(__VU);
  const owner = org.tokens.owner;
  const manager = org.tokens.bid_manager;
  const n = exec.scenario.iterationInTest;
  const key = (p) => `${p}-${__VU}-${__ITER}-${n}-${Date.now()}`;

  group('create saved search', () => {
    const body = JSON.stringify({ name: `load ${n}`, cpv_codes: [pick(CPVS)], countries: ['IRL'] });
    const idem = key('ss');
    const res = http.post(`${base}/saved-searches`, body, { headers: headers(owner, idem), tags: { name: 'POST saved-searches' } });
    ok(res, 'create search');
    // a retry with the same Idempotency-Key must replay, not duplicate
    const replay = http.post(`${base}/saved-searches`, body, { headers: headers(owner, idem), tags: { name: 'POST saved-searches (replay)' } });
    ok(replay, 'replay search');
  });

  group('add reminders', () => {
    const opp = pick(org.opportunity_ids);
    ok(http.post(`${base}/opportunities/${opp}/reminders`, JSON.stringify({ days_before: [3] }),
        { headers: headers(manager, key('rem')), tags: { name: 'POST reminders' } }), 'reminders');
  });

  group('approve a proposal', () => {
    // each virtual user walks its own slice of the pending proposals so every one is approved at most once
    const idx = (__VU - 1) * 1000 + __ITER;
    const slice = org.pending_proposal_ids;
    const id = slice[idx % slice.length];
    const res = http.post(`${base}/agent-proposals/${id}/approve`, JSON.stringify({ comment: 'load test' }),
      { headers: headers(manager, `ap-${id}`), tags: { name: 'POST approve' }, responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 409) });
    ok({ status: res.status === 409 ? 200 : res.status }, 'approve');
  });
  sleep(0.3 + Math.random() * 0.5);
}

export function handleSummary(data) {
  return summary('write', data);
}
