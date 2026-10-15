/** Base class for business-rule violations raised by the domain layer. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
