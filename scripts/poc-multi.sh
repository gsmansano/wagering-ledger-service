#!/usr/bin/env bash
# Hands-on PoC for M9: several instances share the same wallets, one is killed mid-load, and the books still balance.
#   1. Three app instances (ports 3031 to 3033) start against the same database and queues.
#   2. A mixed load (bets, wins, losses, overdrafts, every third request sent twice) is spread over them.
#   3. Once part of the load is done, instance B is killed with SIGKILL. Requests that cannot reach it are resent with
#      the same Idempotency-Key to another instance, as a provider would.
#   4. When everything is settled, the script prints, per wallet, the stored balance next to the sum of its ledger.
# Starts and stops its own instances on the host, so the Compose `app` must not be running. Needs the Compose services:
#   docker compose up -d postgres ministack migrate
# Each run uses fresh ids, so it can be repeated. The wallets stay in the development database.
set -euo pipefail

RUN="$(date +%s)-$RANDOM"
DIR="$(mktemp -d)"
PORTS=(3031 3032 3033)
REQUESTS=120
WALLETS=4
PIDS=()
psql_() { docker compose exec -T postgres psql -U wagering -d wagering "$@"; }
sql() { psql_ -At -c "$1"; }

if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  echo "The Compose app is running and would take part in the load. Stop it first: docker compose stop app" >&2
  exit 1
fi

cleanup() { for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

start_instance() { # <index>
  local port="${PORTS[$1]}"
  PORT="$port" OUTBOX_POLL_MS=250 PENDING_REFERENCE_POLL_MS=500 SQS_WAIT_TIME_SECONDS=2 \
    bun src/main.ts >"$DIR/instance-$1.log" 2>&1 &
  PIDS[$1]=$!
  disown "${PIDS[$1]}" # so bash does not print a notice when the instance is killed on purpose
  for _ in $(seq 80); do
    curl -sf "http://localhost:$port/health/ready" >/dev/null && return
    sleep 0.5
  done
  echo "Instance $1 on port $port did not become ready; see $DIR/instance-$1.log" >&2
  exit 1
}

echo "### 1. Starting ${#PORTS[@]} instances against the same database and queues"
for i in "${!PORTS[@]}"; do start_instance "$i"; done
echo "  ports: ${PORTS[*]}"

echo
echo "### 2. Opening $WALLETS wallets with 500.00 each"
for k in $(seq 0 $((WALLETS - 1))); do
  player="poc-multi-$RUN-$k"
  id="$(curl -s -X POST "http://localhost:${PORTS[0]}/wallets" -H 'content-type: application/json' \
    -d "{\"playerId\":\"$player\",\"initialBalance\":{\"amount\":\"500.00\",\"currency\":\"BRL\"}}" |
    sed -E 's/.*"id":"([^"]+)".*/\1/')"
  echo "$id $player" >"$DIR/wallet-$k"
  echo "  wallet $k: $id"
done

# send <n> <first port index> <label>   one request (BET, WIN or LOSS) for wallet n % WALLETS; resent with the same key,
# on the next port, while the answer is not a final one (200, 202, 422). Appends "<label> <port> <wallet> <code>" to the results.
send() {
  local n="$1" first="$2" label="$3" k=$(($1 % WALLETS)) kind amount id player
  read -r id player <"$DIR/wallet-$k"
  case $((n % 5)) in 3) kind=WIN ;; 4) kind=LOSS ;; *) kind=BET ;; esac
  amount="$((20 + (n % 7) * 15)).00"
  for attempt in $(seq 0 40); do
    local port="${PORTS[$(((first + attempt) % ${#PORTS[@]}))]}" code
    code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST "http://localhost:$port/wagering/transactions" \
      -H 'content-type: application/json' -H "Idempotency-Key: poc:$RUN-$n" \
      -d "{\"providerId\":\"poc\",\"externalTransactionId\":\"$RUN-$n\",\"playerId\":\"$player\",\"walletId\":\"$id\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"$kind\",\"money\":{\"amount\":\"$amount\",\"currency\":\"BRL\"}}" || true)"
    if [[ "$code" == 200 || "$code" == 202 || "$code" == 422 ]]; then
      echo "$label $port $k $code" >>"$DIR/results"
      return
    fi
    sleep 0.3
  done
  echo "$label - $k giveup" >>"$DIR/results"
}
export -f send
export DIR RUN WALLETS
export PORTS_CSV="${PORTS[*]}"
touch "$DIR/results"

echo
echo "### 3. Sending $REQUESTS requests (every third one twice, to another instance), 12 at a time"
# bash -c re-creates the PORTS array in each worker from PORTS_CSV.
worker='IFS=" " read -r -a PORTS <<<"$PORTS_CSV"; n="${1%%:*}"; rest="${1#*:}"; send "$n" "${rest%%:*}" "${rest#*:}"'
{
  for n in $(seq 1 "$REQUESTS"); do
    echo "$n:$((n % 3)):first"
    ((n % 3 == 0)) && echo "$n:$(((n + 1) % 3)):duplicate"
  done
} | xargs -P 12 -I{} bash -c "$worker" _ {} &
LOAD=$!

# Kill instance B (index 1) once a third of the requests are done: a condition, not a timer.
until [[ "$(wc -l <"$DIR/results")" -ge $((REQUESTS / 3)) ]]; do sleep 0.1; done
echo "### 4. $(wc -l <"$DIR/results") answers so far: killing instance B (port ${PORTS[1]}) with SIGKILL"
kill -9 "${PIDS[1]}"
wait "$LOAD"
echo "  all requests answered; $(grep -c . "$DIR/results") deliveries, $(grep -c giveup "$DIR/results" || true) given up"

echo
echo "### 5. Waiting until nothing is pending and every event is published"
settled() {
  [[ "$(sql "select count(*) from wager_transactions where status in ('PENDING','PENDING_REFERENCE')
                and external_transaction_id like '$RUN-%'")" == 0 ]] &&
  [[ "$(sql "select count(*) from outbox_messages o join wallets w on w.id = o.aggregate_id
              where w.player_id like 'poc-multi-$RUN-%' and o.published_at is null")" == 0 ]]
}
for _ in $(seq 120); do settled && break; sleep 0.5; done
settled || { echo "  not settled in time; instance logs are in $DIR" >&2; exit 1; }
echo "  settled"

echo
echo "### Answers by instance (port) and by wallet: the instances shared the wallets"
awk '$2 != "-" {print $2, "wallet " $3}' "$DIR/results" | sort | uniq -c | sort -k2,2 -k4,4 | sed 's/^/  /'
echo
echo "### Outcome of the distinct transactions (the resent duplicates created no extra rows)"
psql_ -c "select status, count(*) from wager_transactions where external_transaction_id like '$RUN-%' group by status order by status"
echo "  distinct requests sent: $REQUESTS"
echo
echo "### balance == ledger, per wallet"
psql_ -c "select right(w.id::text, 6) as wallet, w.balance as stored_balance,
                 coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0) as ledger_sum,
                 count(e.id) as entries,
                 w.balance = coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0) as consistent
            from wallets w left join ledger_entries e on e.wallet_id = w.id
           where w.player_id like 'poc-multi-$RUN-%' group by w.id order by w.player_id"
echo "### The same check through the API (POST /wallets/:id/reconciliation), on a surviving instance"
for k in $(seq 0 $((WALLETS - 1))); do
  read -r id _ <"$DIR/wallet-$k"
  curl -s -X POST "http://localhost:${PORTS[0]}/wallets/$id/reconciliation"; echo
done
echo
echo "Logs of the instances: $DIR"
