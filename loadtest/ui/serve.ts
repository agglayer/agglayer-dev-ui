// Serves a `build-ui` static export (`out/`) on `uiBaseUrl`, mirroring
// `nginx.conf`'s serving rules (the same rules the published Docker image
// uses): `/config.json` is always `Cache-Control: no-store` (a container/
// dev-server restart with a different config must never be served stale
// from a cache), `_next/static/*` is content-hashed and safe to cache
// forever, and every other path falls through Next's static-export routing
// (`<route>.html` before a directory index) with a final SPA-style fallback
// to `index.html` for an unmatched extension-less path (e.g. a client-side
// route Playwright navigates to directly).
//
// A plain function, not a long-running CLI-only script -- `cli.ts`'s
// `serve-ui` command is a thin wrapper that keeps the process alive; S11's
// `run` command is expected to import `serveUi` directly to auto-serve a
// local `uiBaseUrl` that isn't already answering, then `close()` it itself.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';

const isRegularFile = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

// nginx.conf's `try_files` order: exact file, then the clean-URL
// `<route>.html` form Next's static export writes, then a directory index.
const resolveStaticFile = (outDir: string, urlPath: string): string | null => {
  const requestPath = urlPath === '/' ? '/index.html' : urlPath;
  const candidates = [
    path.join(outDir, requestPath),
    `${path.join(outDir, requestPath)}.html`,
    path.join(outDir, requestPath, 'index.html')
  ];
  for (const candidate of candidates) {
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
};

export interface ServeUiOptions {
  // Directory to serve -- `build-ui`'s `out/` by default.
  outDir: string;
  // `http://host:port` to listen on (a loadtest config's `uiBaseUrl`).
  uiBaseUrl: string;
}

export interface ServeUiHandle {
  url: string;
  close: () => Promise<void>;
}

// Starts a static file server for `outDir` on `uiBaseUrl` and resolves once
// it is listening. Reusable as a plain async function: `run` (S11) can call
// this directly and `await handle.close()` when the load test ends, without
// going through the CLI at all.
export const serveUi = async (options: ServeUiOptions): Promise<ServeUiHandle> => {
  const { outDir, uiBaseUrl } = options;
  const target = new URL(uiBaseUrl);
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;

  const server = http.createServer((req, res) => {
    const requestUrl = req.url ?? '/';
    const cleanPath = decodeURIComponent(requestUrl.split('?')[0]);

    // Path-traversal guard -- resolveStaticFile joins this onto outDir, so a
    // ".." PATH SEGMENT must never reach it. Checked segment-by-segment
    // (not a bare substring match on ".."): Next's content-hashed chunk
    // filenames legitimately contain ".." as part of the hash (e.g.
    // "14_7s8bz7t4~..js"), which a substring check would wrongly reject.
    if (cleanPath.split('/').some((segment) => segment === '..')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    let filePath = resolveStaticFile(outDir, cleanPath);

    // SPA-style fallback: an unmatched path with no file extension in its
    // last segment (i.e. it looks like a client-side route, not a missing
    // asset) falls back to the app shell. `/config.json` is exempt --
    // never silently substitute the app shell for a missing config file.
    if (filePath === null && cleanPath !== '/config.json') {
      const lastSegment = cleanPath.split('/').pop() ?? '';
      if (!lastSegment.includes('.')) {
        const shellPath = path.join(outDir, 'index.html');
        if (isRegularFile(shellPath)) filePath = shellPath;
      }
    }

    if (filePath === null) {
      const notFoundPath = path.join(outDir, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(isRegularFile(notFoundPath) ? fs.readFileSync(notFoundPath) : 'Not Found');
      return;
    }

    const headers: http.OutgoingHttpHeaders = { 'Content-Type': contentTypeFor(filePath) };
    // R7 (nginx.conf, docs/docker.md "Cache semantics"): the served config
    // document must never be cached by a browser or intermediary -- a
    // rebuild with different loadtest config must be reflected on the very
    // next request.
    if (cleanPath === '/config.json') {
      headers['Cache-Control'] = 'no-store';
    } else if (cleanPath.startsWith('/_next/static/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }

    res.writeHead(200, headers);
    res.end(fs.readFileSync(filePath));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, target.hostname, () => resolve());
  });

  return {
    url: uiBaseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
};
