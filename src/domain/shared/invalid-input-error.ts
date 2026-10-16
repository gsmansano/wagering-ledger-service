import { DomainError } from './domain-error';

/**
 * The caller supplied something the domain refuses: a malformed amount, an empty identifier, a reference rule
 * broken at creation. The caller can fix it and resend, so the edge reports it as a client error (422). Any other
 * DomainError (an invalid state transition, a broken invariant) is a bug in our code and stays a server error.
 */
export class InvalidInputError extends DomainError {}
