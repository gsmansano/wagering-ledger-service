import { Logger } from '@nestjs/common';
import { IdempotencyConflictError } from '../../application/transaction/idempotency-conflict.error';
import { InboxPayloadConflictError } from '../../application/transaction/inbox-payload-conflict.error';
import type { ProcessWagerTransaction } from '../../application/transaction/process-wager-transaction';
import { WalletLockTimeoutError } from '../../application/wallet/wallet-lock-timeout.error';
import { WalletNotFoundError } from '../../application/wallet/wallet-not-found.error';
import { InvalidInputError } from '../../domain/shared/invalid-input-error';
import { exponentialBackoffMs } from '../../domain/shared/backoff';
import type { MessageDisposition } from './message-disposition';
import { InvalidMessageError, parseWagerTransactionMessage } from './wager-transaction-message';

/** Inbox owner of this consumer: dedup is per consumer, so a second consumer of the same queue would use its own. */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export interface RetryBackoff {
  baseMs: number;
  capMs: number;
}

const MAX_REASON_LENGTH = 1_000;

/**
 * A message that timed out waiting for its wallet's lock is retried four times later than other transient failures
 * (decision #66): the wallet is busy, and coming back sooner only joins the queue again. It still counts towards the
 * queue's receive limit.
 */
const LOCK_TIMEOUT_BACKOFF_FACTOR = 4;

/**
 * Runs one queue message through the same use case as the HTTP endpoint and classifies the outcome (decision
 * #52). It never throws: every error becomes a disposition, so the consumer only has to apply it.
 * Retrying cannot fix a permanent error and acknowledging it would lose it; an unknown error is more likely a
 * bug than bad input, so it is retried a bounded number of times before the redrive policy parks it.
 */
export class WagerMessageHandler {
  private readonly logger = new Logger(WagerMessageHandler.name);

  constructor(
    private readonly processTransaction: ProcessWagerTransaction,
    private readonly backoff: RetryBackoff,
  ) {}

  async handle(body: string, receiveCount: number): Promise<MessageDisposition> {
    try {
      const message = parseWagerTransactionMessage(body);
      const result = await this.processTransaction.execute(message.command, {
        consumerName: WAGER_CONSUMER_NAME,
        messageId: message.messageId,
      });
      const { command } = message;
      if ('duplicateMessage' in result) {
        this.logger.log(
          { event: 'message_duplicate', messageId: message.messageId, correlationId: command.correlationId, walletId: command.walletId, providerId: command.providerId },
          'Message already processed',
        );
      } else {
        const { id, status, failureCode } = result.transaction;
        this.logger.log(
          {
            event: result.idempotentReplay ? 'transaction_replayed' : 'transaction_settled',
            messageId: message.messageId,
            correlationId: command.correlationId,
            transactionId: id,
            walletId: command.walletId,
            providerId: command.providerId,
            kind: command.kind,
            status,
            failureCode,
          },
          'Message processed',
        );
      }
      // A rejection or a pending reversal is a business result, already persisted: nothing left to retry.
      return { kind: 'ack', outcome: 'duplicateMessage' in result ? 'duplicate' : 'processed' };
    } catch (error) {
      return this.classify(error, receiveCount);
    }
  }

  private classify(error: unknown, receiveCount: number): MessageDisposition {
    if (isPermanent(error)) {
      const err = error as Error; // every permanent class extends Error
      return { kind: 'dead-letter', code: err.name, reason: err.message.slice(0, MAX_REASON_LENGTH) };
    }
    // Transient database errors and unknown ones: same treatment, the difference is only in the log line.
    const attempt = Math.max(1, receiveCount);
    const factor = error instanceof WalletLockTimeoutError ? LOCK_TIMEOUT_BACKOFF_FACTOR : 1;
    const delayMs = Math.min(exponentialBackoffMs(attempt, this.backoff.baseMs, this.backoff.capMs) * factor, this.backoff.capMs);
    return { kind: 'retry', delayMs, cause: error };
  }
}

function isPermanent(error: unknown): boolean {
  return (
    error instanceof InvalidMessageError ||
    error instanceof InvalidInputError ||
    error instanceof WalletNotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxPayloadConflictError
  );
}
