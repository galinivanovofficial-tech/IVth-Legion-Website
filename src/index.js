// IVth Legion — zero-dependency Node server. Serves the site + membership API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, configSummary } from './config.js';
import { registerAuthRoutes } from './auth.js';
import { registerBillingRoutes } from './stripe.js';
import { registerMarketRoutes } from './markets.js';
import { registerDerivativeRoutes } from './derivatives.js';
import { startPolling } from './telegram.js';
import { startJobs } from './jobs.js';

// ---------- tiny router ----------
const routes = [];
const router = {
  add(method, path, handler) { routes.push({ method, path, handler }); },
  get(p, h) { this.add('GET', p, h); },
  post(p, h) { this.add('POST', p, h); },
};

// ---------- helpers on req/res ----------
function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function decorate(req, res) {
  req.cookies = parseCookies(req.headers.cookie || '');
  req.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const setCookies = [];
  res.appendCookie = (c) => setCookies.push(c);
  res.json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}) });
    res.end(JSON.stringify(obj));
  };
  res.redirect = (url) => { res.writeHead(302, { Location: url, ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}) }); res.end(); };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size < 2_000_000) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // security: prevent path traversal
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(config.publicDir, safe);
  if (!filePath.startsWith(config.publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  // pretty routes: /dashboard -> /dashboard.html
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    if (fs.existsSync(filePath + '.html')) filePath += '.html';
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const notFound = path.join(config.publicDir, '404.html');
      if (fs.existsSync(notFound)) { res.writeHead(404, { 'Content-Type': MIME['.html'] }); return fs.createReadStream(notFound).pipe(res); }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- security headers ----------
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// register API routes
registerAuthRoutes(router);
registerBillingRoutes(router);
registerMarketRoutes(router);
registerDerivativeRoutes(router);
router.get('/api/health', (req, res) => res.json(200, { ok: true, ...configSummary() }));

// ---------- request dispatch ----------
const server = http.createServer(async (req, res) => {
  decorate(req, res);
  securityHeaders(res);
  const pathname = req.url.split('?')[0];

  // API?
  const match = routes.find(r => r.method === req.method && r.path === pathname);
  if (match) {
    try {
      req.rawBody = await readBody(req);
      // Stripe webhook needs the raw body untouched; everything else JSON.
      if (pathname !== '/api/billing/webhook' && req.rawBody) {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) { try { req.body = JSON.parse(req.rawBody); } catch { req.body = {}; } }
        else if (ct.includes('application/x-www-form-urlencoded')) { req.body = Object.fromEntries(new URLSearchParams(req.rawBody)); }
      }
      await match.handler(req, res);
    } catch (e) {
      console.error('[server] handler error:', e);
      if (!res.headersSent) res.json(500, { error: 'Server error' });
    }
    return;
  }
  if (pathname.startsWith('/api/')) return res.json(404, { error: 'Not found' });

  // static
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end('Method not allowed');
});

server.listen(config.port, () => {
  console.log('\n  IVth Legion server');
  console.log('  ' + JSON.stringify(configSummary(), null, 2).replace(/\n/g, '\n  '));
  console.log(`  Listening on ${config.baseUrl}\n`);
  startPolling().catch(e => console.error('[telegram] start:', e.message));
  startJobs();
});
