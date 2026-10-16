#!/usr/bin/env bash
# Hands-on PoC for M4: create a wallet, BET, duplicate BET, overdraft, then a burst of parallel duplicates.
# Needs the app on $BASE_URL (default http://localhost:3000): `bun run start` after `docker compose up -d`.
# Each run uses fresh ids, so it can be repeated.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN="$(date +%s)-$RANDOM"
PLAYER="poc-player-$RUN"

# call <title> <method path> <idempotency-key|-> <json body>   prints status and body
call() {
  local title="$1" path="$2" key="$3" body="$4"
  local headers=(-H 'content-type: application/json')
  [[ "$key" != "-" ]] && headers+=(-H "Idempotency-Key: $key")
  echo
  echo "### $title"
  curl -s -w '\n-> HTTP %{http_code}\n' -X POST "$BASE_URL$path" "${headers[@]}" -d "$body"
}

bet_body() { # <walletId> <externalId> <amount>
  printf '{"providerId":"poc","externalTransactionId":"%s","playerId":"%s","walletId":"%s","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"%s","currency":"BRL"}}' "$2" "$PLAYER" "$1" "$3"
}

echo "Creating a wallet with 100.00 BRL for $PLAYER"
WALLET_JSON="$(curl -s -X POST "$BASE_URL/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")"
echo "$WALLET_JSON"
WALLET_ID="$(echo "$WALLET_JSON" | sed -E 's/.*"id":"([^"]+)".*/\1/')"

call "1. BET 30.00 (expect PROCESSED, balance 70.00, idempotentReplay false)" /wagering/transactions "poc:bet-$RUN-1" "$(bet_body "$WALLET_ID" "bet-$RUN-1" 30.00)"
call "2. The same BET again (expect the same transactionId, balance 70.00, idempotentReplay true)" /wagering/transactions "poc:bet-$RUN-1" "$(bet_body "$WALLET_ID" "bet-$RUN-1" 30.00)"
call "3. Same key, different amount (expect 409 IDEMPOTENCY_CONFLICT)" /wagering/transactions "poc:bet-$RUN-1" "$(bet_body "$WALLET_ID" "bet-$RUN-1" 31.00)"
call "4. Overdraft: BET 500.00 (expect HTTP 422, REJECTED INSUFFICIENT_FUNDS, balance still 70.00)" /wagering/transactions "poc:bet-$RUN-2" "$(bet_body "$WALLET_ID" "bet-$RUN-2" 500.00)"
call "5. Missing Idempotency-Key (expect 400)" /wagering/transactions - "$(bet_body "$WALLET_ID" "bet-$RUN-3" 1.00)"
call "6. Unknown wallet (expect 404)" /wagering/transactions "poc:bet-$RUN-4" "$(bet_body 00000000-0000-4000-8000-000000000000 "bet-$RUN-4" 1.00)"

echo
echo "### 7. 30 parallel copies of one BET of 10.00 (expect exactly one idempotentReplay:false)"
BODY="$(bet_body "$WALLET_ID" "bet-$RUN-5" 10.00)"
OUT="$(mktemp)"
seq 30 | xargs -P 30 -I{} curl -s -X POST "$BASE_URL/wagering/transactions" \
  -H 'content-type: application/json' -H "Idempotency-Key: poc:bet-$RUN-5" -d "$BODY" > "$OUT"
echo "first deliveries : $(grep -o '"idempotentReplay":false' "$OUT" | wc -l)"
echo "replays          : $(grep -o '"idempotentReplay":true' "$OUT" | wc -l)"
rm -f "$OUT"

echo
echo "### Ledger of the wallet (expect: opening CREDIT 100.00, DEBIT 30.00, DEBIT 10.00; final balance 60.00)"
docker compose exec -T postgres psql -U wagering -d wagering -c \
  "select direction, amount, balance_before, balance_after from ledger_entries where wallet_id = '$WALLET_ID' order by created_at, id;" \
  -c "select balance, version from wallets where id = '$WALLET_ID';"
