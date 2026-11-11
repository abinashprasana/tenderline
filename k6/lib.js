// Shared helpers for the k6 scripts. Fixture data comes from `tenderline seed` (k6/seed.json).
import http from 'k6/http';
import { check } from 'k6';

export const BASE = __ENV.BASE_URL || 'http://localhost:8000';
export const seed = JSON.parse(open(__ENV.SEED_FILE || './seed.json'));

export function ctxFor(vu) {
  const org = seed.orgs[(vu - 1) % seed.orgs.length];
  return { org, base: `${BASE}/v1/organisations/${org.org_id}` };
}

export function headers(token, idemKey) {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idemKey) h['Idempotency-Key'] = idemKey;
  return h;
}

export function ok(res, name) {
  return check(res, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Prints the two numbers that matter and writes the full summary next to the script.
export function summary(name, data) {
  const d = data.metrics.http_req_duration.values;
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate : 0;
  const lines = [
    '',
    `==== ${name} ====`,
    `requests:        ${reqs.count} (${reqs.rate.toFixed(1)}/s)`,
    `latency p50:     ${d.med.toFixed(1)} ms`,
    `latency p95:     ${d['p(95)'].toFixed(1)} ms`,
    `latency p99:     ${d['p(99)'].toFixed(1)} ms`,
    `error rate:      ${(failed * 100).toFixed(2)} %`,
    '',
  ];
  return { stdout: lines.join('\n'), [`/k6/results-${name}.json`]: JSON.stringify(data, null, 1) };
}

export { http };
