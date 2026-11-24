import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../../..');

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');
}

function resolveInsideRoot(rootDir, relPath) {
  const absRoot = path.resolve(rootDir);
  const candidate = path.resolve(absRoot, '.' + (relPath.startsWith('/') ? relPath : '/' + relPath));
  if (candidate !== absRoot && !candidate.startsWith(absRoot + path.sep)) {
    return null;
  }
  return candidate;
}

export async function startFixtureServer(opts = {}) {
  const docsDir = path.resolve(opts.docsDir || path.join(REPO_ROOT, 'docs'));
  const fixturesDir = path.resolve(opts.fixturesDir || path.join(REPO_ROOT, 'tests/e2e/fixtures'));

  const roots = opts.roots
    ? Object.entries(opts.roots).map(([prefix, dir]) => [prefix.replace(/\/+$/, '') || '/', path.resolve(dir)])
    : [
        ['/docs', docsDir],
        ['/fixtures', fixturesDir]
      ];

  // Sort longer prefixes first so nested mounts match deterministically
  roots.sort((a, b) => b[0].length - a[0].length);

  const server = http.createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    let rawPath;
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      rawPath = decodeURIComponent(parsed.pathname);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (rawPath.includes('\0') || rawPath.split('/').includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (rawPath === '/docs') {
      res.writeHead(302, { Location: '/docs/' });
      res.end();
      return;
    }

    if (typeof opts.onRequest === 'function') {
      const handled = opts.onRequest(req, res, rawPath);
      if (handled) return;
    }

    let matchedPrefix = null;
    let matchedDir = null;
    for (const [prefix, dir] of roots) {
      if (prefix === '/' || rawPath === prefix || rawPath.startsWith(prefix + '/')) {
        matchedPrefix = prefix;
        matchedDir = dir;
        break;
      }
    }

    if (!matchedDir) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    let relPath = matchedPrefix === '/' ? rawPath : rawPath.slice(matchedPrefix.length);
    if (!relPath || relPath === '/') {
      relPath = '/index.html';
    }

    const filePath = resolveInsideRoot(matchedDir, relPath);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    let finalPath = filePath;
    if (stat.isDirectory()) {
      finalPath = path.join(filePath, 'index.html');
      try {
        stat = fs.statSync(finalPath);
      } catch (_) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    const ext = path.extname(finalPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(finalPath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end();
    });
    stream.pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    docsUrl: `${baseUrl}/docs/`,
    fixturesUrl: `${baseUrl}/fixtures/`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      })
  };
}

export async function startMockLlmServer(handler) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let jsonBody = null;
    try {
      jsonBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (_) {}

    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      rawBody,
      body: jsonBody
    };
    requests.push(record);

    try {
      await handler(record, res, requests);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err?.message || 'Mock server error' } }));
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    v1Url: `${baseUrl}/v1`,
    requests,
    clearRequests: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      })
  };
}
