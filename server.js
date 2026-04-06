try { require('dotenv').config(); } catch (_) {}

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
const PEPLINK_API = 'https://api.ic.peplink.com';
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

// Unifi API keys — read from env, fall back to defaults
const UNIT_KEYS = {
  '001': process.env.UNIFI_KEY_001 || 'WOncXsXoJ9ivvnTfn7BifjyuoZ-OHqTH',
  '002': process.env.UNIFI_KEY_002 || '_SbNK1htk4T21EFp-aCaJAKhA7zqKQqU',
  '003': process.env.UNIFI_KEY_003 || 'ZNGBD-tcy7l3jvdjWTTdwGg7v9rlymJP'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip'
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendJson(res, code, payload) { send(res, code, JSON.stringify(payload), 'application/json; charset=utf-8'); }
function errMsg(error) { return error && error.message ? error.message : String(error || 'Unknown error'); }
function compact(obj) { return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v)); }

function apiHeaders(token) {
  return { Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-API-Key': token, 'api-key': token };
}

function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(target, { method: 'GET', headers: apiHeaders(token), timeout: 18000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim()));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const buf = Buffer.from(body, 'utf8');
    const req = https.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': buf.length,
        Accept: 'application/json'
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function fetchPaginated(url, token) {
  const items = [];
  let next = '';
  for (let i = 0; i < 20; i += 1) {
    const target = new URL(url);
    if (next) target.searchParams.set('nextToken', next);
    const json = await fetchJson(target.toString(), token);
    items.push(...(Array.isArray(json.data) ? json.data : []));
    next = json.nextToken || '';
    if (!next) break;
  }
  return items;
}

// ─── Peplink InControl2 GPS ──────────────────────────────────────────────────

const peplinkTokenCache = { value: null, expiresAt: 0 };

async function getPeplinkToken() {
  if (peplinkTokenCache.value && Date.now() < peplinkTokenCache.expiresAt - 300000) {
    return peplinkTokenCache.value;
  }
  const clientId = process.env.PEPLINK_CLIENT_ID;
  const clientSecret = process.env.PEPLINK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const data = await postForm(`${PEPLINK_API}/api/oauth2/token`, body);
  if (!data.access_token) throw new Error('Peplink: token response missing access_token');
  peplinkTokenCache.value = data.access_token;
  peplinkTokenCache.expiresAt = Date.now() + (data.expires_in || 172800) * 1000;
  return peplinkTokenCache.value;
}

async function fetchPeplinkGps(unit) {
  const orgId = process.env.PEPLINK_ORG_ID;
  const deviceId = process.env[`PEPLINK_DEVICE_${unit}`];
  if (!orgId || !deviceId) return null;

  const token = await getPeplinkToken();
  if (!token) return null;

  const data = await fetchJson(
    `${PEPLINK_API}/rest/o/${encodeURIComponent(orgId)}/d/${encodeURIComponent(deviceId)}?has_status=true`,
    token
  );

  const lat = typeof data.latitude === 'number' ? data.latitude : null;
  const lng = typeof data.longitude === 'number' ? data.longitude : null;
  if (lat === null || lng === null) return null;

  // Convert m/s → mph (cloud API may not return speed; local device API does)
  const speedMph = typeof data.speed === 'number' ? Math.round(data.speed * 2.23694 * 10) / 10 : 0;
  // hdop (horizontal dilution of precision) → approximate accuracy in feet (hdop × 16.4 ft)
  const accuracyFt = typeof data.hdop === 'number' ? Math.round(data.hdop * 16.4) : 0;

  return {
    lat,
    lng,
    label: data.address || data.name || '',
    speed: speedMph,
    heading: typeof data.heading === 'number' ? data.heading : (typeof data.course === 'number' ? data.course : 0),
    accuracy: accuracyFt,
    altitude: typeof data.altitude === 'number' ? data.altitude : 0,
    timestamp: data.location_timestamp || new Date().toISOString(),
    source: data.gps_exist ? 'hardware' : 'ip'
  };
}

// ─── Unifi GPS fallback (IP-based from host reportedState) ───────────────────

function extractGps(hosts) {
  for (const h of (hosts || [])) {
    const loc = h.reportedState && h.reportedState.location;
    if (loc && typeof loc.lat === 'number' && (typeof loc.long === 'number' || typeof loc.lng === 'number')) {
      return {
        lat: loc.lat,
        lng: loc.lng !== undefined ? loc.lng : loc.long,
        label: loc.text || loc.label || '',
        radius: typeof loc.radius === 'number' ? loc.radius : 0,
        speed: 0,
        heading: 0,
        accuracy: typeof loc.radius === 'number' ? loc.radius : 0,
        altitude: 0,
        source: 'ip'
      };
    }
  }
  return null;
}

// ─── Bundle ──────────────────────────────────────────────────────────────────

async function buildBundle(unit) {
  const key = UNIT_KEYS[unit];
  if (!key) throw new Error(`Unknown unit ${unit}`);

  const sites = await fetchPaginated(`${SITE_BASE}/sites?pageSize=${PAGE_SIZE}`, key);
  const results = await Promise.allSettled([
    fetchPaginated(`${SITE_BASE}/hosts?pageSize=${PAGE_SIZE}`, key),
    fetchJson(`${EA_BASE}/isp-metrics/1h?duration=30d`, key),
    fetchJson(`${EA_BASE}/isp-metrics/5m?duration=24h`, key),
    fetchPeplinkGps(unit)
  ]);

  const hosts = results[0].status === 'fulfilled' ? results[0].value : [];
  const peplinkGps = results[3].status === 'fulfilled' ? results[3].value : null;

  return {
    source: 'live',
    fetchedAt: new Date().toISOString(),
    sites,
    hosts,
    gps: peplinkGps || extractGps(hosts),
    ispMetrics1h: results[1].status === 'fulfilled' && Array.isArray(results[1].value.data) ? results[1].value.data : [],
    ispMetrics5m: results[2].status === 'fulfilled' && Array.isArray(results[2].value.data) ? results[2].value.data : [],
    errors: compact({
      hosts: results[0].status === 'rejected' ? errMsg(results[0].reason) : '',
      metrics1h: results[1].status === 'rejected' ? errMsg(results[1].reason) : '',
      metrics5m: results[2].status === 'rejected' ? errMsg(results[2].reason) : ''
    })
  };
}

// ─── Chrome / PDF / PNG ──────────────────────────────────────────────────────

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

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, at: new Date().toISOString() });
      return;
    }

    if (url.pathname === '/api/config') {
      sendJson(res, 200, { mapsKey: process.env.GOOGLE_MAPS_KEY || '' });
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
