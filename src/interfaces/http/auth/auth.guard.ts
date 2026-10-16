import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';

/**
 * The authentication extension point (spec §2, decision #49). It is global and currently lets every request
 * through: the challenge asks for the point to be explicit, not for a mechanism.
 *
 * Intended design: an external identity provider (Keycloak or Zitadel) issues OAuth2 client-credentials tokens,
 * one client per wagering provider. Here the guard would verify the bearer token's signature and expiry against the
 * provider's published keys and attach the provider identity (its `providerId` claim) to the request. The use
 * cases then reject a submission whose `providerId` differs from that identity, so one provider cannot act on
 * another's behalf. No password or user table lives in this service. Health endpoints stay `@Public()`, and queue
 * messages are an internal trusted channel, though their provider identity is still validated by the domain.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    // Extension point: verify the token and attach the provider identity here. Until then, everything is allowed.
    return true;
  }
}
