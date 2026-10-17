export const WAGER_QUEUE = 'wager-transactions.fifo';
export const WAGER_DLQ = 'wager-transactions-dlq.fifo';
/** Integration events written to the outbox (decision #57). Consumers outside this service read it. */
export const EVENTS_QUEUE = 'wager-events.fifo';
