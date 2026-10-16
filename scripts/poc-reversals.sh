#!/usr/bin/env bash
# Hands-on PoC for M5: a REFUND that arrives before its BET is parked as PENDING_REFERENCE, the BET arrives, the
# background worker applies the REFUND; a second reversal of the same BET is refused; a reversal whose reference
# never arrives is rejected after the last retry.
# Needs the Compose services and the app on $BASE_URL with short retry timings, e.g.:
#   PENDING_REFERENCE_POLL_MS=250 PENDING_REFERENCE_BACKOFF_BASE_MS=500 PENDING_REFERENCE_MAX_ATTEMPTS=4 bun run start
# Each run uses fresh ids, so it can be repeated.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN="$(date +%s)-$RANDOM"
PLAYER="poc-player-$RUN"

# send <idempotency-key> <json body>   prints the HTTP status and the body
send() {
  curl -s -w '\n-> HTTP %{http_code}\n' -X POST "$BASE_URL/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: $1" -d "$2"
}

# body <walletId> <externalId> <kind> <amount> [referenceExternalId]
body() {
  local ref=""
  [[ -n "${5:-}" ]] && ref=",\"referenceExternalTransactionId\":\"$5\""
  printf '{"providerId":"poc","externalTransactionId":"%s","playerId":"%s","walletId":"%s","roundId":"r1","gameId":"g1","kind":"%s","money":{"amount":"%s","currency":"BRL"}%s}' \
    "$2" "$PLAYER" "$1" "$3" "$4" "$ref"
}

# wait_settled <key> <body>   replays the request until it is no longer pending (at most 40 s)
wait_settled() {
  local out
  for _ in $(seq 160); do
    out="$(curl -s -X POST "$BASE_URL/wagering/transactions" -H 'content-type: application/json' \
      -H "Idempotency-Key: $1" -d "$2")"
    if ! grep -q '"status":"PENDING_REFERENCE"' <<<"$out"; then echo "$out"; return; fi
    sleep 0.25
  done
  echo "still pending after 40 s: $out"
}

echo "Creating a wallet with 100.00 BRL for $PLAYER"
WALLET_JSON="$(curl -s -X POST "$BASE_URL/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")"
echo "$WALLET_JSON"
W="$(echo "$WALLET_JSON" | sed -E 's/.*"id":"([^"]+)".*/\1/')"

REFUND="$(body "$W" "refund-$RUN" REFUND 30.00 "bet-$RUN")"
echo; echo "### 1. REFUND of bet-$RUN before the BET exists (expect 202 PENDING_REFERENCE, no balance)"
send "poc:refund-$RUN" "$REFUND"
echo; echo "### 2. The same REFUND again (expect 202, idempotentReplay true)"
send "poc:refund-$RUN" "$REFUND"
echo; echo "### 3. The BET arrives (expect 200 PROCESSED, balance 70.00)"
send "poc:bet-$RUN" "$(body "$W" "bet-$RUN" BET 30.00)"
echo; echo "### 4. Wait for the worker, then replay the REFUND (expect PROCESSED, balance 100.00)"
wait_settled "poc:refund-$RUN" "$REFUND"
echo; echo "### 5. ROLLBACK of the same BET (expect 422 REJECTED ALREADY_REVERSED: one reversal per transaction)"
send "poc:rollback-$RUN" "$(body "$W" "rollback-$RUN" ROLLBACK 30.00 "bet-$RUN")"

ORPHAN="$(body "$W" "orphan-$RUN" REFUND 5.00 "never-$RUN")"
echo; echo "### 6. REFUND of a transaction that never arrives (expect 202 now)"
send "poc:orphan-$RUN" "$ORPHAN"
echo; echo "### 7. After the last retry (expect the replay to answer 422 REJECTED REFERENCE_NOT_FOUND, balance 100.00)"
wait_settled "poc:orphan-$RUN" "$ORPHAN"

echo
echo "### Ledger of the wallet (expect: opening CREDIT 100.00, DEBIT 30.00, CREDIT 30.00; final balance 100.00)"
docker compose exec -T postgres psql -U wagering -d wagering -c \
  "select sequence, direction, amount, balance_before, balance_after from ledger_entries where wallet_id = '$W' order by sequence"
echo "### Events published for the pending transactions (outbox)"
docker compose exec -T postgres psql -U wagering -d wagering -c \
  "select event_type, count(*) from outbox_messages where aggregate_id = '$W' group by 1 order by 1"
