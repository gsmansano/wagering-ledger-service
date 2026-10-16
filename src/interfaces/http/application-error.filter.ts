import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { IdempotencyConflictError } from '../../application/transaction/idempotency-conflict.error';
import { WalletAlreadyExistsError } from '../../application/wallet/wallet-already-exists.error';
import { WalletNotFoundError } from '../../application/wallet/wallet-not-found.error';
import { InvalidInputError } from '../../domain/shared/invalid-input-error';
import { isTransientDatabaseError } from '../../infrastructure/database/transient-errors';

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
  setHeader(name: string, value: string): void;
}

// The status table of decision #43, applied to every endpoint:
//   400 invalid payload: malformed (HttpException from request-parsing) or well-formed but invalid (InvalidInputError)
//   404 unknown wallet or transaction
//   409 conflict: duplicate wallet, idempotency key or provider transaction reused with another payload
//   503 transient infrastructure failure (decision #44), with Retry-After
//   500 anything else: programming errors are never reported as the provider's fault, and never leak their message
// 200, 201, 202 and the 422 business rejection are not errors; the controllers answer them.
const RETRY_AFTER_SECONDS = '1';

@Catch()
export class ApplicationErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApplicationErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
    } else if (error instanceof WalletNotFoundError) {
      response.status(404).json({ error: 'WALLET_NOT_FOUND', message: error.message });
    } else if (error instanceof WalletAlreadyExistsError) {
      response.status(409).json({ error: 'WALLET_ALREADY_EXISTS', message: error.message });
    } else if (error instanceof IdempotencyConflictError) {
      response.status(409).json({ error: 'IDEMPOTENCY_CONFLICT', message: error.message });
    } else if (error instanceof InvalidInputError) {
      response.status(400).json({ error: 'INVALID_PAYLOAD', message: error.message });
    } else if (isTransientDatabaseError(error)) {
      this.logger.warn(`Transient failure: ${error instanceof Error ? error.message : String(error)}`);
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
      response
        .status(503)
        .json({ error: 'TRANSIENT_FAILURE', message: 'The service is temporarily unavailable; retry the same request' });
    } else {
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      response.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
    }
  }
}
