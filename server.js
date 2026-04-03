/**
 * Alpaca Paper Trading Dashboard — Local Proxy Server
 * ─────────────────────────────────────────────────────
 * Fixes CORS by proxying Alpaca API + RSS feeds server-side.
 *
 * Run:  node server.js
 * Then: http://localhost:8080
 *
 * No npm packages required — pure Node.js built-ins only.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── Config ────────────────────────────────────────────────────
const PORT         = 8080;
const DASHBOARD    = path.join(__dirname, 'alpaca-paper-trading-dashboard.html');
const ALPACA_DATA  = 'data.alpaca.markets';
const ALPACA_TRADE = 'paper-api.alpaca.markets';

// ── Helpers ───────────────────────────────────────────────────
function readApiKeys() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'API_KEYS.txt'), 'utf8');
    const key    = txt.match(/YOUR_PAPER_KEY\s*=\s*(\S+)/)?.[1]  || '';
    const secret = txt.match(/YOUR_SECRET_KEY\s*=\s*(\S+)/)?.[1] || '';
    return { key, secret };
  } catch { return { key: '', secret: '' }; }
}

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: 'GET', headers };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function httpsDelete(hostname, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path: reqPath, method: 'DELETE', headers };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseXmlItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const chunk = m[1];
    const get = tag => { const r = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`); const h = r.exec(chunk); return h ? (h[1]||h[2]||'').trim() : ''; };
    items.push({ title: get('title'), description: get('description').replace(/<[^>]+>/g,'').slice(0,300), link: get('link'), pubDate: get('pubDate') });
  }
  return items;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(body);
}

// ── Generic HTTPS request helper (supports GET, POST, DELETE) ─
function httpsRequest(hostname, reqPath, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = (body && method !== 'GET') ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname, path: reqPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      }
    };
    const req2 = https.request(opts, res2 => {
      let data = '';
      res2.on('data', c => data += c);
      res2.on('end', () => {
        try { resolve({ status: res2.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res2.statusCode, body: data }); }
      });
    });
    req2.on('error', reject);
    req2.setTimeout(15000, () => { req2.destroy(); reject(new Error('Timeout')); });
    if (payload) req2.write(payload);
    req2.end();
  });
}

// ── Proxy Routes ──────────────────────────────────────────────
async function handleProxy(req, res, parsed, keys) {
  const route = parsed.pathname;

  // /.netlify/functions/proxy?target=<url>  (used by dashboard on localhost)
  if (route === '/.netlify/functions/proxy') {
    const target = parsed.query?.target;
    if (!target) return sendJson(res, 400, { error: 'Missing target param' });
    try {
      const t = new URL(target);
      if (!t.hostname.endsWith('alpaca.markets')) return sendJson(res, 403, { error: 'Domain not allowed' });
      const method = req.method || 'GET';
      let reqBody = null;
      if (method !== 'GET' && method !== 'DELETE') {
        reqBody = await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
      }
      const r = await httpsRequest(t.hostname, t.pathname + (t.search || ''), method, reqBody, {
        'APCA-API-KEY-ID': keys.key,
        'APCA-API-SECRET-KEY': keys.secret,
      });
      return sendJson(res, r.status, r.body);
    } catch(e) { return sendJson(res, 502, { error: e.message }); }
  }

  // /.netlify/functions/rss?url=<url>  (used by dashboard on localhost)
  if (route === '/.netlify/functions/rss') {
    const feedUrl = parsed.query?.url;
    if (!feedUrl) return sendJson(res, 400, { error: 'Missing url param' });
    try {
      const feedParsed = new URL(feedUrl);
      const r = await new Promise((resolve, reject) => {
        const options = { hostname: feedParsed.hostname, path: feedParsed.pathname + (feedParsed.search||''), method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } };
        const req2 = https.request(options, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve({ status: res2.statusCode, body: data }));
        });
        req2.on('error', reject);
        req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('Timeout')); });
        req2.end();
      });
      const items = parseXmlItems(r.body);
      const feedTitle = (/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i.exec(r.body) || [])[1] || feedUrl;
      return sendJson(res, 200, { feed: { title: feedTitle }, items });
    } catch(e) { return sendJson(res, 502, { error: e.message }); }
  }

  // GET /proxy/alpaca-news
  if (route === '/proxy/alpaca-news') {
    const qs = parsed.search || '';
    try {
      const r = await httpsGet(ALPACA_DATA, `/v1beta1/news${qs}`, {
        'APCA-API-KEY-ID': keys.key,
        'APCA-API-SECRET-KEY': keys.secret,
      });
      return sendJson(res, r.status, r.body);
    } catch(e) { return sendJson(res, 502, { error: e.message }); }
  }

  // GET /proxy/alpaca-data  (bars, quotes, etc.)
  if (route.startsWith('/proxy/alpaca-data')) {
    const alpacaPath = route.replace('/proxy/alpaca-data', '') + (parsed.search || '');
    try {
      const r = await httpsGet(ALPACA_DATA, alpacaPath, {
        'APCA-API-KEY-ID': keys.key,
        'APCA-API-SECRET-KEY': keys.secret,
      });
      return sendJson(res, r.status, r.body);
    } catch(e) { return sendJson(res, 502, { error: e.message }); }
  }

  // GET /proxy/alpaca-trade  (account, orders, positions)
  if (route.startsWith('/proxy/alpaca-trade')) {
    const alpacaPath = route.replace('/proxy/alpaca-trade', '') + (parsed.search || '');
    try {
      const r = await httpsGet(ALPACA_TRADE, alpacaPath, {
        'APCA-API-KEY-ID': keys.key,
        'APCA-API-SECRET-KEY': keys.secret,
      });
      return sendJson(res, r.status, r.body);
    } catch(e) { return sendJson(res, 502, { error: e.message }); }
  }

  // GET /proxy/rss?url=...
  if (route === '/proxy/rss') {
    const feedUrl = parsed.query?.url;
    if (!feedUrl) return sendJson(res, 400, { error: 'Missing url param' });
    try {
      const feedParsed = new URL(feedUrl);
      const r = await new Promise((resolve, reject) => {
        const options = { hostname: feedParsed.hostname, path: feedParsed.pathname + (feedParsed.search||''), method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } };
        const req2 = https.request(options, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve({ status: res2.statusCode, body: data }));
        });
        req2.on('error', reject);
        req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('Timeout')); });
        req2.end();
      });
      const items = parseXmlItems(r.body);
      const feedTitle = (/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i.exec(r.body) || [])[1] || feedUrl;
      return sendJson(res, 200, { feed: { title: feedTitle }, items });
    } catch(e) { return sendJson(res, 502, { error: e.message }); }
  }

  return sendJson(res, 404, { error: 'Unknown proxy route' });
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
    return res.end();
  }

  // Proxy routes — legacy /proxy/* and new /.netlify/functions/* paths
  if (parsed.pathname.startsWith('/proxy/') || parsed.pathname.startsWith('/.netlify/functions/')) {
    const keys = readApiKeys();
    return handleProxy(req, res, parsed, keys);
  }

  // Serve dashboard HTML
  if (parsed.pathname === '/' || parsed.pathname === '/alpaca-paper-trading-dashboard.html') {
    try {
      const html = fs.readFileSync(DASHBOARD, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch(e) {
      res.writeHead(404);
      return res.end('Dashboard HTML not found.');
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ✅  Alpaca Paper Trading Dashboard');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
