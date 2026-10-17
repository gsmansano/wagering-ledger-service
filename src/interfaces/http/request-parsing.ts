import { BadRequestException } from '@nestjs/common';

// Structural checks only: is a field there and is it a string. Business validation (amount format, kind rules,
// ownership) lives in the domain and the use cases, and maps to a different status (see ApplicationErrorFilter).

export function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException({ error: 'MALFORMED_REQUEST', message: `${name} must be a JSON object` });
  }
  return value as Record<string, unknown>; // narrowed to a non-null, non-array object just above
}

export function requiredString(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'MALFORMED_REQUEST', message: `${name} is required and must be a string` });
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException({ error: 'MALFORMED_REQUEST', message: `${name} must be a string` });
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id that is stored in a `uuid` column: anything else would reach PostgreSQL as a cast error and become a 500. */
export function requiredUuid(source: Record<string, unknown>, name: string): string {
  const value = requiredString(source, name);
  return asUuid(value, name);
}

export function asUuid(value: string, name: string): string {
  if (!UUID.test(value)) {
    throw new BadRequestException({ error: 'MALFORMED_REQUEST', message: `${name} must be a UUID` });
  }
  return value;
}

const CORRELATION_ID = /^[\w.:-]{1,128}$/;

/** A caller-supplied correlation id is used only when it is short and plain; otherwise a new one is generated. */
export function correlationIdFrom(header: string | undefined): string | undefined {
  return header !== undefined && CORRELATION_ID.test(header) ? header : undefined;
}

/**
 * The id the request log line carries (`genReqId` in `logger-params.ts` applies `correlationIdFrom` or generates one),
 * so the events written by the use case and the request line share one id. Without the logger there is none, and the
 * use case generates its own.
 */
export function requestCorrelationId(req: { id?: unknown }): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}
