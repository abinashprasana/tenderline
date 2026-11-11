#!/usr/bin/env bash
# Seed realistic synthetic data, then run the k6 read and write scenarios against the compose stack.
#   docker compose up -d --build && scripts/loadtest.sh
# Uses the dockerised k6 (no local install). Prints p95 latency and error rate for each scenario.
set -euo pipefail
cd "$(dirname "$0")/.."

# Git Bash on Windows rewrites /unix/paths in arguments; disable that for every docker command below.
if command -v cygpath >/dev/null 2>&1; then export MSYS_NO_PATHCONV=1; fi

NETWORK="${COMPOSE_NETWORK:-tenderline_default}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:latest}"
ORGS="${LOAD_ORGS:-3}"
NOTICES="${LOAD_NOTICES:-600}"

if [ -z "${SKIP_SEED:-}" ]; then
  echo ">> seeding $ORGS organisations and $NOTICES synthetic notices"
  docker compose exec -T app tenderline seed --orgs "$ORGS" --notices "$NOTICES" --proposals 120 --out /tmp/seed.json --base-url http://app:8000
  docker compose cp app:/tmp/seed.json k6/seed.json
fi

# Windows (git bash) needs a native path for the volume mount and no path mangling.
if command -v cygpath >/dev/null 2>&1; then MOUNT="$(cygpath -m "$PWD/k6")"; else MOUNT="$PWD/k6"; fi

for scenario in read write; do
  echo ">> k6 $scenario"
  docker run --rm -i --network "$NETWORK" -v "$MOUNT:/k6" -w /k6 "$K6_IMAGE" run \
    -e BASE_URL=http://app:8000 -e SEED_FILE=/k6/seed.json "/k6/$scenario.js" || echo "(thresholds crossed for $scenario)"
done
