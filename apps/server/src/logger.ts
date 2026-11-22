/**
 * Server logging: pino (via Fastify) to <dataDir>/logs/server.log. No request/response bodies,
 * no URLs with ids for path endpoints, every string value redacted, path/cwd keys dropped.
 */
import { redact, redactObject } from '@qavo/shared';
import type { FastifyServerOptions } from 'fastify';

export function loggerOptions(file: string | null, level = 'info'): FastifyServerOptions['logger'] {
  if (!file) return false;
  return {
    level,
    file,
    base: null,
    formatters: {
      log: (obj: Record<string, unknown>) => redactObject(obj),
    },
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(
          this,
          args.map((a) => (typeof a === 'string' ? redact(a) : a)),
        );
      },
    },
    serializers: {
      req: () => ({}),
      res: () => ({}),
      err: (e: Error) => ({ type: e.name, message: redact(e.message), stack: '' }),
    },
  } as FastifyServerOptions['logger'];
}
