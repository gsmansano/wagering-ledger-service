#!/usr/bin/env bash
# Hands-on PoC for M10: what the logs and the metrics show, and what a bounded wallet-lock wait looks like.
#   Part 1: a bet, its replay and an overdraft; the JSON log line of each and the counters they moved.
#   Part 2: another session holds the wallet lock; the request gets 503 + Retry-After after the limit, the timeout is
#           logged and counted, and the same key succeeds once the lock is free.
#   Part 3: the gauges: outbox backlog and lag (the publisher is off on purpose), DLQ depth and dependencies.
# Starts its own instance on the host (port 3041); the Compose `app` may keep running. Needs the Compose postgres,
# ministack and migrate services:  docker compose up -d postgres ministack migrate
# Each run uses fresh ids, so it can be repeated. Its wallets and outbox events stay in the development database (the
# publisher is off), so the backlog in part 3 grows across runs until an instance with the publisher on drains it.
set -euo pipefail

PORT=3041
BASE="http://localhost:$PORT"
RUN="$(date +%s)-$RANDOM"
LOGS="$(mktemp -d)"
LOCK_LIMIT_MS=1000
PID=""

psql_() { docker compose exec -T postgres psql -U wagering -d wagering "$@"; }
cleanup() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

# The publisher and the other workers are off, so the outbox backlog stays visible in part 3. The limit is short
# so that part 2 does not take long.
PORT=$PORT LOG_LEVEL=info WALLET_LOCK_TIMEOUT_MS=$LOCK_LIMIT_MS OUTBOX_WORKER=off SQS_CONSUMER=off PENDING_REFERENCE_WORKER=off \
  bun src/main.ts >"$LOGS/app.log" 2>&1 &
PID=$!
for _ in $(seq 60); do curl -sf "$BASE/health/live" >/dev/null && break; sleep 0.5; done
curl -sf "$BASE/health/live" >/dev/null || { echo "The instance did not start; see $LOGS/app.log" >&2; exit 1; }

PLAYER="poc-obs-$RUN"
WALLET="$(curl -s -X POST "$BASE/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" |
  sed -E 's/.*"id":"([^"]+)".*/\1/')"
echo "Wallet $WALLET opened with 100.00"

# wager <n> <amount> [key suffix]   sends one BET with correlation id corr-$RUN-<n>; prints the status line
wager() {
  curl -s -D - -o /dev/null -X POST "$BASE/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: poc-obs:$WALLET:${3:-$1}" -H "X-Correlation-Id: corr-$RUN-$1" \
    -d "{\"providerId\":\"poc-obs\",\"externalTransactionId\":\"$WALLET-$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"$2\",\"currency\":\"BRL\"}}" |
    grep -iE '^HTTP|^retry-after' | tr -d '\r' | sed 's/^/  /'
}
# logline <n>   the JSON log lines of correlation id n (the request line; amounts are never in it)
logline() { sleep 0.3; grep "corr-$RUN-$1" "$LOGS/app.log" | sed 's/^/  /'; }
metric() { curl -s "$BASE/metrics" | grep -E "$1" | sed 's/^/  /'; }

echo
echo "### Part 1: logs and counters"
echo "BET 30.00 (X-Correlation-Id corr-$RUN-1)"; wager 1 30.00; logline 1
echo "The same BET again (a replay)"; wager 1 30.00; logline 1 | tail -1
echo "BET 500.00 (insufficient funds)"; wager 2 500.00; logline 2
echo "Counters:"
metric '^wagering_transactions_total|^wagering_duplicates_total|^wagering_processing_seconds_count'


echo
echo "### Part 2: the wallet lock is held longer than the ${LOCK_LIMIT_MS} ms limit"
echo "Another session locks the wallet for 4 s (psql in the background)"
psql_ -q -c "begin; select id from wallets where id = '$WALLET' for no key update; select pg_sleep(4); commit;" >/dev/null &
HOLDER=$!
sleep 1
echo "BET 10.00 (key k3) while the lock is held:"; wager 3 10.00; logline 3
echo "Wait time metric:"; metric '^wagering_wallet_lock_wait_seconds_count'
wait "$HOLDER"
echo "Lock released; the same request with the same key:"; wager 3 10.00; logline 3 | tail -1
echo "Stored transactions for this wallet (the timed-out attempt left nothing behind):"
psql_ -At -c "select external_transaction_id like '%-1' as bet_1, kind, status, failure_code from wager_transactions where wallet_id = '$WALLET' and kind <> 'OPENING' order by created_at"

echo
echo "### Part 3: the gauges, read from PostgreSQL and SQS at each scrape"
echo "The publisher is off, so the events written above are still waiting in the outbox:"
metric '^wagering_outbox_(pending_events|lag_seconds|parked_events)|^wagering_dlq_messages|^wagering_dependency_up'

echo
echo "Full log: $LOGS/app.log"
