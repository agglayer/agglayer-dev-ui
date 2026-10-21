import type { AddressInfo } from 'node:net';

// Opt-in, loopback-only CORS shim for browser-mode runs (`browser.corsRelay` /
// `run --cors-relay`).
//
// Why it exists: the shared aggkit-proxy only answers cross-origin browser
// requests from an allowlisted origin (e.g. `https://*.polygon.technology`).
// A browser-mode run serves the E2E UI from `uiBaseUrl` (typically
// `http://127.0.0.1:<port>`), which is not on that allowlist, so the page can
// not read tracker responses. This relay is a plain forwarder that the built UI
// is pointed at instead of the real proxy: it forwards method/path/query/body
// unchanged to the configured proxy and replaces the CORS response headers.
//
// It is NOT needed (and must not be used) where the UI is served from an
// allowlisted origin, which is how real deployments are laid out. It adds no
// authentication of its own, so it only ever binds 127.0.0.1 and only answers
// requests whose `Origin` is the UI's own origin.
import http from 'node:http';
import https from 'node:https';

const LOOPBACK_HOST = '127.0.0.1';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

// RFC 9110 §7.6.1 hop-by-hop headers, never forwarded in either direction.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

// Request headers that identify the relay's own client rather than the
// upstream call. `origin`/`referer` are dropped so the upstream never sees the
// non-allowlisted page origin; `host` is re-derived for the upstream.
const REQUEST_HEADERS_NOT_FORWARDED = new Set(['host', 'origin', 'referer']);

export interface CorsRelayOptions {
  /** The real proxy the relay forwards to (`config.aggkitProxyUrl`). */
  upstreamUrl: string;
  /** Page origins (`scheme://host:port`) that are granted CORS access. Others get no CORS headers. */
  allowedOrigins: readonly string[];
  /** Defaults to 0 (random free port). */
  port?: number;
  logger?: (line: string) => void;
}

export interface CorsRelayHandle {
  /** `http://127.0.0.1:<port>` — what the UI is built to use as its proxy. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Exported for tests: the CORS response headers for one request, or none if the origin isn't allowed. */
export const buildCorsHeaders = (
  requestOrigin: string | undefined,
  requestedHeaders: string | undefined,
  allowedOrigins: readonly string[]
): Record<string, string> => {
  if (requestOrigin === undefined || !allowedOrigins.includes(requestOrigin)) return {};
  return {
    'access-control-allow-origin': requestOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': requestedHeaders ?? 'content-type',
    'access-control-max-age': PREFLIGHT_MAX_AGE_SECONDS,
    vary: 'Origin'
  };
};

/** Exported for tests: request headers to forward upstream (everything except hop-by-hop and the relay-client identity headers). */
export const filterForwardedRequestHeaders = (
  headers: http.IncomingHttpHeaders
): http.OutgoingHttpHeaders => {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || REQUEST_HEADERS_NOT_FORWARDED.has(name)) continue;
    out[name] = value;
  }
  return out;
};

/** Exported for tests: upstream response headers with hop-by-hop and any upstream CORS headers removed (the relay owns CORS). */
export const filterForwardedResponseHeaders = (
  headers: http.IncomingHttpHeaders
): http.OutgoingHttpHeaders => {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || name.startsWith('access-control-') || name === 'vary') continue;
    out[name] = value;
  }
  return out;
};

const joinUpstreamPath = (basePath: string, requestUrl: string): string => {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${base}${requestUrl.startsWith('/') ? requestUrl : `/${requestUrl}`}`;
};

// DNS-rebinding guard: a loopback-only listener should only ever be addressed
// by a loopback host name.
const isLoopbackHostHeader = (hostHeader: string | undefined): boolean => {
  if (hostHeader === undefined) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
};

export const startCorsRelay = async (options: CorsRelayOptions): Promise<CorsRelayHandle> => {
  const { allowedOrigins, logger = () => undefined } = options;
  const upstream = new URL(options.upstreamUrl);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error(`corsRelay: upstream must be http(s), got "${upstream.protocol}"`);
  }
  const transport = upstream.protocol === 'https:' ? https : http;

  const server = http.createServer((req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const requested =
      typeof req.headers['access-control-request-headers'] === 'string'
        ? req.headers['access-control-request-headers']
        : undefined;
    const cors = buildCorsHeaders(origin, requested, allowedOrigins);

    if (!isLoopbackHostHeader(req.headers.host)) {
      res.writeHead(403, { ...cors, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const upstreamReq = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port === '' ? undefined : upstream.port,
        method: req.method,
        path: joinUpstreamPath(upstream.pathname, req.url ?? '/'),
        headers: { ...filterForwardedRequestHeaders(req.headers), host: upstream.host }
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          ...filterForwardedResponseHeaders(upstreamRes.headers),
          ...cors
        });
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { ...cors, 'content-type': 'text/plain; charset=utf-8' });
      res.end(`corsRelay: upstream request failed: ${error.message}`);
    });
    req.pipe(upstreamReq);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${LOOPBACK_HOST}:${port}`;
  logger(
    `run: CORS relay listening on ${url} (loopback only) -> ${upstream.origin}${upstream.pathname === '/' ? '' : upstream.pathname}. ` +
      `This is a local-only CORS shim: the proxy's CORS allowlist normally excludes the local UI origin (${allowedOrigins.join(', ')}), ` +
      'so the browser-mode UI is pointed at this relay instead. It adds no authentication; do not expose it.'
  );

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  };
};
