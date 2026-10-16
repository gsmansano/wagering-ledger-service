import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind } from '../../domain/transaction/wager-transaction';
import { InvalidMessageError, parseWagerTransactionMessage } from './wager-transaction-message';

const valid = () => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: 'player-1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

const parse = (value: unknown) => parseWagerTransactionMessage(JSON.stringify(value));

describe('parseWagerTransactionMessage', () => {
  it('maps the spec message to a command, using the message id as correlation id', () => {
    const message = parse(valid());
    expect(message.messageId).toBe('msg-123');
    expect(message.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
    expect(message.command).toEqual({
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: undefined,
      correlationId: 'msg-123',
    });
  });

  it('keeps the optional reference', () => {
    const body = valid();
    Object.assign(body.data, { kind: 'REFUND', referenceExternalTransactionId: 'bet-1' });
    expect(parse(body).command.referenceExternalTransactionId).toBe('bet-1');
  });

  const broken: [string, (m: ReturnType<typeof valid>) => unknown][] = [
    ['unknown type', (m) => ({ ...m, type: 'Other' })],
    ['missing type', ({ type: _type, ...m }) => m],
    ['missing messageId', ({ messageId: _id, ...m }) => m],
    ['blank messageId', (m) => ({ ...m, messageId: '  ' })],
    ['invalid occurredAt', (m) => ({ ...m, occurredAt: 'yesterday' })],
    ['data not an object', (m) => ({ ...m, data: 'x' })],
    ['unknown kind', (m) => ({ ...m, data: { ...m.data, kind: 'TIP' } })],
    ['walletId not a UUID', (m) => ({ ...m, data: { ...m.data, walletId: 'w-1' } })],
    ['missing idempotencyKey', (m) => ({ ...m, data: { ...m.data, idempotencyKey: undefined } })],
    ['amount not a string', (m) => ({ ...m, data: { ...m.data, money: { amount: 25, currency: 'BRL' } } })],
    ['money missing', (m) => ({ ...m, data: { ...m.data, money: undefined } })],
    ['non-string reference', (m) => ({ ...m, data: { ...m.data, referenceExternalTransactionId: 1 } })],
    ['an array body', () => []],
    ['a null body', () => null],
  ];
  for (const [name, mutate] of broken) {
    it(`rejects ${name} as an invalid message`, () => {
      expect(() => parse(mutate(valid()))).toThrow(InvalidMessageError);
    });
  }

  it('rejects a body that is not JSON', () => {
    expect(() => parseWagerTransactionMessage('{oops')).toThrow(InvalidMessageError);
  });
});
