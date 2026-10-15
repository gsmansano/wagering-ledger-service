// Hands-on tour of the domain model. Run with: bun run poc:domain
// Needs no database or Docker. Extended as each domain class lands.
import { DomainError } from '../src/domain/domain-error';
import { Money } from '../src/domain/money';

function section(title: string): void {
  console.log(`\n== ${title}`);
}

function attempt(label: string, fn: () => unknown): void {
  try {
    console.log(`${label.padEnd(34)} -> ${String(fn())}`);
  } catch (error) {
    const kind = error instanceof DomainError ? 'DomainError' : 'UNEXPECTED';
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
