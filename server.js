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

  const siteId = process.env[`UNIFI_SITE_${unit}`] || '';
  const allSites = await fetchPaginated(`${SITE_BASE}/sites?pageSize=${PAGE_SIZE}`, key);
  const sites = siteId ? allSites.filter(s => (s.siteId || s.id) === siteId) : allSites;

  const results = await Promise.allSettled([
    fetchPaginated(`${SITE_BASE}/hosts?pageSize=${PAGE_SIZE}`, key),
    fetchJson(`${EA_BASE}/isp-metrics/1h?duration=30d`, key),
    fetchJson(`${EA_BASE}/isp-metrics/5m?duration=24h`, key),
    fetchPeplinkGps(unit)
  ]);

  const hosts = results[0].status === 'fulfilled' ? results[0].value : [];
  const peplinkGps = results[3].status === 'fulfilled' ? results[3].value : null;

  const raw1h = results[1].status === 'fulfilled' && Array.isArray(results[1].value.data) ? results[1].value.data : [];
  const raw5m = results[2].status === 'fulfilled' && Array.isArray(results[2].value.data) ? results[2].value.data : [];
  const ispMetrics1h = siteId ? raw1h.filter(m => m.siteId === siteId) : raw1h;
  const ispMetrics5m = siteId ? raw5m.filter(m => m.siteId === siteId) : raw5m;

  // Warn when no site filter is set and multiple sites are being summed — this is
  // the most common cause of inflated totals vs what the UniFi UI shows per-site.
  const uniqueSiteIds1h = new Set(ispMetrics1h.map(m => m.siteId).filter(Boolean));
  const uniqueSiteIds5m = new Set(ispMetrics5m.map(m => m.siteId).filter(Boolean));
  if (!siteId && (uniqueSiteIds1h.size > 1 || uniqueSiteIds5m.size > 1)) {
    const count = Math.max(uniqueSiteIds1h.size, uniqueSiteIds5m.size);
    console.warn(
      `[CLB360] Unit ${unit}: No UNIFI_SITE_${unit} env var set — summing ${count} site(s) worth of ISP metrics. ` +
      `Set UNIFI_SITE_${unit} to a specific siteId to match what the UniFi UI shows per site. ` +
      `Use /api/unit/${unit}/raw-metrics to inspect values.`
    );
  }

  // Flag whether any entries lack a siteId — these may be global aggregates that double-count.
  const noSiteEntries1h = ispMetrics1h.filter(m => !m.siteId).length;
  const noSiteEntries5m = ispMetrics5m.filter(m => !m.siteId).length;
  if (noSiteEntries1h > 0 || noSiteEntries5m > 0) {
    console.warn(
      `[CLB360] Unit ${unit}: ${noSiteEntries1h} 1h and ${noSiteEntries5m} 5m metric entries have no siteId — ` +
      `these may be global aggregates. They are excluded from site-filtered views but included when no site filter is set.`
    );
  }

  return {
    source: 'live',
    fetchedAt: new Date().toISOString(),
    sites,
    hosts,
    gps: peplinkGps || extractGps(hosts),
    ispMetrics1h,
    ispMetrics5m,
    siteCount: Math.max(uniqueSiteIds1h.size, uniqueSiteIds5m.size),
    errors: compact({
      hosts: results[0].status === 'rejected' ? errMsg(results[0].reason) : '',
      metrics1h: results[1].status === 'rejected' ? errMsg(results[1].reason) : '',
      metrics5m: results[2].status === 'rejected' ? errMsg(results[2].reason) : ''
    })
  };
}

// ─── Data-driven HTML Report ─────────────────────────────────────────────────

function processMetrics(bundle, range) {
  const use5m = range === '24h';
  const metrics = use5m ? bundle.ispMetrics5m : bundle.ispMetrics1h;
  const intervalSec = use5m ? 300 : 3600;
  const cutoffMs = range === '7d' ? 7 * 86400000 : range === '30d' ? 30 * 86400000 : 86400000;
  const cutoff = new Date(Date.now() - cutoffMs);

  const pointMap = new Map();
  for (const entry of (metrics || [])) {
    for (const period of (entry.periods || [])) {
      const t = period.metricTime || period.timestamp;
      if (!t || new Date(t) < cutoff) continue;
      const wan = ((period.data || {}).wan) || {};
      const key = new Date(t).toISOString();
      const b = pointMap.get(key) || { t: key, dk: 0, uk: 0, lat: 0, latc: 0, pl: 0, plc: 0, up: 0, upc: 0, dtime: 0, dtimec: 0 };
      b.dk += wan.download_kbps || 0;
      b.uk += wan.upload_kbps || 0;
      const lat = wan.avgLatency || 0;
      if (lat > 0) { b.lat += lat; b.latc++; }
      b.pl += wan.packetLoss || 0; b.plc++;
      if (wan.uptime !== undefined) { b.up += wan.uptime; b.upc++; }
      if (wan.downtime !== undefined) { b.dtime += wan.downtime || 0; b.dtimec++; }
      pointMap.set(key, b);
    }
  }

  const rawPoints = [...pointMap.values()]
    .sort((a, b) => new Date(a.t) - new Date(b.t))
    .map(p => ({
      date: p.t,
      downloadBytes: (p.dk * 1000 / 8) * intervalSec,
      uploadBytes: (p.uk * 1000 / 8) * intervalSec,
      latencyMs: p.latc ? p.lat / p.latc : 0,
      packetLoss: p.plc ? p.pl / p.plc : 0,
      uptimePct: p.upc ? p.up / p.upc : 100,
      downtimeSec: p.dtimec ? p.dtime / p.dtimec : 0,
    }));

  const bucketMap = new Map();
  for (const p of rawPoints) {
    const d = new Date(p.date);
    const key = use5m
      ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString()
      : d.toISOString().slice(0, 10);
    const b = bucketMap.get(key) || { date: key, dl: 0, ul: 0, lat: 0, latc: 0, pl: 0, plc: 0, up: 0, upc: 0, dtime: 0 };
    b.dl += p.downloadBytes; b.ul += p.uploadBytes;
    if (p.latencyMs > 0) { b.lat += p.latencyMs; b.latc++; }
    b.pl += p.packetLoss; b.plc++;
    b.up += p.uptimePct; b.upc++;
    b.dtime += p.downtimeSec;
    bucketMap.set(key, b);
  }

  const buckets = [...bucketMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map(b => ({
    date: b.date,
    downloadBytes: b.dl, uploadBytes: b.ul, totalBytes: b.dl + b.ul,
    latencyMs: b.latc ? b.lat / b.latc : 0,
    packetLoss: b.plc ? b.pl / b.plc : 0,
    uptimePct: b.upc ? b.up / b.upc : 100,
    downtimeMin: b.dtime / 60,
  }));

  const totalDl = rawPoints.reduce((s, p) => s + p.downloadBytes, 0);
  const totalUl = rawPoints.reduce((s, p) => s + p.uploadBytes, 0);
  const withLat = rawPoints.filter(p => p.latencyMs > 0);
  const avgLat = withLat.length ? withLat.reduce((s, p) => s + p.latencyMs, 0) / withLat.length : 0;
  const avgPl = rawPoints.length ? rawPoints.reduce((s, p) => s + p.packetLoss, 0) / rawPoints.length : 0;
  const avgUp = rawPoints.length ? rawPoints.reduce((s, p) => s + p.uptimePct, 0) / rawPoints.length : 99;
  const totalDowntimeMin = rawPoints.reduce((s, p) => s + p.downtimeSec, 0) / 60;

  return { totalDl, totalUl, avgLat, avgPl, avgUp, totalDowntimeMin, buckets };
}

function fmtBytes(b) {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
  if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3)  return `${(b / 1e3).toFixed(0)} KB`;
  return `${Math.round(b)} B`;
}
function fmtNum(n, d = 1) { return Number(n || 0).toFixed(d); }
function fmtPct(n, d = 1) { return `${Number(n || 0).toFixed(d)}%`; }
function fmtBucketDate(s, use5m) {
  const d = new Date(s);
  if (use5m) return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', hour12: true, timeZone: 'UTC' });
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

async function buildReportHtml(query) {
  const unit = query.unit || '003';
  const range = query.range || '30d';
  const client = query.client || '';
  const show = query.show || '';
  const use5m = range === '24h';

  const bundle = await buildBundle(unit);
  const { totalDl, totalUl, avgLat, avgPl, avgUp, totalDowntimeMin, buckets } = processMetrics(bundle, range);

  // Aggregate site stats across all sites for this unit
  const sites = bundle.sites || [];
  const totalDev = sites.reduce((s, site) => s + (((site.statistics || {}).counts || {}).totalDevice || 0), 0);
  const offlineDev = sites.reduce((s, site) => s + (((site.statistics || {}).counts || {}).offlineDevice || 0), 0);
  const onlineDev = totalDev - offlineDev;
  const activeClients = sites.reduce((s, site) => {
    const c = ((site.statistics || {}).counts || {});
    return s + (c.wifiClient || 0) + (c.wiredClient || 0);
  }, 0);

  // Pick the most descriptive site for ISP/gateway info
  const site = sites[0];
  const stats = (site && site.statistics) || {};
  const counts = stats.counts || {};
  const ispName = (stats.ispInfo && stats.ispInfo.name) || '—';
  const gwModel = (stats.gateway && stats.gateway.shortname) || '—';
  const externalIp = (stats.wans && stats.wans.WAN && stats.wans.WAN.externalIp) || '—';
  const wanUptime = (stats.percentages && stats.percentages.wanUptime) || null;
  const currentUptime = wanUptime !== null ? wanUptime : avgUp;
  const deviceHealthPct = totalDev > 0 ? (onlineDev / totalDev) * 100 : 100;
  const gps = bundle.gps || {};
  const location = gps.label || '—';
  const coords = gps.lat && gps.lng ? `${Number(gps.lat).toFixed(4)}, ${Number(gps.lng).toFixed(4)}` : '—';

  // Downtime formatted
  const dtH = Math.floor(totalDowntimeMin / 60);
  const dtM = Math.round(totalDowntimeMin % 60);
  const downtimeLabel = dtH > 0 ? `${dtH}h ${dtM}m` : totalDowntimeMin > 0 ? `${dtM}m` : 'None';

  const rangeLabel = range === '24h' ? 'Last 24 Hours' : range === '7d' ? 'Last 7 Days' : 'Last 30 Days';
  const generatedAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const title = show || client || `Unit ${unit}`;

  const uptimePctClass = currentUptime >= 99 ? 'good' : currentUptime >= 95 ? 'warn' : 'bad';
  const latClass = avgLat < 30 ? 'good' : avgLat < 80 ? 'warn' : 'bad';
  const plClass = avgPl < 1 ? 'good' : avgPl < 3 ? 'warn' : 'bad';
  const healthClass = deviceHealthPct >= 90 ? 'good' : deviceHealthPct >= 70 ? 'warn' : 'bad';

  const tableRows = buckets.map(b => {
    const upClass = b.uptimePct >= 99 ? 'good' : b.uptimePct >= 95 ? 'warn' : 'bad';
    const lClass = b.latencyMs > 0 ? (b.latencyMs < 30 ? 'good' : b.latencyMs < 80 ? 'warn' : 'bad') : '';
    const plRowClass = b.packetLoss < 1 ? 'good' : b.packetLoss < 3 ? 'warn' : 'bad';
    const dtMin = Math.round(b.downtimeMin);
    return `<tr>
      <td>${escHtml(fmtBucketDate(b.date, use5m))}</td>
      <td class="num">${fmtBytes(b.downloadBytes)}</td>
      <td class="num">${fmtBytes(b.uploadBytes)}</td>
      <td class="num"><strong>${fmtBytes(b.totalBytes)}</strong></td>
      <td class="num ${upClass}">${fmtPct(b.uptimePct, 1)}</td>
      <td class="num">${dtMin > 0 ? `${dtMin}m` : '<span style="color:#bbb">—</span>'}</td>
      <td class="num ${lClass}">${b.latencyMs > 0 ? `${fmtNum(b.latencyMs, 0)} ms` : '<span style="color:#bbb">—</span>'}</td>
      <td class="num ${plRowClass}">${fmtPct(b.packetLoss, 2)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLB360 Report – ${escHtml(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a2e;background:#fff;line-height:1.5}
.header{background:#0d0d1a;color:#fff;padding:28px 40px}
.header-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.logo{font-size:20px;font-weight:800;letter-spacing:2px;color:#ff5a36}
.logo span{color:#fff}
.report-label{font-size:12px;color:rgba(255,255,255,.5);margin-top:4px;text-transform:uppercase;letter-spacing:1px}
.meta{text-align:right;font-size:12px;color:rgba(255,255,255,.55);line-height:1.8}
.meta strong{color:#fff;font-size:13px}
.divider{border:none;border-top:1px solid rgba(255,255,255,.1);margin:20px 0}
.event-row{display:flex;flex-wrap:wrap;gap:32px;font-size:13px}
.event-item label{color:rgba(255,255,255,.5);margin-right:6px}
.event-item strong{color:#fff}
.content{padding:32px 40px;max-width:960px;margin:0 auto}
.section{margin-bottom:36px}
.section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#aaa;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #eee}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.kpi-card{border:1px solid #e8e8e8;border-radius:10px;padding:18px 20px}
.kpi-value{font-size:26px;font-weight:700;color:#0d0d1a;line-height:1.1}
.kpi-label{font-size:12px;color:#999;margin-top:5px;font-weight:500}
.kpi-sub{font-size:11px;color:#bbb;margin-top:3px}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 40px}
.detail-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f2f2f2;font-size:13px}
.detail-row:last-child{border-bottom:none}
.detail-label{color:#888}
.detail-value{font-weight:600;text-align:right}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{background:#f7f7f8;padding:9px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#888;border-bottom:2px solid #e8e8e8}
thead th.num{text-align:right}
tbody tr:nth-child(even){background:#fafafa}
tbody td{padding:8px 14px;border-bottom:1px solid #f0f0f0}
tbody tr:last-child td{border-bottom:none}
.num{text-align:right;font-variant-numeric:tabular-nums}
.good{color:#16a34a}
.warn{color:#d97706}
.bad{color:#dc2626}
.footer{background:#f7f7f8;border-top:1px solid #e8e8e8;padding:14px 40px;text-align:center;font-size:11px;color:#bbb;margin-top:40px}
@media print{
  .header{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-size:12px}
  .kpi-value{font-size:22px}
}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <div class="logo">CLB<span>360</span></div>
      <div class="report-label">Network Performance Report</div>
    </div>
    <div class="meta">
      <strong>${escHtml(title)}</strong><br>
      Unit ${escHtml(unit)} &nbsp;·&nbsp; ${escHtml(rangeLabel)}<br>
      Generated ${escHtml(generatedAt)}
    </div>
  </div>
  ${client || show ? `<hr class="divider"><div class="event-row">
    ${client ? `<div class="event-item"><label>Client</label><strong>${escHtml(client)}</strong></div>` : ''}
    ${show ? `<div class="event-item"><label>Show / Event</label><strong>${escHtml(show)}</strong></div>` : ''}
    <div class="event-item"><label>Range</label><strong>${escHtml(rangeLabel)}</strong></div>
  </div>` : ''}
</div>

<div class="content">
  <div class="section">
    <div class="section-title">Performance Summary</div>
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-value">${fmtBytes(totalDl + totalUl)}</div>
        <div class="kpi-label">Data Used</div>
        <div class="kpi-sub">${fmtBytes(totalDl)} down &nbsp;/&nbsp; ${fmtBytes(totalUl)} up</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value ${uptimePctClass}">${fmtPct(currentUptime, 1)}</div>
        <div class="kpi-label">WAN Uptime</div>
        <div class="kpi-sub">Downtime this period: ${escHtml(downtimeLabel)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${activeClients}</div>
        <div class="kpi-label">Active Clients</div>
        <div class="kpi-sub">${onlineDev} of ${totalDev} managed devices online</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value ${latClass}">${avgLat > 0 ? `${fmtNum(avgLat, 0)} ms` : '—'}</div>
        <div class="kpi-label">Avg Latency</div>
        <div class="kpi-sub">Round-trip time · ${escHtml(rangeLabel.toLowerCase())}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value ${plClass}">${fmtPct(avgPl, 2)}</div>
        <div class="kpi-label">Avg Packet Loss</div>
        <div class="kpi-sub">Lower is better · 0% is ideal</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value ${healthClass}">${fmtPct(deviceHealthPct, 0)}</div>
        <div class="kpi-label">Device Health</div>
        <div class="kpi-sub">${onlineDev} online / ${totalDev} managed</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Network Details</div>
    <div class="detail-grid">
      <div>
        <div class="detail-row"><span class="detail-label">ISP</span><span class="detail-value">${escHtml(ispName)}</span></div>
        <div class="detail-row"><span class="detail-label">Gateway Model</span><span class="detail-value">${escHtml(gwModel)}</span></div>
        <div class="detail-row"><span class="detail-label">External IP</span><span class="detail-value">${escHtml(externalIp)}</span></div>
      </div>
      <div>
        <div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">${escHtml(location)}</span></div>
        <div class="detail-row"><span class="detail-label">Coordinates</span><span class="detail-value">${escHtml(coords)}</span></div>
        <div class="detail-row"><span class="detail-label">GPS Source</span><span class="detail-value">${escHtml(gps.source === 'hardware' ? 'Hardware GPS' : 'IP Geolocation')}</span></div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">${use5m ? 'Hourly' : 'Daily'} Usage Breakdown</div>
    ${buckets.length === 0 ? '<p style="color:#aaa;font-size:13px">No data available for this period.</p>' : `
    <table>
      <thead><tr>
        <th>${use5m ? 'Hour' : 'Date'}</th>
        <th class="num">Download</th>
        <th class="num">Upload</th>
        <th class="num">Total</th>
        <th class="num">WAN Uptime</th>
        <th class="num">Downtime</th>
        <th class="num">Avg Latency</th>
        <th class="num">Packet Loss</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>`}
  </div>
</div>

<div class="footer">
  CLB360 V500 &nbsp;·&nbsp; Confidential &nbsp;·&nbsp; Generated ${escHtml(generatedAt)}
</div>
</body>
</html>`;
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

async function buildPreloadedHtml(query) {
  const unit = query.unit || '003';
  const bundle = await buildBundle(unit);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const preload = {
    unit,
    client: query.client || '',
    show: query.show || '',
    email: query.email || '',
    view: query.view || 'all',
    range: query.range || '24h',
    bundle
  };
  const safeJson = JSON.stringify(preload).replace(/<\/script>/gi, '<\\/script>');
  return html.replace('</body>', `<script>window.__CLB_DATA__=${safeJson};</script>\n</body>`);
}

async function renderPdf(query) {
  const tmp = path.join(os.tmpdir(), `clb360-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const params = new URLSearchParams({
    unit: query.unit || '003',
    range: query.range || '30d',
    client: query.client || '',
    show: query.show || '',
  });
  const page = `http://localhost:${PORT}/api/report/html?${params.toString()}`;
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
    : `http://localhost:${PORT}/api/render-page?unit=${encodeURIComponent(query.unit || '003')}&view=${encodeURIComponent(view)}&range=${encodeURIComponent(query.range || '24h')}&client=${encodeURIComponent(query.client || '')}&show=${encodeURIComponent(query.show || '')}&email=${encodeURIComponent(query.email || '')}`;
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

    // ── Diagnostic: inspect raw kbps values vs calculated bytes ──────────────
    const mRaw = url.pathname.match(/^\/api\/unit\/(001|002|003)\/raw-metrics$/);
    if (mRaw) {
      try {
        const bundle = await buildBundle(mRaw[1]);
        const summarise = (entries, intervalSec) => {
          const siteIds = new Set();
          let totalPeriods = 0;
          const samples = [];
          for (const entry of (entries || [])) {
            if (entry.siteId) siteIds.add(entry.siteId);
            for (const period of (entry.periods || [])) {
              totalPeriods++;
              const wan = ((period.data || {}).wan) || {};
              const dl = wan.download_kbps || 0;
              const ul = wan.upload_kbps || 0;
              if (samples.length < 5) {
                samples.push({
                  metricTime: period.metricTime || period.timestamp,
                  siteId: entry.siteId || null,
                  download_kbps: dl,
                  upload_kbps: ul,
                  // What the formula produces:
                  formula_dl_bytes: Math.round((dl * 1000 / 8) * intervalSec),
                  formula_ul_bytes: Math.round((ul * 1000 / 8) * intervalSec),
                  // Raw totals without interval multiply (in case kbps is actually "total kb"):
                  alt_dl_bytes: Math.round(dl * 1000 / 8),
                  alt_ul_bytes: Math.round(ul * 1000 / 8),
                });
              }
            }
          }
          return { siteCount: siteIds.size, siteIds: [...siteIds], totalPeriods, intervalSec, samples };
        };
        sendJson(res, 200, {
          unit: mRaw[1],
          fetchedAt: bundle.fetchedAt,
          errors: bundle.errors,
          metrics1h: summarise(bundle.ispMetrics1h, 3600),
          metrics5m: summarise(bundle.ispMetrics5m, 300),
          note: [
            'formula_*_bytes = (kbps * 1000/8) * intervalSec — used by the dashboard (assumes avg-kbps-over-period)',
            'alt_*_bytes    = kbps * 1000/8            — used if kbps is actually total-kb-for-period',
            'Compare formula_dl_bytes vs UniFi UI for the same period to confirm which is correct.',
            'If siteCount > 1 without UNIFI_SITE_xxx set, all sites are being summed (expected for multi-site).',
          ]
        });
      } catch (error) { sendJson(res, 502, { error: errMsg(error) }); }
      return;
    }

    if (url.pathname === '/api/render-page') {
      try {
        const html = await buildPreloadedHtml(Object.fromEntries(url.searchParams.entries()));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (error) {
        sendJson(res, 500, { error: errMsg(error) });
      }
      return;
    }

    if (url.pathname === '/api/report/html') {
      try {
        const html = await buildReportHtml(Object.fromEntries(url.searchParams.entries()));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (error) {
        sendJson(res, 500, { error: errMsg(error) });
      }
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
