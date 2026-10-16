import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HealthController } from '../health.controller';
import { WageringController } from '../wagering.controller';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC } from './public.decorator';

const contextOf = (controller: abstract new (...args: never[]) => unknown, handler: string): ExecutionContext =>
  ({
    getClass: () => controller,
    getHandler: () => (controller.prototype as Record<string, () => unknown>)[handler],
  }) as unknown as ExecutionContext; // only the two accessors the guard uses are needed

describe('AuthGuard (no-op extension point)', () => {
  const guard = new AuthGuard(new Reflector());

  it('lets every request through for now, public or not', () => {
    expect(guard.canActivate(contextOf(HealthController, 'live'))).toBe(true);
    expect(guard.canActivate(contextOf(WageringController, 'submit'))).toBe(true);
  });

  it('marks the health endpoints public, and the wagering endpoints not', () => {
    const reflector = new Reflector();
    expect(reflector.get(IS_PUBLIC, HealthController)).toBe(true);
    expect(reflector.get(IS_PUBLIC, WageringController)).toBeUndefined();
  });
});
