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
