#!/usr/bin/env bash
# Hands-on PoC for M7: send messages to the FIFO queue with the AWS CLI and watch the ledger change. A BET message
# is applied once; the same message sent again changes nothing (inbox); a malformed message and a message for an
# unknown wallet go to the dead-letter queue with the reason attached.
# Needs the Compose services and the app on $BASE_URL (bun run start). Without the `aws` CLI on the host it runs
# the amazon/aws-cli image instead. Each run uses fresh ids, so it can be repeated.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"
RUN="$(date +%s)-$RANDOM"
PLAYER="poc-player-$RUN"

aws_cli() {
  if command -v aws >/dev/null; then
    AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 aws --endpoint-url "$ENDPOINT" "$@"
  else
    docker run --rm --network host -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
      -e AWS_DEFAULT_REGION=us-east-1 amazon/aws-cli --endpoint-url "$ENDPOINT" "$@"
  fi
}

QUEUE="$(aws_cli sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)"
DLQ="$(aws_cli sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)"

# message <messageId> <walletId> <externalId> <amount>   prints a WagerTransactionRequested body
message() {
  printf '{"messageId":"%s","type":"WagerTransactionRequested","occurredAt":"%s","data":{"providerId":"poc","externalTransactionId":"%s","idempotencyKey":"poc:%s","playerId":"%s","walletId":"%s","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"%s","currency":"BRL"}}}' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$3" "$3" "$PLAYER" "$2" "$4"
}

# send <groupId> <body>   the group is the wallet (messages of one wallet stay in order); FIFO needs a dedup id
send() {
  aws_cli sqs send-message --queue-url "$QUEUE" --message-group-id "$1" \
    --message-deduplication-id "dedup-$RANDOM-$RANDOM-$(date +%s%N)" --message-body "$2" \
    --query MessageId --output text | sed 's/^/  sent, SQS message id /'
}

balance() { curl -s "$BASE_URL/wallets/$1" | sed -E 's/.*"balance":\{"amount":"([^"]+)".*/\1/'; }

# wait_balance <walletId> <expected>   polls the HTTP API for up to 20 s
wait_balance() {
  for _ in $(seq 40); do
    [[ "$(balance "$1")" == "$2" ]] && { echo "  balance is $2"; return; }
    sleep 0.5
  done
  echo "  balance is still $(balance "$1"), expected $2"
}

# dead_letters <marker>   lists the messages in the DLQ whose body contains the marker, with their error code
dead_letters() {
  for _ in 1 2 3 4; do
    aws_cli sqs receive-message --queue-url "$DLQ" --max-number-of-messages 10 --visibility-timeout 0 \
      --wait-time-seconds 2 --message-attribute-names All \
      --query 'Messages[].[MessageAttributes.ErrorCode.StringValue, MessageAttributes.ErrorReason.StringValue, Body]' \
      --output text 2>/dev/null | grep -F "$1" | sed 's/^/  DLQ: /' | head -1 && return
  done
  echo "  nothing for $1 in the DLQ"
}

echo "Creating a wallet with 100.00 BRL for $PLAYER"
WALLET_JSON="$(curl -s -X POST "$BASE_URL/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")"
W="$(echo "$WALLET_JSON" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
echo "  wallet $W"

BET="$(message "msg-$RUN" "$W" "bet-$RUN" 30.00)"
echo; echo "### 1. A BET of 30.00 arrives as a queue message (expect balance 70.00)"
send "$W" "$BET"
wait_balance "$W" 70.00

echo; echo "### 2. The same message is delivered again (expect balance still 70.00, one inbox row)"
send "$W" "$BET"
sleep 3
echo "  balance is $(balance "$W")"
docker compose exec -T postgres psql -U wagering -d wagering -c \
  "select consumer_name, message_id, processed_at is not null as processed from inbox_messages where message_id = 'msg-$RUN'"

echo; echo "### 3. A message that is not valid JSON (expect it in the DLQ as InvalidMessageError, received once)"
send "$W" "{\"poc\":\"$RUN\" this is not json"
dead_letters "$RUN"

echo; echo "### 4. A BET for a wallet that does not exist (expect it in the DLQ as WalletNotFoundError)"
send "$W" "$(message "msg-ghost-$RUN" "0192f291-27dd-7d3f-8071-5f8685deef37" "ghost-$RUN" 10.00)"
dead_letters "ghost-$RUN"

echo
echo "### Ledger of the wallet (expect: opening CREDIT 100.00, one DEBIT 30.00; final balance 70.00)"
docker compose exec -T postgres psql -U wagering -d wagering -c \
  "select sequence, direction, amount, balance_before, balance_after from ledger_entries where wallet_id = '$W' order by sequence"
