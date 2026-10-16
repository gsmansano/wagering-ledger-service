import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { UnresolvedConflictError } from '../../src/application/transaction/unresolved-conflict.error';
import { WalletVersionConflictError } from '../../src/application/wallet/wallet-version-conflict.error';
import { DomainError } from '../../src/domain/shared/domain-error';
import { InvalidInputError } from '../../src/domain/shared/invalid-input-error';
import { InvalidTransactionStateError } from '../../src/domain/transaction/invalid-transaction-state-error';

// Throws each kind of error from inside the real app, so the global filter is exercised exactly as in production.
@Controller('test-errors')
class ThrowingController {
  @Get('invalid-input')
  invalidInput(): never {
    throw new InvalidInputError('amount is malformed');
  }

  @Get('domain-bug')
  domainBug(): never {
    throw new DomainError('secret internal detail');
  }

  @Get('invalid-transition')
  invalidTransition(): never {
    throw new InvalidTransactionStateError('PROCESSED', 'REJECTED');
  }

  @Get('unresolved-conflict')
  unresolvedConflict(): never {
    throw new UnresolvedConflictError('provider-1', 'key-1');
  }

  @Get('version-conflict')
  versionConflict(): never {
    throw new WalletVersionConflictError('wallet-1', 3);
  }
}

describe('HTTP error mapping (real app)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowingController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports invalid input as 422 INVALID_PAYLOAD, the provider can fix it', async () => {
    const res = await fetch(`${baseUrl}/test-errors/invalid-input`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'INVALID_PAYLOAD', message: 'amount is malformed' });
  });

  it.each(['domain-bug', 'invalid-transition', 'unresolved-conflict', 'version-conflict'])(
    'reports %s as 500 without leaking its message: programming errors are not the provider\'s fault',
    async (path) => {
      const res = await fetch(`${baseUrl}/test-errors/${path}`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('secret internal detail');
      expect(text).not.toContain('PROCESSED');
      expect(text).not.toContain('provider-1');
    },
  );
});
