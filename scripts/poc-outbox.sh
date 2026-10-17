#!/usr/bin/env bash
# Hands-on PoC for M8: events are written in the same transaction as the change and published afterwards.
#   Part 1: an instance commits and dies before publishing; a second instance publishes the events, in order.
#   Part 2: an event that was sent but not marked is sent again; the broker keeps one copy.
#   Part 3: a parked event holds back the later events of its own wallet only, until it is requeued.
# Starts and stops its own app instances on the host (ports 3021 and 3022), so the Compose `app` must not be running:
# its publisher would send the events before this script can show them waiting. Needs the Compose postgres, ministack
# and migrate services:  docker compose up -d postgres ministack migrate
# Each run uses fresh ids, so it can be repeated.
set -euo pipefail

ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"
RUN="$(date +%s)-$RANDOM"
LOGS="$(mktemp -d)"
PIDS=()

aws_cli() {
  if command -v aws >/dev/null; then
    AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 aws --endpoint-url "$ENDPOINT" "$@"
  else
    docker run --rm --network host -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
      -e AWS_DEFAULT_REGION=us-east-1 amazon/aws-cli --endpoint-url "$ENDPOINT" "$@"
  fi
}
psql_() { docker compose exec -T postgres psql -U wagering -d wagering "$@"; }
sql() { psql_ -At -c "$1"; }

if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  echo "The Compose app is running and would publish the events at once. Stop it first: docker compose stop app" >&2
  exit 1
fi

cleanup() { for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

# start_instance <port> <outbox worker on|off>   background app with the other workers off; sets PID
start_instance() {
  PORT="$1" OUTBOX_WORKER="$2" OUTBOX_POLL_MS=250 SQS_CONSUMER=off PENDING_REFERENCE_WORKER=off \
    bun src/main.ts >"$LOGS/instance-$1-$2.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  for _ in $(seq 60); do
    curl -sf "http://localhost:$1/health/live" >/dev/null && return
    sleep 0.5
  done
  echo "Instance on port $1 did not start; see $LOGS" >&2
  exit 1
}

# new_wallet <port> <name>   creates a wallet with 1000.00 and sets WALLET (id) and PLAYER
new_wallet() {
  PLAYER="poc-$2-$RUN"
  WALLET="$(curl -s -X POST "http://localhost:$1/wallets" -H 'content-type: application/json' \
    -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" |
    sed -E 's/.*"id":"([^"]+)".*/\1/')"
}

# wager <port> <kind> <n> <amount>   sends one transaction for $WALLET and prints the HTTP status
wager() {
  curl -s -o /dev/null -w "  $2 $4 -> HTTP %{http_code}\n" -X POST "http://localhost:$1/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: poc:$WALLET:$3" \
    -d "{\"providerId\":\"poc\",\"externalTransactionId\":\"$WALLET-$3\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"$2\",\"money\":{\"amount\":\"$4\",\"currency\":\"BRL\"}}"
}

# outbox <walletId>   one line per event, in publication order
outbox() {
  psql_ -c "select sequence, event_type, (published_at is not null) as published, attempts, (failed_at is not null) as parked
              from outbox_messages where aggregate_id = '$1' order by sequence"
}
unpublished() { sql "select count(*) from outbox_messages where aggregate_id = '$1' and published_at is null"; }
wait_published() { for _ in $(seq 60); do [[ "$(unpublished "$1")" == 0 ]] && return; sleep 0.25; done; echo "  still unpublished: $(unpublished "$1")"; }

EVENTS="$(aws_cli sqs get-queue-url --queue-name wager-events.fifo --query QueueUrl --output text)"
queue_count() {
  aws_cli sqs get-queue-attributes --queue-url "$EVENTS" --attribute-names ApproximateNumberOfMessages \
    --query Attributes.ApproximateNumberOfMessages --output text
}

echo "### Part 1: commit, then the instance dies before publishing"
echo "Instance A (publisher off) takes the requests, then is killed with SIGKILL"
start_instance 3021 off; A=$PID
new_wallet 3021 crash; W1="$WALLET"
wager 3021 BET 1 30.00
wager 3021 WIN 2 80.00
wager 3021 LOSS 3 10.00
before="$(queue_count)"
echo "Outbox of wallet $W1 (expect 6 rows, all published = f; LOSS has no WalletBalanceChanged):"
outbox "$W1"
kill -9 "$A"; wait "$A" 2>/dev/null || true
echo "Instance A is dead. Events in the queue so far: $before (this run added none)"
echo
# Events other runs left unpublished (poc:observability runs with the publisher off) are published by B as well.
others="$(sql "select count(*) from outbox_messages where aggregate_id <> '$W1' and published_at is null and failed_at is null")"
echo "Instance B (publisher on) starts and finds the work in the table"
start_instance 3022 on; B=$PID
wait_published "$W1"
outbox "$W1"
echo "Events added to the queue: $(( $(queue_count) - before )) (expect $(( 6 + others )): the 6 above, plus $others left unpublished by earlier runs)"

echo
echo "### Part 2: sent but not marked published (the process died between the send and the commit)"
LAST="$(sql "select id from outbox_messages where aggregate_id = '$W1' order by sequence desc limit 1")"
before="$(queue_count)"
sql "update outbox_messages set published_at = null where id = '$LAST'" >/dev/null
echo "Marked event $LAST as unpublished again; instance B sends it a second time"
wait_published "$W1"
sleep 1
echo "Events added to the queue: $(( $(queue_count) - before )) (expect 0: the event id is the FIFO deduplication id)"
kill "$B"; wait "$B" 2>/dev/null || true

echo
echo "### Part 3: a parked event holds back its own wallet only"
start_instance 3021 off; C=$PID
new_wallet 3021 held; HELD="$WALLET"; HELD_PLAYER="$PLAYER"
wager 3021 BET 1 10.00
wager 3021 BET 2 10.00
new_wallet 3021 free; FREE="$WALLET"
wager 3021 BET 1 10.00
kill "$C"; wait "$C" 2>/dev/null || true
FIRST="$(sql "select id from outbox_messages where aggregate_id = '$HELD' order by sequence limit 1")"
sql "update outbox_messages set failed_at = now(), attempts = 20 where id = '$FIRST'" >/dev/null
echo "Parked the first event of wallet $HELD by hand (what 20 failed sends do)"
start_instance 3022 on; D=$PID
wait_published "$FREE"
sleep 1
echo "The free wallet is fully published; the held wallet is not:"
outbox "$HELD"
echo "Requeue (the operator's statement):"
echo "  update outbox_messages set failed_at = null, attempts = 0, next_attempt_at = null where id = '$FIRST';"
sql "update outbox_messages set failed_at = null, attempts = 0, next_attempt_at = null where id = '$FIRST'" >/dev/null
wait_published "$HELD"
outbox "$HELD"
echo "Instance logs: $LOGS"
