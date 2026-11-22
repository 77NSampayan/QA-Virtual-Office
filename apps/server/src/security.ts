/**
 * Request validation (docs/security.md):
 *  - Host must be 127.0.0.1:<port> or localhost:<port>         (anti DNS-rebinding)
 *  - token routes (/api/hooks, /api/statusline, /api/auth/launch-nonce): no Origin header (browsers
 *    always send one), X-QAVO-Token required, rate limited
 *  - other /api + /ws: Origin, if present, must be the app origin (WS requires it); a valid session
 *    cookie (from the one-time launch URL) is required except for /api/health and /api/auth/status
 *  - mutating requests and sensitive endpoints require X-QAVO-Client (forces CORS preflight,
 *    which we never answer) — blocks CSRF
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityOptions {
  port: number;
  token: string;
  /** Returns true when the request carries a valid session cookie. Omit to disable (tests only). */
  isAuthenticated?: (req: FastifyRequest) => boolean;
  hooksRatePerSec?: number;
  hooksBurst?: number;
}

export const TOKEN_ROUTES = new Set(['/api/hooks', '/api/statusline', '/api/auth/launch-nonce']);
const AUTH_EXEMPT = new Set(['/api/health', '/api/auth/status']);
const SENSITIVE_GET = [/^\/api\/projects\/[^/]+\/path$/, /^\/api\/settings\/excludes$/];

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function appOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

export function registerSecurity(app: FastifyInstance, opts: SecurityOptions) {
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = appOrigins(opts.port);
  const rate = opts.hooksRatePerSec ?? 200;
  const burst = opts.hooksBurst ?? 600;
  let tokens = burst;
  let last = Date.now();

  const deny = (req: FastifyRequest, reply: FastifyReply, status: number, code: string) => {
    // Upgrade sockets are detached from the HTTP server's connection tracking: close them explicitly.
    if (req.headers.upgrade) {
      const socket = req.raw.socket;
      reply.header('connection', 'close');
      reply.raw.once('finish', () => socket.destroy());
    }
    return reply.code(status).send({ error: code });
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return deny(req, reply, 403, 'bad_host');
    const url = req.url.split('?')[0]!;
    const origin = req.headers.origin;

    if (TOKEN_ROUTES.has(url)) {
      if (origin !== undefined) return deny(req, reply, 403, 'origin_not_allowed');
      const tok = req.headers['x-qavo-token'];
      if (typeof tok !== 'string' || !timingSafeEq(tok, opts.token)) return deny(req, reply, 401, 'bad_token');
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
      last = now;
      if (tokens < 1) return deny(req, reply, 429, 'rate_limited');
      tokens -= 1;
      return;
    }

    if (url.startsWith('/api/') || url === '/ws') {
      if (origin !== undefined && !origins.has(origin)) return deny(req, reply, 403, 'origin_not_allowed');
      if (req.headers['sec-fetch-site'] === 'cross-site') return deny(req, reply, 403, 'cross_site');
      if (url === '/ws' && (origin === undefined || !origins.has(origin))) return deny(req, reply, 403, 'origin_required');
      if (opts.isAuthenticated && !AUTH_EXEMPT.has(url) && !opts.isAuthenticated(req)) return deny(req, reply, 401, 'unauthorized');
      const mutating = !['GET', 'HEAD'].includes(req.method);
      const sensitive = SENSITIVE_GET.some((re) => re.test(url));
      if ((mutating || sensitive) && req.headers['x-qavo-client'] !== '1') return deny(req, reply, 403, 'client_header_required');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.url.startsWith('/api/') || req.url.startsWith('/launch')) reply.header('Cache-Control', 'no-store');
    const ct = String(reply.getHeader('content-type') ?? '');
    if (ct.startsWith('text/html')) {
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; ` +
          `connect-src 'self' ws://127.0.0.1:${opts.port} ws://localhost:${opts.port}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      );
    }
    return payload;
  });
}
