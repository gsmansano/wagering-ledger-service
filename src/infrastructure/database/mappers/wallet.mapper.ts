import { Money } from '../../../domain/shared/money';
import { Wallet } from '../../../domain/wallet/wallet';
import type { WalletRow } from '../rows/wallet.row';

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function rowToWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
