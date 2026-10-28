import type { AddressInfo } from 'node:net';

import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CorsRelayHandle } from './corsRelay';

import {
  buildCorsHeaders,
  filterForwardedRequestHeaders,
  filterForwardedResponseHeaders,
  startCorsRelay
} from './corsRelay';

const PAGE_ORIGIN = 'http://127.0.0.1:3000';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let upstream: http.Server;
let upstreamPort: number;
let seen: Seen[];
let relay: CorsRelayHandle | undefined;

beforeEach(async () => {
  seen = [];
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      res.writeHead(201, {
        'content-type': 'application/json',
        'x-upstream': 'yes',
        'access-control-allow-origin': 'https://upstream.example',
        vary: 'Accept-Encoding'
      });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterEach(async () => {
  await relay?.close();
  relay = undefined;
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const start = (upstreamPath = '') =>
  startCorsRelay({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}${upstreamPath}`,
    allowedOrigins: [PAGE_ORIGIN]
  });

describe('buildCorsHeaders', () => {
  it('echoes an allowed page origin and the requested headers', () => {
    const headers = buildCorsHeaders(PAGE_ORIGIN, 'content-type,x-custom', [PAGE_ORIGIN]);
    expect(headers['access-control-allow-origin']).toBe(PAGE_ORIGIN);
    expect(headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(headers['access-control-allow-headers']).toBe('content-type,x-custom');
    expect(headers.vary).toBe('Origin');
  });

  it('grants nothing to a missing or non-allowed origin', () => {
    expect(buildCorsHeaders(undefined, undefined, [PAGE_ORIGIN])).toEqual({});
    expect(buildCorsHeaders('https://evil.example', undefined, [PAGE_ORIGIN])).toEqual({});
  });
});

describe('header filtering', () => {
  it('drops host/origin/referer and hop-by-hop request headers, keeps the rest unchanged', () => {
    const out = filterForwardedRequestHeaders({
      host: '127.0.0.1:1',
      origin: PAGE_ORIGIN,
      referer: `${PAGE_ORIGIN}/x`,
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
      authorization: 'Bearer t'
    });
    expect(out).toEqual({ 'content-type': 'application/json', authorization: 'Bearer t' });
  });

  it('removes upstream CORS/Vary/hop-by-hop response headers so the relay owns them', () => {
    const out = filterForwardedResponseHeaders({
      'access-control-allow-origin': 'https://upstream.example',
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
      connection: 'close',
      'content-type': 'application/json',
      'x-upstream': 'yes'
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-upstream': 'yes' });
  });
});

describe('startCorsRelay', () => {
  it('binds to loopback on a random port and logs the local-only notice', async () => {
    const lines: string[] = [];
    relay = await startCorsRelay({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      allowedOrigins: [PAGE_ORIGIN],
      logger: (line) => lines.push(line)
    });
    expect(relay.url).toBe(`http://127.0.0.1:${relay.port}`);
    expect(relay.port).toBeGreaterThan(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/local-only CORS shim/);
    expect(lines[0]).toMatch(/loopback only/);
  });

  it('answers an OPTIONS preflight itself with 204 + CORS headers, without calling upstream', async () => {
    relay = await start();
    const res = await fetch(`${relay.url}/tracker/v1/activity/from/0xabc`, {
      method: 'OPTIONS',
      headers: {
        origin: PAGE_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type'
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGE_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(seen).toHaveLength(0);
  });

  it('forwards method, path, query and body unchanged and normalizes CORS headers on the response', async () => {
    relay = await start('/base');
    const res = await fetch(`${relay.url}/tracker/v1/x?includeTracking=true`, {
      method: 'POST',
      headers: { origin: PAGE_ORIGIN, 'content-type': 'application/json', 'x-trace': 'abc' },
      body: '{"hello":"world"}'
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGE_ORIGIN);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/base/tracker/v1/x?includeTracking=true');
    expect(seen[0].body).toBe('{"hello":"world"}');
    expect(seen[0].headers['x-trace']).toBe('abc');
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].headers.origin).toBeUndefined();
    expect(seen[0].headers.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it('adds no CORS headers for an origin that is not the UI origin', async () => {
    relay = await start();
    const res = await fetch(`${relay.url}/x`, { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a non-loopback Host header (DNS-rebinding guard)', async () => {
    relay = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: relay!.port, path: '/x', headers: { host: 'attacker.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('returns 502 with CORS headers when upstream is unreachable', async () => {
    relay = await startCorsRelay({
      upstreamUrl: 'http://127.0.0.1:1',
      allowedOrigins: [PAGE_ORIGIN]
    });
    const res = await fetch(`${relay.url}/x`, { headers: { origin: PAGE_ORIGIN } });
    expect(res.status).toBe(502);
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGE_ORIGIN);
  });

  it('stops listening after close()', async () => {
    relay = await start();
    const { url } = relay;
    await relay.close();
    relay = undefined;
    await expect(fetch(`${url}/x`)).rejects.toThrow();
  });

  it('rejects a non-http(s) upstream', async () => {
    await expect(
      startCorsRelay({ upstreamUrl: 'ftp://example.com', allowedOrigins: [] })
    ).rejects.toThrow(/http\(s\)/);
  });
});
