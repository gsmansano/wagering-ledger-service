/** No transaction matches the lookup (HTTP 404 at the edge). */
export class TransactionNotFoundError extends Error {
  constructor(lookup: string) {
    super(`Transaction ${lookup} not found`);
    this.name = 'TransactionNotFoundError';
  }
}
