// Optional prefix, so a run that must not share queues with a development stack (the multi-instance tests) gets
// its own. Empty by default.
const prefix = process.env.SQS_QUEUE_PREFIX ?? '';

export const WAGER_QUEUE = `${prefix}wager-transactions.fifo`;
export const WAGER_DLQ = `${prefix}wager-transactions-dlq.fifo`;
/** Integration events written to the outbox (decision #57). Consumers outside this service read it. */
export const EVENTS_QUEUE = `${prefix}wager-events.fifo`;
