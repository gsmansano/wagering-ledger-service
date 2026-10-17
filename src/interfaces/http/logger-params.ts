import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import { correlationIdFrom } from './request-parsing';
import { newId } from '../../infrastructure/id-generator';
import { loggable } from '../../infrastructure/logging/log-fields';

// Health probes and metric scrapes arrive every few seconds from the orchestrator and would drown the log.
const QUIET_PATHS = ['/health/', '/metrics'];

/**
 * JSON lines, one per event. `log` filters what call sites pass, `bindings` what `assign` and child loggers
 * add; both go through the allowlist in `log-fields.ts`. The request line carries the method, the path
 * without its query and the status, never headers or the body.
 */
export function createLoggerParams(level: string): Params {
  return {
    // Lets `PinoLogger.assign` in a controller reach the request line, not just later lines of the same request.
    assignResponse: true,
    pinoHttp: {
      level,
      base: null, // no pid or hostname
      timestamp: stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: loggable,
        bindings: loggable,
      },
      // The caller's X-Correlation-Id when it is plain, otherwise a new one; the same rule as the use cases.
      genReqId: (req: IncomingMessage) => correlationIdFrom(headerOf(req, 'x-correlation-id')) ?? newId(),
      customProps: (req: IncomingMessage) => ({ correlationId: req.id }),
      serializers: {
        req: (req: IncomingMessage) => ({ method: req.method, path: (req.url ?? '').split('?')[0] }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.some((path) => (req.url ?? '').startsWith(path)) },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, error?: Error) =>
        error !== undefined || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    },
  };
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
