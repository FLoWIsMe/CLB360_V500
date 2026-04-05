const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const SITE_BASE = 'https://api.ui.com/v1';
const EA_BASE = 'https://api.ui.com/ea';
const PAGE_SIZE = 100;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'chrome'
].filter(Boolean);

const UNIT_KEYS = {
  '001': 'WOncXsXoJ9ivvnTfn7BifjyuoZ-OHqTH',
  '002': '_SbNK1htk4T21EFp-aCaJAKhA7zqKQqU',
  '003': 'ZNGBD-tcy7l3jvdjWTTdwGg7v9rlymJP'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res, code, payload) { send(res, code, JSON.stringify(payload), 'application/json; charset=utf-8'); }
function errMsg(error) { return error && error.message ? error.message : String(error || 'Unknown error'); }
function compact(obj) { return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v)); }
function apiHeaders(key) {
  return { Accept: 'application/json', Authorization: `Bearer ${key}`, 'X-API-Key': key, 'api-key': key };
}

function fetchJson(url, key) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(target, { method: 'GET', headers: apiHeaders(key), timeout: 18000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim()));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchPaginated(url, key) {
  const items = [];
  let next = '';
  for (let i = 0; i < 20; i += 1) {
    const target = new URL(url);
    if (next) target.searchParams.set('nextToken', next);
    const json = await fetchJson(target.toString(), key);
    items.push(...(Array.isArray(json.data) ? json.data : []));
    next = json.nextToken || '';
    if (!next) break;
  }
  return items;
}

async function buildBundle(unit) {
  const key = UNIT_KEYS[unit];
  if (!key) throw new Error(`Unknown unit ${unit}`);
  const sites = await fetchPaginated(`${SITE_BASE}/sites?pageSize=${PAGE_SIZE}`, key);
  const results = await Promise.allSettled([
    fetchPaginated(`${SITE_BASE}/hosts?pageSize=${PAGE_SIZE}`, key),
    fetchJson(`${EA_BASE}/isp-metrics/1h?duration=30d`, key),
    fetchJson(`${EA_BASE}/isp-metrics/5m?duration=24h`, key)
  ]);
  return {
    source: 'live',
    fetchedAt: new Date().toISOString(),
    sites,
    hosts: results[0].status === 'fulfilled' ? results[0].value : [],
    ispMetrics1h: results[1].status === 'fulfilled' && Array.isArray(results[1].value.data) ? results[1].value.data : [],
    ispMetrics5m: results[2].status === 'fulfilled' && Array.isArray(results[2].value.data) ? results[2].value.data : [],
    errors: compact({
      hosts: results[0].status === 'rejected' ? errMsg(results[0].reason) : '',
      metrics1h: results[1].status === 'rejected' ? errMsg(results[1].reason) : '',
      metrics5m: results[2].status === 'rejected' ? errMsg(results[2].reason) : ''
    })
  };
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (candidate.includes('/') && fs.existsSync(candidate)) return candidate;
      if (!candidate.includes('/')) return candidate;
    } catch {}
  }
  return 'chromium';
}

function runChrome(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(findChrome(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Chrome exited with code ${code}`));
    });
  });
}

async function renderPdf(query) {
  const tmp = path.join(os.tmpdir(), `clb360-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const page = `http://localhost:${PORT}/index.html?unit=${encodeURIComponent(query.unit || '003')}&view=${encodeURIComponent(query.view || 'all')}&range=${encodeURIComponent(query.range || '24h')}&client=${encodeURIComponent(query.client || '')}&show=${encodeURIComponent(query.show || '')}&email=${encodeURIComponent(query.email || '')}`;
  await runChrome(['--headless', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${tmp}`, '--print-to-pdf-no-header', page]);
  const data = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return data;
}

async function renderPng(query) {
  const tmp = path.join(os.tmpdir(), `clb360-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const view = query.view || 'overview';
  const url = view === 'launch'
    ? `http://localhost:${PORT}/index.html`
    : `http://localhost:${PORT}/index.html?autostart=1&unit=${encodeURIComponent(query.unit || '003')}&view=${encodeURIComponent(view)}&range=${encodeURIComponent(query.range || '24h')}&client=${encodeURIComponent(query.client || '')}&show=${encodeURIComponent(query.show || '')}&email=${encodeURIComponent(query.email || '')}`;
  const size = view === 'launch' ? '1600,1100' : '1600,1500';
  await runChrome(['--headless', '--disable-gpu', '--no-sandbox', `--window-size=${size}`, `--screenshot=${tmp}`, url]);
  const data = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, at: new Date().toISOString() });
      return;
    }
    const m = url.pathname.match(/^\/api\/unit\/(001|002|003)\/bundle$/);
    if (m) {
      try { sendJson(res, 200, await buildBundle(m[1])); } catch (error) { sendJson(res, 502, { error: errMsg(error) }); }
      return;
    }
    if (url.pathname === '/api/report/pdf') {
      try {
        const data = await renderPdf(Object.fromEntries(url.searchParams.entries()));
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="clb360-report.pdf"', 'Cache-Control': 'no-store' });
        res.end(data);
      } catch (error) {
        sendJson(res, 500, { error: errMsg(error) });
      }
      return;
    }
    if (url.pathname === '/api/report/png') {
      try {
        const data = await renderPng(Object.fromEntries(url.searchParams.entries()));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="clb360-report.png"', 'Cache-Control': 'no-store' });
        res.end(data);
      } catch (error) {
        sendJson(res, 500, { error: errMsg(error) });
      }
      return;
    }
    const target = url.pathname === '/' ? '/index.html' : url.pathname;
    const safe = path.normalize(target).replace(/^\.\.(?:[\/\\]|$)/, '');
    const file = path.join(ROOT, safe);
    if (!file.startsWith(ROOT)) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    fs.readFile(file, (error, data) => {
      if (error) { sendJson(res, 404, { error: 'Not found' }); return; }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
      res.end(data);
    });
  } catch (error) {
    sendJson(res, 500, { error: errMsg(error) });
  }
});
server.listen(PORT, () => console.log(`CLB360 V500 server running at http://localhost:${PORT}`));
