// Hands-on tour of the domain model. Run with: bun run poc:domain
// Needs no database or Docker. Extended as each domain class lands.
import { DomainError } from '../src/domain/domain-error';
import { Money } from '../src/domain/money';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';

function section(title: string): void {
  console.log(`\n== ${title}`);
}

function attempt(label: string, fn: () => unknown): void {
  try {
    console.log(`${label.padEnd(34)} -> ${String(fn())}`);
  } catch (error) {
    const kind = error instanceof DomainError ? (error as Error).name : 'UNEXPECTED';
    console.log(`${label.padEnd(34)} -> ${kind}: ${(error as Error).message}`);
  }
}

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

section('Why not floats');
console.log(`number:  0.1 + 0.2 = ${0.1 + 0.2}`);
console.log(`Money:   0.10 + 0.20 = ${brl('0.10').add(brl('0.20'))}`);

section('Scale is always 2');
attempt('"25.5" serializes as', () => JSON.stringify(brl('25.5')));
attempt('"25.5" equals "25.50"', () => brl('25.5').equals(brl('25.50')));

section('Invalid input is rejected');
for (const amount of ['', 'NaN', 'Infinity', '1e3', '-1.00', '1.234', '.5']) {
  attempt(`from(${JSON.stringify(amount)})`, () => brl(amount));
}

section('Currencies never mix');
const usd = Money.from({ amount: '1.00', currency: 'USD' });
attempt('BRL 1.00 + USD 1.00', () => brl('1.00').add(usd));
attempt('BRL 1.00 equals USD 1.00', () => brl('1.00').equals(usd));

section('Immutability');
const original = brl('10.00');
const sum = original.add(brl('5.00'));
console.log(`original = ${original}, sum = ${sum}`);

section('Wallet: debit and credit return the ledger entry');
const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: new Date() });
const show = () => `balance=${wallet.balance} version=${wallet.version}`;
console.log(`opened:      ${show()}`);
const debitEntry = wallet.debit({ entryId: 'e1', transactionId: 't1', money: brl('30.00'), now: new Date() });
console.log(`debit 30:    ${show()}  entry: ${debitEntry.balanceBefore} -> ${debitEntry.balanceAfter}`);
const creditEntry = wallet.credit({ entryId: 'e2', transactionId: 't2', money: brl('5.50'), now: new Date() });
console.log(`credit 5.50: ${show()}  entry: ${creditEntry.balanceBefore} -> ${creditEntry.balanceAfter}`);

section('Wallet: refusals leave the wallet untouched');
const before = show();
attempt('debit 500 (more than balance)', () => wallet.debit({ entryId: 'e3', transactionId: 't3', money: brl('500.00'), now: new Date() }));
attempt('credit USD 1.00 to a BRL wallet', () => wallet.credit({ entryId: 'e4', transactionId: 't4', money: usd, now: new Date() }));
attempt('debit 0.00', () => wallet.debit({ entryId: 'e5', transactionId: 't5', money: Money.zero('BRL'), now: new Date() }));
console.log(`unchanged:   ${before === show()} (${show()})`);

section('Ledger entry: unbalanced arithmetic is refused');
attempt('100.00 - 30.00 = 80.00 ?', () =>
  WalletLedgerEntry.create({
    id: 'e9', walletId: 'w1', transactionId: 't9', direction: LedgerDirection.Debit,
    money: brl('30.00'), balanceBefore: brl('100.00'), balanceAfter: brl('80.00'), createdAt: new Date(),
  }),
);
