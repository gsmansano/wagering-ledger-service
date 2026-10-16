import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { IdempotencyConflictError } from '../../application/transaction/idempotency-conflict.error';
import { UnsupportedKindError } from '../../application/transaction/unsupported-kind.error';
import { WalletAlreadyExistsError } from '../../application/wallet/wallet-already-exists.error';
import { WalletNotFoundError } from '../../application/wallet/wallet-not-found.error';
import { DomainError } from '../../domain/shared/domain-error';

interface JsonResponse {
  status(code: number): { json(body: unknown): void };
}

// Minimal mapping for M4; the complete, consistent table is logged in M6.
//   400 malformed request (thrown by request-parsing: missing header, field missing or not a string)
//   404 unknown wallet
//   409 conflict: duplicate wallet, idempotency key or provider transaction reused with another payload
//   422 well-formed but invalid: bad amount, OPENING from outside, wrong player, kind not supported yet
// A business rejection (REJECTED) is not an error: it is a 200 whose body carries the failure code (provisional, M6).
function describe(error: Error): { status: number; code: string } {
  if (error instanceof WalletNotFoundError) return { status: 404, code: 'WALLET_NOT_FOUND' };
  if (error instanceof WalletAlreadyExistsError) return { status: 409, code: 'WALLET_ALREADY_EXISTS' };
  if (error instanceof IdempotencyConflictError) return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
  if (error instanceof UnsupportedKindError) return { status: 422, code: 'UNSUPPORTED_KIND' };
  return { status: 422, code: 'INVALID_PAYLOAD' }; // DomainError
}

@Catch(WalletNotFoundError, WalletAlreadyExistsError, IdempotencyConflictError, UnsupportedKindError, DomainError)
export class ApplicationErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const { status, code } = describe(error);
    host.switchToHttp().getResponse<JsonResponse>().status(status).json({ error: code, message: error.message });
  }
}
